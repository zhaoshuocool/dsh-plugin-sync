import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine } from '../engine.mjs';

test('a rejected config push replays whitelisted intent over concurrent remote config changes', async () => {
	const manifest = config => JSON.stringify({ formatVersion: 1, updatedAt: '2026-11-04T03:00:00.000Z', updatedBy: 'other', bundles: [{ name: 'ui', source: 'ui@1.0.0', enabled: true, config }] });
	const original = manifest({ locale: 'zh', density: 'compact' });
	const latest = manifest({ locale: 'zh', density: 'roomy' });
	let reads = 0;
	const pushed = [];
	const engine = createSyncEngine({
		git: {
			async ensureWorkspace() {},
			async readRemote() { return ++reads === 1 ? original : latest; },
			async readLocal() { return original; },
			async writeLocal() {},
			async commitPush(text) { pushed.push(text); return pushed.length === 1 ? 'rejected' : 'pushed'; },
		},
		pm: { async listBundles() { return [{ name: 'ui', source: 'ui@1.0.0', enabled: true, installed: true, availability: 'profile' }]; } },
		io: { async readJson() { return null; }, async writeJson() {} },
		configEditor: {
			async configuration() { return [{ entry: { options: { name: 'ui', id: 'ui' } }, inherited: {}, override: { locale: 'en', density: 'compact' } }]; },
			async edit() {},
		},
		log() {}, machineName: 'me', now: () => '2026-11-04T04:00:00.000Z',
	});
	const result = await engine.push();
	assert.equal(result.action, 'pushed');
	assert.equal(pushed.length, 2);
	assert.deepEqual(JSON.parse(pushed[1]).bundles[0].config, { locale: 'en', density: 'roomy' });
});
