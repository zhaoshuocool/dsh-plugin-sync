import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { registerRoutes } from '../index.js';
import { getStatus, setStatus } from '../core.mjs';

const BASE = '/api/plugin-sync';

function fakeWeb() {
	const routes = [];
	return {
		routes,
		register(route) {
			routes.push(route);
			route.unregistered = false;
			return () => { route.unregistered = true; };
		},
		find(path) {
			return routes.find(r => r.path === path);
		},
	};
}

function fakeConnection(rejection) {
	return { requestRejection: () => rejection };
}

function makeRes() {
	return {
		status: 0,
		headers: null,
		body: null,
		writeHead(status, headers) { this.status = status; this.headers = headers; },
		end(body) { this.body = body; },
		json() { return this.body === null ? undefined : JSON.parse(this.body); },
	};
}

function makeReq({ method = 'GET', path = '/', body, headers = { origin: 'http://127.0.0.1:3468' } } = {}) {
	const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
	return Object.assign(stream, { method, url: path, headers });
}

async function call(route, req) {
	const res = makeRes();
	await route.handler(req, res);
	return res;
}

function setup({ rejection, scheduler, engine } = {}) {
	const web = fakeWeb();
	const disposers = registerRoutes(web, fakeConnection(rejection), {
		getStatus,
		getScheduler: () => scheduler ?? null,
		getEngine: () => engine ?? null,
	});
	return { web, disposers };
}

test('registers the four exact routes under /api/plugin-sync', () => {
	const { web } = setup();
	assert.deepEqual(
		web.routes.map(r => [r.kind, r.path]),
		[
			['exact', `${BASE}/status`],
			['exact', `${BASE}/run`],
			['exact', `${BASE}/bootstrap`],
			['exact', `${BASE}/confirm-empty`],
		],
	);
});

test('GET status returns the live status JSON including remoteState summary', async () => {
	const { web } = setup();
	setStatus({ phase: 'await-choose', repo: 'https://github.com/me/x.git', remoteState: { bundles: [{ name: 'x', source: 's', enabled: true }], updatedAt: 't', updatedBy: 'u' } });
	const res = await call(web.find(`${BASE}/status`), makeReq());
	assert.equal(res.status, 200);
	const body = res.json();
	assert.equal(body.phase, 'await-choose');
	assert.equal(body.repo, 'https://github.com/me/x.git');
	assert.deepEqual(body.remoteState.bundles, [{ name: 'x', source: 's', enabled: true }]);
	setStatus({ phase: 'disabled', repo: null, remoteState: null });
	const res2 = await call(web.find(`${BASE}/status`), makeReq());
	assert.equal(res2.json().phase, 'disabled');
});

test('untrusted requests are rejected with the connection status before any handler runs', async () => {
	const { web } = setup({ rejection: 403 });
	const res = await call(web.find(`${BASE}/status`), makeReq());
	assert.equal(res.status, 403);
});

test('POST run triggers the scheduler and reports started', async () => {
	let started = 0;
	const { web } = setup({ scheduler: { runNow() { started += 1; } } });
	const res = await call(web.find(`${BASE}/run`), makeReq({ method: 'POST' }));
	assert.equal(res.status, 200);
	assert.equal(res.json().started, true);
	assert.equal(started, 1);
});

test('POST run without an active scheduler reports 503', async () => {
	const { web } = setup();
	const res = await call(web.find(`${BASE}/run`), makeReq({ method: 'POST' }));
	assert.equal(res.status, 503);
});

test('GET on a POST-only route returns 405', async () => {
	const { web } = setup({ scheduler: { runNow() {} } });
	const res = await call(web.find(`${BASE}/run`), makeReq());
	assert.equal(res.status, 405);
});

test('POST bootstrap with an invalid mode returns 4xx and never touches the engine', async () => {
	let engineCalls = 0;
	const { web } = setup({ engine: { async bootstrap() { engineCalls += 1; return { action: 'converged', applied: [], errors: [] }; } } });
	const res = await call(web.find(`${BASE}/bootstrap`), makeReq({ method: 'POST', body: { mode: 'local-wins' } }));
	assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
	assert.equal(engineCalls, 0);
});

test('POST bootstrap merge awaits the engine and returns its outcome', async () => {
	const outcome = { action: 'bootstrapped', applied: ['a', 'b'], errors: [] };
	const seen = [];
	const { web } = setup({ engine: { async bootstrap(mode) { seen.push(mode); return outcome; } } });
	const res = await call(web.find(`${BASE}/bootstrap`), makeReq({ method: 'POST', body: { mode: 'merge' } }));
	assert.deepEqual(seen, ['merge']);
	assert.equal(res.status, 200);
	assert.equal(res.json().ok, true);
	assert.deepEqual(res.json().outcome.applied, ['a', 'b']);
});

test('POST confirm-empty runs engine.confirmEmpty once', async () => {
	let calls = 0;
	const { web } = setup({ engine: { async confirmEmpty() { calls += 1; return { action: 'converged', applied: [], errors: [] }; } } });
	const res = await call(web.find(`${BASE}/confirm-empty`), makeReq({ method: 'POST' }));
	assert.equal(res.status, 200);
	assert.equal(calls, 1);
});

test('invalid JSON bodies return 400 and disposers unregister every route', async () => {
	const { web, disposers } = setup();
	const route = web.find(`${BASE}/bootstrap`);
	const badReq = Object.assign(Readable.from([Buffer.from('{oops')]), { method: 'POST', url: '/x', headers: {} });
	const res = await call(route, badReq);
	assert.equal(res.status, 400);
	disposers();
	assert.ok(web.routes.every(r => r.unregistered));
});
