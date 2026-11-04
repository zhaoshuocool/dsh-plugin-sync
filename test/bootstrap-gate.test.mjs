import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine } from '../engine.mjs';
import { createScheduler } from '../index.js';

const remote = JSON.stringify({ formatVersion: 1, updatedAt: '2026-11-04T00:00:00.000Z', updatedBy: 'other', bundles: [{ name: 'remote-only', source: 'remote-only@^1.0.0', enabled: true }] });

test('watcher push cannot bypass the first-sync mode choice', async () => {
	const writes = [];
	const commits = [];
	const engine = createSyncEngine({
		git: { async ensureWorkspace() {}, async readRemote() { return remote; }, async readLocal() { return null; }, async writeLocal(...args) { writes.push(args); }, async commitPush(...args) { commits.push(args); return 'pushed'; } },
		pm: { async listBundles() { return [{ name: 'local-only', source: 'local-only@^1.0.0', enabled: true, availability: 'profile', installed: true }]; } },
		io: { async readJson() { return null; }, async writeJson() {} },
		machineName: 'new-machine', log() {}, now: () => '2026-11-04T00:00:00.000Z',
	});
	assert.equal((await engine.pull()).action, 'await-choose');
	assert.equal((await engine.push()).action, 'await-choose');
	assert.equal(commits.length, 0);
	assert.equal(writes.length, 0);
});

for (const action of ['await-choose', 'await-empty-confirm', 'error']) {
	test(`manual sync preserves ${action} rather than overwriting it with a push`, async () => {
		let pushes = 0;
		const scheduler = createScheduler({ pull: async () => ({ action }), push: async () => { pushes++; }, timers: {}, intervalMs: 300000 });
		await scheduler.runNow();
		assert.equal(pushes, 0);
	});
}
