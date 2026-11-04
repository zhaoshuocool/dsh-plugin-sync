import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { fetchJson, latestVersions } from '../registry.mjs';

function listen(server) {
	return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// --- fetchJson over a real proxy hop ----------------------------------------

test('fetchJson reads JSON forwarded by a plain HTTP proxy', async () => {
	const origin = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ askedFor: req.url }));
	});
	const originPort = await listen(origin);
	const proxied = [];
	const proxy = http.createServer((req, res) => {
		proxied.push(req.url);
		const upstream = http.request(req.url, { method: req.method }, ur => {
			res.writeHead(ur.statusCode, { 'content-type': ur.headers['content-type'] });
			ur.pipe(res);
		});
		upstream.end();
	});
	const proxyPort = await listen(proxy);
	try {
		const result = await fetchJson(`http://127.0.0.1:${originPort}/@scope%2Fpkg`, {
			proxy: `http://127.0.0.1:${proxyPort}`,
		});
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.deepEqual(proxied, [`http://127.0.0.1:${originPort}/@scope%2Fpkg`], 'the proxy sees the absolute URL');
		assert.equal(result.value.askedFor, '/@scope%2Fpkg');
	} finally {
		origin.close();
		proxy.close();
	}
});

test('https through a proxy is tunneled with CONNECT to host:443', async () => {
	const seen = [];
	const proxy = net.createServer(socket => {
		socket.once('data', chunk => {
			seen.push(chunk.toString('utf8').split('\r\n')[0]);
			// claim the tunnel, then drop it: the TLS handshake must fail and the
			// caller must get an error result, not a throw.
			socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			socket.destroy();
		});
	});
	const port = await listen(proxy);
	try {
		const result = await fetchJson('https://registry.npmjs.org/pkg', {
			proxy: `http://127.0.0.1:${port}`,
			timeoutMs: 4000,
		});
		assert.deepEqual(seen, ['CONNECT registry.npmjs.org:443 HTTP/1.1']);
		assert.equal(result.ok, false);
		assert.equal(typeof result.error, 'string');
	} finally {
		proxy.close();
	}
});

test('a proxy that refuses CONNECT is reported, not thrown', async () => {
	const proxy = net.createServer(socket => {
		socket.once('data', () => {
			socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
			socket.end();
		});
	});
	const port = await listen(proxy);
	try {
		const result = await fetchJson('https://registry.npmjs.org/pkg', { proxy: `http://127.0.0.1:${port}` });
		assert.equal(result.ok, false);
		assert.match(result.error, /407/);
	} finally {
		proxy.close();
	}
});

test('an unreachable proxy resolves to an error result', async () => {
	const result = await fetchJson('https://registry.npmjs.org/pkg', { proxy: 'http://127.0.0.1:1', timeoutMs: 2000 });
	assert.equal(result.ok, false);
	assert.equal(typeof result.error, 'string');
});

// --- latestVersions ----------------------------------------------------------

test('latestVersions asks for each package and keeps partial results', async () => {
	const asked = [];
	const fetchJson = async url => {
		asked.push(url);
		if (url.includes('broken')) return { ok: false, error: 'unreachable' };
		return { ok: true, value: { 'dist-tags': { latest: '1.2.29' } } };
	};
	const out = await latestVersions(['good', 'broken', '@scope/pkg'], { fetchJson });
	assert.deepEqual(out.ok, [
		{ name: 'good', latest: '1.2.29' },
		{ name: '@scope/pkg', latest: '1.2.29' },
	]);
	assert.deepEqual(out.failed, [{ name: 'broken', error: 'unreachable' }]);
	assert.equal(asked[0], 'https://registry.npmjs.org/good');
	assert.equal(asked[2], 'https://registry.npmjs.org/@scope%2Fpkg', 'a scoped name encodes its slash');
});

test('latestVersions treats a missing dist-tags as a failure for that package', async () => {
	const out = await latestVersions(['pkg'], { fetchJson: async () => ({ ok: true, value: { name: 'pkg' } }) });
	assert.deepEqual(out.ok, []);
	assert.equal(out.failed.length, 1);
	assert.match(out.failed[0].error, /dist-tags/);
});

test('latestVersions honours a configured registry base', async () => {
	const asked = [];
	await latestVersions(['pkg'], {
		fetchJson: async url => { asked.push(url); return { ok: true, value: { 'dist-tags': { latest: '1.0.0' } } }; },
		registry: 'https://npm.internal.example/',
	});
	assert.deepEqual(asked, ['https://npm.internal.example/pkg']);
});
