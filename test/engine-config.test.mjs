import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyncEngine } from '../engine.mjs';

const NOW = '2026-11-04T10:00:00.000Z';

function row(name, source, enabled = true) {
	return { name, source, enabled, availability: 'profile', installed: true, version: '1.0.0', removable: true };
}

function makeEngine({ rows, remoteText, configRows, configEditor, selfName = 'dsh-plugin-sync' }) {
	const edits = [];
	const pushed = [];
	const git = {
		async ensureWorkspace() {},
		async readRemote() { return remoteText ?? null; },
		async commitPush(text) { pushed.push(text); return 'pushed'; },
		// A baseline equal to the remote text: the cycle is a converged steady
		// state, which is the only path where config is applied or pushed.
		async readLocal(rel) { return rel === 'baseline.json' ? (remoteText ?? null) : null; },
		async writeLocal() {},
	};
	const pm = {
		async listBundles() { return rows; },
		async installBundle(spec) { return { ok: true }; },
		async removeBundle(name) { return { ok: true }; },
		async setBundleEnabled(name, enabled) { return { ok: true }; },
	};
	const files = {};
	const io = {
		async readJson(path) { return files[path] ?? null; },
		async writeJson(path, obj) { files[path] = obj; },
	};
	const editor = configEditor === undefined ? {
		async configuration() { return configRows ?? []; },
		async edit(entry, change) { edits.push({ id: entry.options.id, next: change({}) }); return { ok: true }; },
	} : configEditor;
	const logs = [];
	const engine = createSyncEngine({
		git, pm, io, log: (level, msg) => logs.push([level, msg]), machineName: 'me', now: () => NOW, selfName,
		...(editor ? { configEditor: editor } : {}),
	});
	return { engine, edits, pushed, logs, files };
}

function manifest(bundles) {
	return JSON.stringify({ formatVersion: 1, bundles, updatedAt: '2026-11-04T09:00:00.000Z', updatedBy: 'other' });
}

const LOCAL = [row('dsh-plugin-sync', 'github:x/dsh-plugin-sync'), row('ui', 'ui@^1.0.0')];

test('a whitelisted config whose value differs is written once, with a log line', async () => {
	const { engine, edits, logs } = makeEngine({
		rows: LOCAL,
		remoteText: manifest([{ name: 'ui', source: 'ui@^1.0.0', enabled: true, config: { locale: 'zh', density: 'compact' } }]),
		configRows: [{ entry: { options: { id: 'ui', name: 'ui' } }, inherited: { locale: 'en' }, override: { locale: 'en' } }],
	});
	await engine.pull();
	assert.deepEqual(edits, [{ id: 'ui', next: { locale: 'zh', density: 'compact' } }]);
	assert.ok(logs.some(([, msg]) => msg.includes('ui') && msg.includes('locale')));
});

test('an already matching config writes nothing', async () => {
	const { engine, edits } = makeEngine({
		rows: LOCAL,
		remoteText: manifest([{ name: 'ui', source: 'ui@^1.0.0', enabled: true, config: { locale: 'zh' } }]),
		configRows: [{ entry: { options: { id: 'ui', name: 'ui' } }, inherited: { locale: 'zh' }, override: {} }],
	});
	await engine.pull();
	assert.deepEqual(edits, []);
});

test('our own config is edited last, other plugins first', async () => {
	const { engine, edits } = makeEngine({
		rows: LOCAL,
		remoteText: manifest([
			{ name: 'dsh-plugin-sync', source: 'github:x/dsh-plugin-sync', enabled: true, config: { updatePolicy: 'check' } },
			{ name: 'ui', source: 'ui@^1.0.0', enabled: true, config: { locale: 'zh' } },
		]),
		configRows: [
			{ entry: { options: { id: 'dsh-plugin-sync', name: 'dsh-plugin-sync' } }, inherited: {}, override: {} },
			{ entry: { options: { id: 'ui', name: 'ui' } }, inherited: {}, override: {} },
		],
	});
	await engine.pull();
	assert.deepEqual(edits.map(e => e.id), ['ui', 'dsh-plugin-sync']);
});

test('a manifest without config never reads the host configuration', async () => {
	let called = 0;
	const { engine, edits } = makeEngine({
		rows: LOCAL,
		remoteText: manifest([{ name: 'ui', source: 'ui@^1.0.0', enabled: true }]),
		configEditor: {
			async configuration() { called += 1; return []; },
			async edit() { edits.push('edit'); return { ok: true }; },
		},
	});
	await engine.pull();
	await engine.push();
	assert.equal(called, 0, 'no whitelist means no config work at all');
	assert.deepEqual(edits, []);
});

test('a local override for a whitelisted key is pushed into the manifest', async () => {
	const { engine, pushed } = makeEngine({
		rows: LOCAL,
		remoteText: manifest([{ name: 'ui', source: 'ui@^1.0.0', enabled: true, config: { locale: 'zh' } }]),
		configRows: [{ entry: { options: { id: 'ui', name: 'ui' } }, inherited: { locale: 'en' }, override: { locale: 'en', unrelated: 'x' } }],
	});
	const result = await engine.push();
	assert.equal(result.action, 'pushed', 'a config-only change is a real push');
	assert.ok(result.applied.includes('ui'), result.applied.join(','));
	const text = pushed[0];
	assert.ok(text.includes('"config"'), text);
	const written = JSON.parse(text);
	assert.deepEqual(written.bundles.find(b => b.name === 'ui').config, { locale: 'en' }, 'only the whitelisted key, not `unrelated`');
});

test('a push that rebuilds an entry keeps that entry whitelist intact', async () => {
	const { engine, pushed } = makeEngine({
		rows: [row('ui', 'ui@^2.0.0')],
		remoteText: manifest([{ name: 'ui', source: 'ui@^1.0.0', enabled: true, config: { locale: 'zh' } }]),
		configRows: [{ entry: { options: { id: 'ui', name: 'ui' } }, inherited: { locale: 'zh' }, override: { locale: 'zh' } }],
	});
	await engine.push();
	const written = JSON.parse(pushed[0]);
	assert.deepEqual(written.bundles.find(b => b.name === 'ui'), { name: 'ui', source: 'ui@^2.0.0', enabled: true, config: { locale: 'zh' } });
});

test('a plugin whose config write failed is not pushed back this cycle', async () => {
	const { engine, pushed } = makeEngine({
		rows: [row('ui', 'ui@^1.0.0')],
		remoteText: manifest([{ name: 'ui', source: 'ui@^1.0.0', enabled: true, config: { locale: 'zh' } }]),
		configEditor: {
			async configuration() {
				return [{ entry: { options: { id: 'ui', name: 'ui' } }, inherited: { locale: 'en' }, override: { locale: 'en' } }];
			},
			// The host refuses: this entry is overridden by a home patch or a
			// command-line overlay, so the profile cannot set it.
			async edit() { throw new Error('Configuration for "ui" is overridden by a home patch or command-line overlay'); },
		},
	});
	const pulled = await engine.pull();
	assert.match(pulled.errors.join(' '), /overridden by a home patch/);
	const pushedResult = await engine.push();
	assert.equal(pushedResult.action, 'nochange', 'a plugin we could not configure must not rewrite the shared manifest');
	assert.equal(pushed.length, 0, pushed.join(','));
});

test('without a configEditor the sync behaves exactly as before', async () => {	const { engine, pushed } = makeEngine({
		rows: LOCAL,
		remoteText: manifest([{ name: 'ui', source: 'ui@^1.0.0', enabled: true, config: { locale: 'zh' } }]),
		configEditor: null,
	});
	const result = await engine.pull();
	assert.deepEqual(result.errors, []);
	assert.equal(pushed.length, 0);
});
