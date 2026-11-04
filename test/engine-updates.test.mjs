import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyncEngine } from '../engine.mjs';

const NOW = '2026-11-04T10:00:00.000Z';
const LATER = '2026-11-04T11:00:00.000Z';

function manifestOf(bundles) {
	return JSON.stringify({ formatVersion: 1, bundles, updatedAt: '2026-11-04T09:00:00.000Z', updatedBy: 'other' });
}

function row(name, source, version) {
	return { name, source, enabled: true, availability: 'profile', installed: true, version, removable: true };
}

function makeEngine({ rows, remote, updatePolicy, registry, now = () => NOW, selfName, pmResults } = {}) {
	const calls = [];
	const git = {
		async ensureWorkspace() {},
		async readRemote() { return remote ?? manifestOf(rows.map(r => ({ name: r.name, source: r.source, enabled: true }))); },
		async commitPush(text) { return 'pushed'; },
		async readLocal() { return null; },
		async writeLocal() {},
	};
	const pm = {
		async listBundles() { return rows; },
		async installBundle(spec) { calls.push(['installBundle', spec]); return pmResults?.install ?? { ok: true }; },
		async removeBundle(name) { calls.push(['removeBundle', name]); return pmResults?.remove ?? { ok: true }; },
		async setBundleEnabled(name, enabled) { calls.push(['setBundleEnabled', name, enabled]); return { ok: true }; },
	};
	const files = {};
	const io = {
		async readJson(path) { return files[path] ?? null; },
		async writeJson(path, obj) { files[path] = obj; },
	};
	const logs = [];
	const asked = [];
	const checkRegistry = async names => {
		asked.push(names);
		return registry ? registry(names) : { ok: [], failed: [] };
	};
	const engine = createSyncEngine({
		git, pm, io, log: (level, msg) => logs.push([level, msg]), machineName: 'me', now, selfName,
		...(updatePolicy ? { updatePolicy } : {}),
		checkRegistry,
	});
	return { engine, calls, files, logs, asked };
}

const newer = () => ({ ok: [{ name: 'mgr', latest: '1.2.29' }], failed: [] });

test('updatePolicy off never asks the registry', async () => {
	const { engine, asked, calls } = makeEngine({ rows: [row('mgr', 'mgr@^1.2.24', '1.2.26')], registry: newer });
	await engine.pull();
	assert.deepEqual(asked, []);
	assert.deepEqual(calls, []);
});

test('check policy reports an available update without touching pluginManager', async () => {
	const { engine, calls } = makeEngine({
		rows: [row('mgr', 'mgr@^1.2.24', '1.2.26')],
		updatePolicy: 'check',
		registry: newer,
	});
	const result = await engine.pull();
	assert.deepEqual(calls, [], 'no remove+install in check policy');
	assert.deepEqual(result.updates, [{ name: 'mgr', from: '1.2.26', to: '1.2.29', spec: 'mgr@^1.2.24' }]);
});

test('auto policy removes and reinstalls the newer bundle', async () => {
	const { engine, calls, logs } = makeEngine({
		rows: [row('mgr', 'mgr@^1.2.24', '1.2.26')],
		updatePolicy: 'auto',
		registry: newer,
	});
	const result = await engine.pull();
	assert.deepEqual(calls, [['removeBundle', 'mgr'], ['installBundle', 'mgr@^1.2.24']]);
	assert.deepEqual(result.errors, []);
	assert.ok(logs.some(([, msg]) => msg.includes('mgr') && msg.includes('1.2.29')), 'the update is logged');
});

test('auto policy never updates the sync bundle itself', async () => {
	const { engine, calls } = makeEngine({
		rows: [row('dsh-plugin-sync', 'dsh-plugin-sync@^0.1.0', '0.1.0')],
		updatePolicy: 'auto',
		selfName: 'dsh-plugin-sync',
		registry: () => ({ ok: [{ name: 'dsh-plugin-sync', latest: '0.9.0' }], failed: [] }),
	});
	await engine.pull();
	assert.deepEqual(calls, []);
});

test('the registry is asked at most once a day unless asked explicitly', async () => {
	let clock = NOW;
	const { engine, asked } = makeEngine({
		rows: [row('mgr', 'mgr@^1.2.24', '1.2.26')],
		updatePolicy: 'auto',
		registry: newer,
		now: () => clock,
	});
	await engine.pull();
	await engine.pull();
	assert.equal(asked.length, 1, 'the second pull is inside the 24h window');
	clock = '2026-11-05T10:00:01.000Z';
	await engine.pull();
	assert.equal(asked.length, 2, 'a day later it asks again');
});

test('a freshly applied update is not retried while the registry lags behind', async () => {
	let clock = NOW;
	const { engine, calls, asked } = makeEngine({
		rows: [row('mgr', 'mgr@^1.2.24', '1.2.26')],
		updatePolicy: 'auto',
		registry: newer,
		now: () => clock,
	});
	await engine.pull();
	clock = '2026-11-05T10:00:01.000Z';
	await engine.pull();
	assert.deepEqual(asked.length, 2, 'the check ran again');
	assert.equal(calls.length, 2, 'but the same update is not applied twice in a row');
});

test('checkUpdates(force) and applyUpdates(names) drive the manual path', async () => {
	const { engine, calls } = makeEngine({
		rows: [row('mgr', 'mgr@^1.2.24', '1.2.26'), row('other', 'other@^1.0.0', '1.0.0')],
		registry: () => ({
			ok: [{ name: 'mgr', latest: '1.2.29' }, { name: 'other', latest: '1.1.0' }],
			failed: [],
		}),
	});
	const checked = await engine.checkUpdates();
	assert.deepEqual(checked.updates.map(u => u.name), ['mgr', 'other']);
	assert.deepEqual(calls, [], 'checking mutates nothing');
	const applied = await engine.applyUpdates(['mgr']);
	assert.deepEqual(applied.applied, ['mgr']);
	assert.deepEqual(calls, [['removeBundle', 'mgr'], ['installBundle', 'mgr@^1.2.24']]);
});

test('a failed removal stops that update and is reported', async () => {
	const { engine, calls } = makeEngine({
		rows: [row('mgr', 'mgr@^1.2.24', '1.2.26')],
		updatePolicy: 'auto',
		registry: newer,
		pmResults: { remove: { ok: false, error: { code: 'not-removable' } } },
	});
	const result = await engine.pull();
	assert.deepEqual(calls, [['removeBundle', 'mgr']], 'no install after a failed removal');
	assert.match(result.errors.join('\n'), /not-removable/);
});
