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
