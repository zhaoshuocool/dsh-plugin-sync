import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
	normalizeManifest,
	parseManifestJson,
	bundlesFromList,
	computeDiff,
	applyDiff,
	remoteWins,
	mergeUnion,
	planConvergence,
	isShrinkingToEmpty,
	repoHashDir,
	PHASES,
	getStatus,
	setStatus,
	logStatus,
} from '../core.mjs';

const validManifest = () => ({
	formatVersion: 1,
	bundles: [
		{ name: '@a/one', source: 'github:x/one', enabled: true },
		{ name: '@b/two', source: '^1.2.3', enabled: false },
	],
	updatedAt: '2026-11-03T08:30:00.000Z',
	updatedBy: 'machine-a',
});

// --- npm spec drift ----------------------------------------------------------
// An npm `source` is a spec, and the resolver rewrites it: installing
// `mgr@^1.2.24` records `mgr@^1.2.26` once that is the newest match. Both accept
// the installed version, so string equality there is not a source change — it
// makes every machine remove and reinstall the same bundle on every cycle.

test('planConvergence does not reinstall on an npm range drift within a major', () => {
	const local = [{ name: 'mgr', source: 'mgr@^1.2.26', enabled: true }];
	const remote = { formatVersion: 1, bundles: [{ name: 'mgr', source: 'mgr@^1.2.24', enabled: true }] };
	assert.deepEqual(
		planConvergence(local, remote),
		{ install: [], remove: [], enable: [], disable: [], reinstall: [] },
	);
});

test('planConvergence reinstalls across an npm major range change', () => {
	const local = [{ name: 'mgr', source: 'mgr@^1.2.26', enabled: true }];
	const remote = { formatVersion: 1, bundles: [{ name: 'mgr', source: 'mgr@^2.0.0', enabled: true }] };
	assert.deepEqual(planConvergence(local, remote).reinstall, [{ name: 'mgr', source: 'mgr@^2.0.0' }]);
});

test('planConvergence treats an exact npm pin as exact', () => {
	const local = [{ name: 'mgr', source: 'mgr@1.2.26', enabled: true }];
	const remote = { formatVersion: 1, bundles: [{ name: 'mgr', source: 'mgr@1.2.24', enabled: true }] };
	assert.deepEqual(planConvergence(local, remote).reinstall, [{ name: 'mgr', source: 'mgr@1.2.24' }]);
});

test('a scoped npm range drift is drift-free too', () => {
	const local = [{ name: '@scope/mgr', source: '@scope/mgr@^1.2.26', enabled: true }];
	const remote = { formatVersion: 1, bundles: [{ name: '@scope/mgr', source: '@scope/mgr@^1.2.24', enabled: true }] };
	assert.deepEqual(planConvergence(local, remote).reinstall, []);
});

test('computeDiff sees no local change from an npm range drift', () => {
	const baseline = [{ name: 'mgr', source: 'mgr@^1.2.24', enabled: true }];
	const local = [{ name: 'mgr', source: 'mgr@^1.2.26', enabled: true }];
	assert.deepEqual(computeDiff(baseline, local), { added: [], removed: [], changed: [] });
});

test('a deliberate major upgrade converges once and then settles', () => {
	// machine A installed `pkg@^2.0.0` and pushed it; machine B still has 1.x.
	const behind = [{ name: 'pkg', source: 'pkg@^1.2.26', enabled: true }];
	const upgraded = { formatVersion: 1, bundles: [{ name: 'pkg', source: 'pkg@^2.0.0', enabled: true }] };
	assert.deepEqual(planConvergence(behind, upgraded).reinstall, [{ name: 'pkg', source: 'pkg@^2.0.0' }]);
	// After that reinstall the resolver records what it installed — same major as
	// the manifest now says, so the next cycle must be quiet.
	const settled = [{ name: 'pkg', source: 'pkg@^2.3.1', enabled: true }];
	assert.deepEqual(planConvergence(settled, upgraded).reinstall, []);
});

test('an exact pin converges once and then settles against the recorded caret', () => {
	const behind = [{ name: 'pkg', source: 'pkg@^1.2.26', enabled: true }];
	const pinned = { formatVersion: 1, bundles: [{ name: 'pkg', source: 'pkg@2.3.1', enabled: true }] };
	assert.deepEqual(planConvergence(behind, pinned).reinstall, [{ name: 'pkg', source: 'pkg@2.3.1' }]);
	// pluginManager records a caret for what it installed, never the bare pin:
	// comparing those two strings forever is the churn this rule must avoid.
	const settled = [{ name: 'pkg', source: 'pkg@^2.3.1', enabled: true }];
	assert.deepEqual(planConvergence(settled, pinned).reinstall, []);
});

test('a floating npm spec is compared by package name only', () => {
	// `latest`, `next`, `*` and `>=…` can never equal the resolver's own recorded
	// caret, so string comparison there means reinstalling on every cycle.
	for (const range of ['latest', 'next', '*', '>=1.2.24', '1.x - 2', '']) {
		const local = [{ name: 'pkg', source: 'pkg@^1.2.26', enabled: true }];
		const remote = { formatVersion: 1, bundles: [{ name: 'pkg', source: `pkg@${range}`, enabled: true }] };
		assert.deepEqual(planConvergence(local, remote).reinstall, [], `pkg@${range}`);
	}
});

test('non-npm transports keep exact comparison', () => {
	const local = [{ name: 'w', source: 'github:me/whale', enabled: true }];
	const remote = { formatVersion: 1, bundles: [{ name: 'w', source: 'github:other/whale', enabled: true }] };
	assert.deepEqual(planConvergence(local, remote).reinstall, [{ name: 'w', source: 'github:other/whale' }]);
	const localPath = [{ name: 'w', source: 'link:E:\\a', enabled: true }];
	const remotePath = { formatVersion: 1, bundles: [{ name: 'w', source: 'link:E:/a', enabled: true }] };
	assert.deepEqual(planConvergence(localPath, remotePath).reinstall, [{ name: 'w', source: 'link:E:/a' }]);
});

// --- normalizeManifest -------------------------------------------------------

test('normalizeManifest rejects formatVersion other than 1', () => {
	for (const v of [2, 0, '1', null, undefined]) {
		const raw = { ...validManifest(), formatVersion: v };
		const result = normalizeManifest(raw);
		assert.equal(result.ok, false, `formatVersion=${String(v)} should be rejected`);
		assert.equal(typeof result.error, 'string');
	}
});

test('normalizeManifest rejects missing or non-array bundles', () => {
	const missing = normalizeManifest({ formatVersion: 1, updatedAt: 'x', updatedBy: 'y' });
	assert.equal(missing.ok, false);
	const notArray = normalizeManifest({ formatVersion: 1, bundles: {}, updatedAt: 'x', updatedBy: 'y' });
	assert.equal(notArray.ok, false);
});

test('normalizeManifest rejects entries without a usable name', () => {
	for (const bad of [{ source: 'x' }, { name: '' }, { name: 42 }, 'a string', null]) {
		const result = normalizeManifest({ formatVersion: 1, bundles: [bad], updatedAt: 'x', updatedBy: 'y' });
		assert.equal(result.ok, false, `entry ${JSON.stringify(bad)} should be rejected`);
	}
});

test('normalizeManifest rejects missing updatedAt or updatedBy', () => {
	const noStamp = { formatVersion: 1, bundles: [], updatedBy: 'y' };
	assert.equal(normalizeManifest(noStamp).ok, false);
	const noBy = { formatVersion: 1, bundles: [], updatedAt: 'x' };
	assert.equal(normalizeManifest(noBy).ok, false);
});

test('normalizeManifest accepts a valid document and drops extra entry fields', () => {
	const raw = validManifest();
	raw.bundles[0].junk = 'delete-me';
	raw.bundles[1].nested = { a: 1 };
	raw.bundles[1].enabled = undefined;
	const result = normalizeManifest(raw);
	assert.equal(result.ok, true, `unexpected error: ${result.ok ? '' : result.error}`);
	assert.deepEqual(result.manifest.bundles[0], { name: '@a/one', source: 'github:x/one', enabled: true });
	assert.deepEqual(result.manifest.bundles[1], { name: '@b/two', source: '^1.2.3', enabled: null });
	assert.equal(result.manifest.updatedAt, '2026-11-03T08:30:00.000Z');
	assert.equal(result.manifest.updatedBy, 'machine-a');
});

// --- parseManifestJson -------------------------------------------------------

test('parseManifestJson rejects invalid JSON without throwing', () => {
	const result = parseManifestJson('not json {');
	assert.equal(result.ok, false);
	assert.equal(typeof result.error, 'string');
});

test('parseManifestJson parses then normalizes valid text', () => {
	const result = parseManifestJson(JSON.stringify(validManifest()));
	assert.equal(result.ok, true);
	assert.deepEqual(result.manifest.bundles, validManifest().bundles);
});

// --- bundlesFromList ---------------------------------------------------------

test('bundlesFromList excludes installation-layer entries without source', () => {
	const list = [
		{ name: 'dsh-base', availability: 'installation', installed: false, source: undefined, enabled: true },
		{ name: 'third', availability: 'profile', installed: true, source: '^1.0.0', enabled: true },
	];
	const entries = bundlesFromList(list);
	assert.deepEqual(entries, [{ name: 'third', source: '^1.0.0', enabled: true }]);
});

test('bundlesFromList includes declared entries and source-carrying uninstalled entries', () => {
	// T4 self-reference case: the plugin row itself is listed installed:false
	// with a source — it still belongs in the manifest.
	const list = [
		{ name: 'dsh-plugin-sync', availability: 'profile', installed: false, source: 'github:me/sync', enabled: true },
		{ name: 'declared-no-source', availability: 'profile', installed: true, source: undefined, enabled: false },
	];
	const entries = bundlesFromList(list);
	assert.deepEqual(entries, [
		{ name: 'dsh-plugin-sync', source: 'github:me/sync', enabled: true },
		{ name: 'declared-no-source', source: null, enabled: false },
	]);
});

// --- computeDiff -------------------------------------------------------------

test('computeDiff reports added removed and changed against baseline', () => {
	const baseline = [
		{ name: 'keep', source: 's1', enabled: true },
		{ name: 'drop', source: 's2', enabled: true },
		{ name: 'flip', source: 's3', enabled: true },
		{ name: 'respec', source: 's4', enabled: true },
	];
	const local = [
		{ name: 'keep', source: 's1', enabled: true },
		{ name: 'flip', source: 's3', enabled: false },
		{ name: 'respec', source: 's4-new', enabled: true },
		{ name: 'new', source: 's5', enabled: null },
	];
	const diff = computeDiff(baseline, local);
	assert.deepEqual(diff.added, [{ name: 'new', source: 's5', enabled: null }]);
	assert.deepEqual(diff.removed, ['drop']);
	assert.deepEqual(diff.changed, [
		{ name: 'flip', source: 's3', enabled: false },
		{ name: 'respec', source: 's4-new', enabled: true },
	]);
});

test('computeDiff is empty when nothing changed', () => {
	const entries = [{ name: 'a', source: 's', enabled: true }];
	const diff = computeDiff(entries, entries.map(e => ({ ...e })));
	assert.deepEqual(diff, { added: [], removed: [], changed: [] });
});

// --- applyDiff ---------------------------------------------------------------

test('applyDiff upserts added and changed, deletes removed, bumps stamps', () => {
	const manifest = validManifest();
	const diff = {
		added: [{ name: '@c/new', source: 'github:x/new', enabled: true }],
		removed: ['@b/two'],
		changed: [{ name: '@a/one', source: 'github:x/one', enabled: false }],
	};
	const next = applyDiff(manifest, diff, 'machine-b', '2026-11-03T09:00:00.000Z');
	assert.deepEqual(next.bundles, [
		{ name: '@a/one', source: 'github:x/one', enabled: false },
		{ name: '@c/new', source: 'github:x/new', enabled: true },
	]);
	assert.equal(next.updatedAt, '2026-11-03T09:00:00.000Z');
	assert.equal(next.updatedBy, 'machine-b');
	assert.notEqual(next, manifest, 'applyDiff must not mutate its input');
});

// --- remoteWins --------------------------------------------------------------

test('remoteWins produces the diff that converges local onto remote', () => {
	const local = [
		{ name: 'stay', source: 's1', enabled: true },
		{ name: 'local-only', source: 's2', enabled: true },
		{ name: 'flip', source: 's3', enabled: true },
	];
	const remote = { ...validManifest(), bundles: [
		{ name: 'stay', source: 's1', enabled: true },
		{ name: 'flip', source: 's3', enabled: false },
		{ name: 'remote-only', source: 's9', enabled: true },
	] };
	const diff = remoteWins(local, remote);
	assert.deepEqual(diff.added, [{ name: 'remote-only', source: 's9', enabled: true }]);
	assert.deepEqual(diff.removed, ['local-only']);
	assert.deepEqual(diff.changed, [{ name: 'flip', source: 's3', enabled: false }]);
});

// --- mergeUnion --------------------------------------------------------------

test('mergeUnion keeps disjoint entries and lets b win same-name conflicts', () => {
	const a = { formatVersion: 1, bundles: [
		{ name: 'only-a', source: 'sa', enabled: true },
		{ name: 'both', source: 'from-a', enabled: true },
	], updatedAt: '2026-11-03T08:00:00.000Z', updatedBy: 'a' };
	const b = { formatVersion: 1, bundles: [
		{ name: 'only-b', source: 'sb', enabled: false },
		{ name: 'both', source: 'from-b', enabled: false },
	], updatedAt: '2026-11-03T07:00:00.000Z', updatedBy: 'b' };
	const merged = mergeUnion(a, b, 'machine-c', '2026-11-03T10:00:00.000Z');
	const both = merged.bundles.find(e => e.name === 'both');
	assert.deepEqual(both, { name: 'both', source: 'from-b', enabled: false });
	assert.deepEqual(merged.bundles.map(e => e.name).sort(), ['both', 'only-a', 'only-b']);
	assert.equal(merged.updatedAt, '2026-11-03T10:00:00.000Z');
	assert.equal(merged.updatedBy, 'machine-c');
});

// --- planConvergence ---------------------------------------------------------

test('planConvergence plans install remove enable disable and reinstall', () => {
	const local = [
		{ name: 'same', source: 's1', enabled: true },
		{ name: 'off-me', source: 's2', enabled: true },
		{ name: 'on-me', source: 's3', enabled: false },
		{ name: 'respec', source: 'old', enabled: true },
		{ name: 'gone-remote', source: 's4', enabled: true },
	];
	const remote = { formatVersion: 1, bundles: [
		{ name: 'same', source: 's1', enabled: true },
		{ name: 'off-me', source: 's2', enabled: false },
		{ name: 'on-me', source: 's3', enabled: true },
		{ name: 'respec', source: 'new', enabled: true },
		{ name: 'fresh', source: 's5', enabled: true },
	], updatedAt: 'x', updatedBy: 'y' };
	const plan = planConvergence(local, remote);
	assert.deepEqual(plan.install, [{ name: 'fresh', source: 's5' }]);
	assert.deepEqual(plan.remove, ['gone-remote']);
	assert.deepEqual(plan.enable, ['on-me']);
	assert.deepEqual(plan.disable, ['off-me']);
	assert.deepEqual(plan.reinstall, [{ name: 'respec', source: 'new' }]);
});

test('planConvergence skips install for source-less remote entries', () => {
	const plan = planConvergence([], { formatVersion: 1, bundles: [
		{ name: 'in-box', source: null, enabled: true },
	], updatedAt: 'x', updatedBy: 'y' });
	assert.deepEqual(plan.install, []);
	assert.deepEqual(plan.remove, []);
	assert.deepEqual(plan.reinstall, []);
});

test('planConvergence on empty remote plans removal of every source-carrying local entry', () => {
	const plan = planConvergence(
		[{ name: 'x', source: 's', enabled: true }],
		{ formatVersion: 1, bundles: [], updatedAt: 'x', updatedBy: 'y' },
	);
	assert.deepEqual(plan.remove, ['x']);
	assert.deepEqual(plan.install, []);
});

test('planConvergence with selfName never installs, removes, or reinstalls the sync bundle itself', () => {
	const local = [
		{ name: 'dsh-plugin-sync', source: 'link:E:\\a', enabled: true },
		{ name: 'gone-remote', source: 's4', enabled: true },
	];
	const remote = { formatVersion: 1, bundles: [
		// the same bundle under a different source form: drift would reinstall
		{ name: 'dsh-plugin-sync', source: 'link:E:/a', enabled: true },
	], updatedAt: 'x', updatedBy: 'y' };
	const plan = planConvergence(local, remote, { selfName: 'dsh-plugin-sync' });
	assert.deepEqual(plan.reinstall, [], 'self source drift is not an action');
	assert.deepEqual(plan.remove, ['gone-remote'], 'only the other bundle is removed');
	assert.deepEqual(plan.install, []);
	// self absent locally, present remotely: no self install either
	const plan2 = planConvergence([], { formatVersion: 1, bundles: [
		{ name: 'dsh-plugin-sync', source: 's', enabled: true },
		{ name: 'y', source: 's2', enabled: true },
	], updatedAt: 'x', updatedBy: 'y' }, { selfName: 'dsh-plugin-sync' });
	assert.deepEqual(plan2.install, [{ name: 'y', source: 's2' }]);
	// enable/disable of self stay planned: they do not nest HMR transactions
	const plan3 = planConvergence(
		[{ name: 'dsh-plugin-sync', source: 's', enabled: true }],
		{ formatVersion: 1, bundles: [{ name: 'dsh-plugin-sync', source: 's', enabled: false }], updatedAt: 'x', updatedBy: 'y' },
		{ selfName: 'dsh-plugin-sync' },
	);
	assert.deepEqual(plan3.disable, ['dsh-plugin-sync']);
	// without the option the old behaviour stands
	const plan4 = planConvergence(local, remote);
	assert.deepEqual(plan4.reinstall, [{ name: 'dsh-plugin-sync', source: 'link:E:/a' }]);
});

// --- isShrinkingToEmpty ------------------------------------------------------

test('isShrinkingToEmpty is true only for local>0 against empty remote', () => {
	assert.equal(isShrinkingToEmpty(3, []), true);
	assert.equal(isShrinkingToEmpty(0, []), false);
	assert.equal(isShrinkingToEmpty(0, [{ name: 'a', source: 's', enabled: true }]), false);
	assert.equal(isShrinkingToEmpty(2, [{ name: 'a', source: 's', enabled: true }]), false);
});

// --- repoHashDir ---------------------------------------------------------------

test('repoHashDir is home/plugin-sync/<sha256(repo) first 16 hex chars>', () => {
	const repo = 'git@github.com:me/private-sync.git';
	const hash = createHash('sha256').update(repo).digest('hex').slice(0, 16);
	assert.equal(repoHashDir('/home/u/.dsh', repo), join('/home/u/.dsh', 'plugin-sync', hash));
	const hash2 = createHash('sha256').update('git@github.com:me/other.git').digest('hex').slice(0, 16);
	assert.notEqual(repoHashDir('/home/u/.dsh', 'git@github.com:me/other.git'), repoHashDir('/home/u/.dsh', repo));
	void hash2;
});

// --- status singleton --------------------------------------------------------

test('getStatus exposes documented defaults and setStatus merges a patch', () => {
	const initial = getStatus();
	assert.deepEqual(PHASES, ['disabled', 'await-choose', 'await-empty-confirm', 'idle', 'syncing', 'error']);
	assert.ok(PHASES.includes(initial.phase));
	assert.equal(initial.lastPullAt, null);
	assert.equal(initial.lastPushAt, null);
	assert.equal(initial.error, null);
	assert.ok(Array.isArray(initial.log));

	setStatus({ phase: 'idle', lastPullAt: '2026-11-03T09:00:00.000Z', error: null });
	const after = getStatus();
	assert.equal(after.phase, 'idle');
	assert.equal(after.lastPullAt, '2026-11-03T09:00:00.000Z');

	setStatus({ phase: 'bogus-phase' });
	assert.equal(getStatus().phase, 'idle', 'unknown phase values are ignored');
});

test('setStatus accepts the UI-facing fields and getStatus echoes them', () => {
	setStatus({
		phase: 'await-choose',
		repo: 'https://github.com/me/private.git',
		branch: 'main',
		machineName: 'desk-1',
		intervalMs: 300000,
		remoteState: { bundles: [{ name: 'x', source: 's', enabled: true }], updatedAt: '2026-11-03T09:00:00.000Z', updatedBy: 'laptop-2' },
	});
	const status = getStatus();
	assert.equal(status.repo, 'https://github.com/me/private.git');
	assert.equal(status.branch, 'main');
	assert.equal(status.machineName, 'desk-1');
	assert.equal(status.intervalMs, 300000);
	assert.deepEqual(status.remoteState.bundles, [{ name: 'x', source: 's', enabled: true }]);
	setStatus({ remoteState: null, repo: null });
	assert.equal(getStatus().remoteState, null);
	assert.equal(getStatus().repo, null);
	setStatus({ totallyUnknownField: 'x' });
	assert.equal('totallyUnknownField' in getStatus(), false, 'unknown fields stay out of the snapshot');
});

test('logStatus appends entries and the log ring drops oldest past 200', () => {
	const before = getStatus().log.length;
	for (let i = 0; i < 205; i++) logStatus('info', `msg-${i}`);
	const after = getStatus().log;
	assert.equal(after.length, Math.min(200, before + 205));
	const kept = after.slice(after.length - Math.min(200, before + 205));
	assert.equal(kept.at(-1).msg, 'msg-204');
	assert.equal(kept.at(-1).level, 'info');
	assert.equal(typeof kept.at(-1).at, 'string');
	if (after.length === 200) {
		assert.ok(!after.some(e => e.msg === 'msg-0') || before >= 200, 'oldest entries dropped');
	}
});
