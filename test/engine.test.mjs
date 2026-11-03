import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyncEngine } from '../engine.mjs';

const NOW = '2026-11-03T10:00:00.000Z';

function manifestOf(bundles, { updatedAt = '2026-11-03T09:00:00.000Z', updatedBy = 'other' } = {}) {
	return JSON.stringify({ formatVersion: 1, bundles, updatedAt, updatedBy });
}

function row(name, source, enabled, extra = {}) {
	return { name, source, enabled, availability: 'profile', installed: true, ...extra };
}

function makeFakeGit({ remote = null, baseline = null } = {}) {
	const state = { remote, baselines: { 'baseline.json': baseline }, commits: [], pushResults: ['pushed'] };
	return {
		state,
		async ensureWorkspace() { state.ensured = true; },
		async readRemote() { state.reads = (state.reads ?? 0) + 1; return state.remote; },
		async commitPush(text, message) {
			state.commits.push({ text, message });
			const result = state.pushResults.shift() ?? 'pushed';
			if (result === 'pushed') state.remote = text;
			return result;
		},
		async readLocal(path) { return state.baselines[path] ?? null; },
		async writeLocal(path, text) { state.baselines[path] = text; },
	};
}

function makeFakePm(rows) {
	const calls = [];
	return {
		calls,
		async listBundles() { return rows; },
		async installBundle(spec) { calls.push(['installBundle', spec]); return { ok: true }; },
		async removeBundle(name) { calls.push(['removeBundle', name]); return { ok: true }; },
		async setBundleEnabled(name, enabled) { calls.push(['setBundleEnabled', name, enabled]); return { ok: true }; },
	};
}

function makeIo() {
	const files = {};
	return {
		files,
		async readJson(path) { return files[path] ?? null; },
		async writeJson(path, obj) { files[path] = obj; },
	};
}

function makeEngine({ rows = [], remote = null, baseline = null, pushResults } = {}) {
	const git = makeFakeGit({ remote, baseline });
	if (pushResults) git.state.pushResults = pushResults;
	const pm = makeFakePm(rows);
	const io = makeIo();
	const logs = [];
	const engine = createSyncEngine({
		git, pm, io,
		log: (level, msg) => logs.push([level, msg]),
		machineName: 'machine-me',
		now: () => NOW,
	});
	return { engine, git, pm, io, logs };
}

// --- pull -------------------------------------------------------------------

test('pull installs a bundle that only exists on the remote', async () => {
	const remote = manifestOf([
		row('one', 's1', true),
		{ name: 'two', source: 'github:x/two', enabled: true },
	]);
	const { engine, pm } = makeEngine({
		rows: [row('one', 's1', true)],
		remote,
		baseline: manifestOf([row('one', 's1', true)]),
	});
	const outcome = await engine.pull();
	assert.equal(outcome.action, 'converged');
	assert.ok(outcome.applied.includes('two'));
	assert.deepEqual(pm.calls.filter(c => c[0] === 'installBundle'), [['installBundle', 'github:x/two']]);
});

test('pull treats pluginManager ChangeResult failures as errors and keeps the baseline', async () => {
	const baseline = manifestOf([row('one', 's1', true)]);
	const remote = manifestOf([row('one', 's1', true), row('nope', 'github:x/nope', true)]);
	const { engine, pm, git, io } = makeEngine({
		rows: [row('one', 's1', true)],
		remote,
		baseline,
	});
	pm.installBundle = async (spec) => {
		pm.calls.push(['installBundle', spec]);
		return { changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'invalid-spec', diagnostic: 'spec refused' } };
	};
	const outcome = await engine.pull();
	assert.equal(outcome.action, 'error');
	assert.match(outcome.errors[0], /invalid-spec/);
	assert.equal(git.state.baselines['baseline.json'], baseline);
	assert.equal(io.files['state.json'], undefined);
});

test('pull removes a bundle the remote no longer declares', async () => {
	const remote = manifestOf([row('one', 's1', true)]);
	const { engine, pm } = makeEngine({
		rows: [row('one', 's1', true), row('stale', 's2', true)],
		remote,
		baseline: manifestOf([row('one', 's1', true), row('stale', 's2', true)]),
	});
	const outcome = await engine.pull();
	assert.equal(outcome.action, 'converged');
	assert.deepEqual(pm.calls.filter(c => c[0] === 'removeBundle'), [['removeBundle', 'stale']]);
});

test('pull applies enable and disable for enabled-state drift', async () => {
	const remote = manifestOf([row('on-me', 's1', true), row('off-me', 's2', false)]);
	const { engine, pm } = makeEngine({
		rows: [row('on-me', 's1', false), row('off-me', 's2', true)],
		remote,
		baseline: manifestOf([row('on-me', 's1', false), row('off-me', 's2', true)]),
	});
	const outcome = await engine.pull();
	assert.equal(outcome.action, 'converged');
	assert.deepEqual(pm.calls.filter(c => c[0] === 'setBundleEnabled').sort(), [
		['setBundleEnabled', 'off-me', false],
		['setBundleEnabled', 'on-me', true],
	]);
});

test('pull against an empty remote with local bundles awaits empty confirm without touching pm', async () => {
	const { engine, pm } = makeEngine({
		rows: [row('one', 's1', true)],
		remote: manifestOf([]),
		baseline: manifestOf([row('one', 's1', true)]),
	});
	const outcome = await engine.pull();
	assert.equal(outcome.action, 'await-empty-confirm');
	assert.deepEqual(pm.calls, []);
});

test('confirmEmpty lets the next pull converge onto the empty remote', async () => {
	const { engine, pm } = makeEngine({
		rows: [row('one', 's1', true)],
		remote: manifestOf([]),
		baseline: manifestOf([row('one', 's1', true)]),
	});
	const outcome = await engine.confirmEmpty();
	assert.equal(outcome.action, 'converged');
	assert.deepEqual(pm.calls.filter(c => c[0] === 'removeBundle'), [['removeBundle', 'one']]);
	// one-shot: a later shrink needs confirming again
	const again = makeEngine({
		rows: [row('one', 's1', true)],
		remote: manifestOf([]),
		baseline: manifestOf([row('one', 's1', true)]),
	});
	assert.equal((await again.engine.pull()).action, 'await-empty-confirm');
});

test('pull with invalid remote JSON reports error without touching pm', async () => {
	const { engine, pm } = makeEngine({
		rows: [row('one', 's1', true)],
		remote: '{ not json',
		baseline: manifestOf([row('one', 's1', true)]),
	});
	const outcome = await engine.pull();
	assert.equal(outcome.action, 'error');
	assert.ok(outcome.errors.length > 0);
	assert.deepEqual(pm.calls, []);
});

test('pull installs a fresh remote bundle and immediately disables it when remote says off', async () => {
	const remote = manifestOf([row('quiet', 'github:x/quiet', false)]);
	const { engine, pm } = makeEngine({
		rows: [],
		remote,
		baseline: manifestOf([]),
	});
	const outcome = await engine.pull();
	assert.equal(outcome.action, 'converged');
	assert.deepEqual(pm.calls, [
		['installBundle', 'github:x/quiet'],
		['setBundleEnabled', 'quiet', false],
	]);
});

test('pull with same-name different-source reinstalls: remove first, then install', async () => {
	const remote = manifestOf([row('respec', 'new-spec', true)]);
	const { engine, pm } = makeEngine({
		rows: [row('respec', 'old-spec', true)],
		remote,
		baseline: manifestOf([row('respec', 'old-spec', true)]),
	});
	const outcome = await engine.pull();
	assert.equal(outcome.action, 'converged');
	const actions = pm.calls.filter(c => ['installBundle', 'removeBundle', 'setBundleEnabled'].includes(c[0]));
	assert.deepEqual(actions, [['removeBundle', 'respec'], ['installBundle', 'new-spec']]);
});

test('pull before any bootstrap with a mismatching remote awaits a mode choice', async () => {
	const remote = manifestOf([row('remote-only', 's9', true)]);
	const { engine, pm } = makeEngine({ rows: [row('local-only', 's1', true)], remote, baseline: null });
	const outcome = await engine.pull();
	assert.equal(outcome.action, 'await-choose');
	assert.ok(outcome.remoteState);
	assert.deepEqual(pm.calls, []);
});

// --- push -------------------------------------------------------------------

test('push replays the local intent diff onto the remote and rewrites the baseline', async () => {
	const remoteText = manifestOf([row('one', 's1', true)]);
	const baselineText = manifestOf([row('one', 's1', true)]);
	const { engine, git } = makeEngine({
		rows: [row('one', 's1', true), row('added', 's2', true)],
		remote: remoteText,
		baseline: baselineText,
	});
	const outcome = await engine.push();
	assert.equal(outcome.action, 'pushed');
	assert.equal(git.state.commits.length, 1);
	const committed = JSON.parse(git.state.commits[0].text);
	assert.deepEqual(committed.bundles, [
		{ name: 'one', source: 's1', enabled: true },
		{ name: 'added', source: 's2', enabled: true },
	]);
	assert.equal(committed.updatedBy, 'machine-me');
	assert.equal(committed.updatedAt, NOW);
	assert.equal(git.state.baselines['baseline.json'], git.state.commits[0].text);
});

test('push rejected then accepted replays the diff onto the newest remote text', async () => {
	const staleRemote = manifestOf([row('one', 's1', true)]);
	const newestRemote = manifestOf([row('one', 's1', true), row('from-other', 's8', true)]);
	const baselineText = manifestOf([row('one', 's1', true)]);
	const { engine, git } = makeEngine({
		rows: [row('one', 's1', false), row('added', 's2', true)],
		remote: staleRemote,
		baseline: baselineText,
		pushResults: ['rejected', 'pushed'],
	});
	// the remote advances after the first read: the engine must refetch on rejection
	let reads = 0;
	git.readRemote = async () => {
		reads += 1;
		return reads === 1 ? staleRemote : newestRemote;
	};
	const outcome = await engine.push();
	assert.equal(outcome.action, 'pushed');
	assert.equal(reads, 2, 'rejection must trigger a fresh fetch');
	assert.equal(git.state.commits.length, 2);
	const first = JSON.parse(git.state.commits[0].text);
	assert.ok(!first.bundles.some(b => b.name === 'from-other'), 'first attempt was based on the stale remote');
	const second = JSON.parse(git.state.commits[1].text);
	assert.deepEqual(second.bundles, [
		{ name: 'one', source: 's1', enabled: false },
		{ name: 'from-other', source: 's8', enabled: true },
		{ name: 'added', source: 's2', enabled: true },
	]);
});

test('push with no change against baseline is a nochange and commits nothing', async () => {
	const baselineText = manifestOf([row('one', 's1', true)]);
	const { engine, git } = makeEngine({
		rows: [row('one', 's1', true)],
		remote: manifestOf([row('one', 's1', true)]),
		baseline: baselineText,
	});
	const outcome = await engine.push();
	assert.equal(outcome.action, 'nochange');
	assert.equal(git.state.commits.length, 0);
});

// --- bootstrap ---------------------------------------------------------------

test('bootstrap seeds an empty remote from local state', async () => {
	const { engine, git } = makeEngine({
		rows: [row('one', 's1', true), row('two', 's2', false)],
		remote: null,
		baseline: null,
	});
	const outcome = await engine.bootstrap('remote');
	assert.equal(outcome.action, 'bootstrapped');
	assert.equal(git.state.commits.length, 1);
	const seeded = JSON.parse(git.state.commits[0].text);
	assert.deepEqual(seeded.bundles, [
		{ name: 'one', source: 's1', enabled: true },
		{ name: 'two', source: 's2', enabled: false },
	]);
	assert.equal(git.state.baselines['baseline.json'], git.state.commits[0].text);
});

test('bootstrap without a mode against a mismatching remote awaits the choice', async () => {
	const { engine } = makeEngine({
		rows: [row('local-only', 's1', true)],
		remote: manifestOf([row('remote-only', 's9', true)]),
		baseline: null,
	});
	const outcome = await engine.bootstrap();
	assert.equal(outcome.action, 'await-choose');
	assert.deepEqual(outcome.remoteState.bundles, [{ name: 'remote-only', source: 's9', enabled: true }]);
});

test('bootstrap mode merge pushes the union and records it as baseline', async () => {
	const remote = manifestOf([row('remote-only', 's9', true), row('both', 'from-remote', true)]);
	const { engine, git, pm } = makeEngine({
		rows: [row('local-only', 's1', true), row('both', 'from-local', false)],
		remote,
		baseline: null,
	});
	const outcome = await engine.bootstrap('merge');
	assert.equal(outcome.action, 'bootstrapped');
	assert.deepEqual(pm.calls, []);
	const pushed = JSON.parse(git.state.commits[0].text);
	assert.deepEqual(pushed.bundles, [
		{ name: 'remote-only', source: 's9', enabled: true },
		{ name: 'both', source: 'from-local', enabled: false },
		{ name: 'local-only', source: 's1', enabled: true },
	]);
	assert.equal(git.state.baselines['baseline.json'], git.state.commits[0].text);
});

test('bootstrap mode remote converges local onto the existing remote', async () => {
	const remote = manifestOf([row('remote-only', 's9', true)]);
	const { engine, pm } = makeEngine({
		rows: [row('local-only', 's1', true)],
		remote,
		baseline: null,
	});
	const outcome = await engine.bootstrap('remote');
	assert.equal(outcome.action, 'converged');
	assert.deepEqual(pm.calls.filter(c => ['installBundle', 'removeBundle'].includes(c[0])), [
		['installBundle', 's9'],
		['removeBundle', 'local-only'],
	]);
});
