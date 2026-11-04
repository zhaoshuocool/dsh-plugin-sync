import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, getEngine, getScheduler } from '../index.js';
import { getStatus } from '../core.mjs';

/**
 * A cordis-shaped fake context: every injected service is a stub with the
 * pinned contract shape. `effect` runs the body immediately and remembers its
 * disposer, like a live fiber would.
 */
function fakeCtx() {
	const routes = [];
	const timers = [];
	const watches = [];
	const ctx = {
		routes,
		timers,
		watches,
		effect(fn) {
			const dispose = fn();
			ctx.disposers.push(typeof dispose === 'function' ? dispose : () => {});
			return { dispose: () => {} };
		},
		disposers: [],
		logger: () => () => {},
		pluginManager: { listBundles: async () => [] },
		fs: {
			resolve: async (p) => ({ path: p }),
			processPath: (p) => p,
			watch: async (target) => {
				watches.push(target);
				return () => {};
			},
		},
		subprocess: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
		webServer: {
			register(route) {
				routes.push(route);
				return () => { route.unregistered = true; };
			},
		},
		timer: {
			timeout(fn, ms) { timers.push({ kind: 'timeout', ms }); return () => {}; },
			interval(fn, ms) { timers.push({ kind: 'interval', ms }); return () => {}; },
		},
		connection: { requestRejection: () => undefined },
		configEditor: { entries: () => [], edit: async () => {} },
	};
	return ctx;
}

async function callStatusRoute(ctx) {
	const route = ctx.routes.find(r => r.path === '/api/plugin-sync/status');
	const res = { status: 0, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
	await route.handler({ method: 'GET', headers: {} }, res);
	return { status: res.status, body: JSON.parse(res.body) };
}

test('apply without a repo runs disabled but still serves the status route', async () => {
	const ctx = fakeCtx();
	apply(ctx, {});
	assert.equal(getStatus().phase, 'disabled');
	assert.equal(getEngine(), null, 'no engine when the repo is unset');
	const paths = ctx.routes.map(r => r.path);
	assert.deepEqual(paths, [
		'/api/plugin-sync/status',
		'/api/plugin-sync/run',
		'/api/plugin-sync/bootstrap',
		'/api/plugin-sync/confirm-empty',
		'/api/plugin-sync/check-updates',
		'/api/plugin-sync/update',
		'/api/plugin-sync/config',
	]);
	const response = await callStatusRoute(ctx);
	assert.equal(response.status, 200);
	assert.equal(response.body.phase, 'disabled');
	assert.equal(getScheduler(), null);
	for (const dispose of ctx.disposers) dispose();
	assert.ok(ctx.routes.every(r => r.unregistered), 'disposal unregisters the routes');
});

test('apply with a repo wires engine, scheduler, watch and the boot timer', async () => {
	const ctx = fakeCtx();
	apply(ctx, { repo: 'C:/sync/plugin-sync-origin' });
	await new Promise(resolve => setImmediate(resolve));
	const status = getStatus();
	assert.equal(status.phase, 'idle');
	assert.equal(status.repo, 'C:/sync/plugin-sync-origin');
	assert.equal(status.branch, 'main');
	assert.equal(status.intervalMs, 300000);
	assert.ok(getEngine() !== null && typeof getEngine().pull === 'function');
	assert.ok(getScheduler() !== null && typeof getScheduler().runNow === 'function');
	// The scheduler registers a 15s boot pull on the timer service (the pull
	// interval starts after that first pull — see schedule tests); the two
	// profile manifest files get watched.
	const started = ctx.timers.find(t => t.kind === 'timeout' && t.ms === 15000);
	assert.ok(started, 'boot delay is registered');
	assert.equal(ctx.watches.length, 2, 'both profile manifest files are watched');
	assert.match(String(ctx.watches[0].path), /package\.json$/);
	assert.match(String(ctx.watches[1].path), /cordis\.patch\.yml$/);
	for (const dispose of ctx.disposers) dispose();
	assert.equal(getEngine(), null, 'disposal clears the module accessors');
	assert.equal(getScheduler(), null);
});
