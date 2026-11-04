// dsh-plugin-sync — registry client, used by the update check.
//
// Zero dependencies on purpose: the profile's module tree has no undici
// (require.resolve('undici') fails from here), so an HTTP(S) request that honours
// the plugin's own `proxy` setting is built from node:http, node:https and
// node:tls — a plain forwarded request for `http:`, a CONNECT tunnel for `https:`.
// Every failure resolves to `{ ok: false, error }`; nothing rejects.

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { URL } from 'node:url';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const DEFAULT_TIMEOUT_MS = 10_000;

const MAX_BODY_BYTES = 1 << 20;

function request(via, agentOpts, onResponse, onError, timeoutMs) {
	const req = via.request(agentOpts, onResponse);
	req.on('error', onError);
	req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
	req.end();
	return req;
}

function readJson(res, resolve) {
	const chunks = [];
	let size = 0;
	res.on('data', chunk => {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) {
			res.destroy();
			return resolve({ ok: false, error: `response larger than ${MAX_BODY_BYTES} bytes` });
		}
		chunks.push(chunk);
	});
	res.on('end', () => {
		if (res.statusCode < 200 || res.statusCode >= 300) {
			return resolve({ ok: false, error: `registry responded ${res.statusCode}` });
		}
		try {
			resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
		} catch (err) {
			resolve({ ok: false, error: `unreadable registry response: ${err.message}` });
		}
	});
	res.on('error', err => resolve({ ok: false, error: err.message }));
}

function viaTunnel(target, proxy, resolve, timeoutMs) {
	const connect = http.request({
		host: proxy.hostname,
		port: Number(proxy.port) || 80,
		method: 'CONNECT',
		path: `${target.hostname}:${Number(target.port) || 443}`,
		agent: false,
	});
	connect.setTimeout(timeoutMs, () => connect.destroy(new Error(`proxy CONNECT timed out after ${timeoutMs}ms`)));
	connect.on('connect', (res, socket) => {
		if (res.statusCode !== 200) {
			socket.destroy();
			return resolve({ ok: false, error: `proxy refused CONNECT: ${res.statusCode}` });
		}
		// Hand the tunneled socket to TLS and wait for the handshake before any
		// request goes out. Passing `createConnection` on the request is not
		// enough: with `agent: false` Node builds its own agent and silently
		// opens a direct connection, which would bypass the proxy the moment the
		// tunnel is unusable. An explicit agent pins the tunnel or fails.
		const tlsSocket = tls.connect({ socket, servername: target.hostname });
		const fail = err => {
			tlsSocket.destroy();
			resolve({ ok: false, error: err.message });
		};
		tlsSocket.setTimeout(timeoutMs, () => fail(new Error(`TLS handshake timed out after ${timeoutMs}ms`)));
		tlsSocket.once('error', fail);
		tlsSocket.once('secureConnect', () => {
			const agent = new https.Agent({ createConnection: () => tlsSocket });
			const req = https.request(
				{
					hostname: target.hostname,
					port: Number(target.port) || 443,
					path: `${target.pathname}${target.search}`,
					headers: { host: target.host, accept: 'application/json' },
					agent,
				},
				res2 => readJson(res2, resolve),
			);
			req.on('error', fail);
			req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
			req.end();
		});
	});
	connect.on('error', err => resolve({ ok: false, error: `proxy connect failed: ${err.message}` }));
	connect.end();
}

/**
 * GET a URL and parse the body as JSON.
 *
 * `proxy` is an http(s) proxy URL from the plugin config. An `https:` target
 * through it is tunneled with CONNECT; an `http:` target is sent to the proxy in
 * absolute-URL form, which is what forwarding proxies expect.
 */
export function fetchJson(url, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return new Promise(resolve => {
		let target;
		let proxy = null;
		try {
			target = new URL(url);
			if (opts.proxy) proxy = new URL(opts.proxy);
		} catch (err) {
			return resolve({ ok: false, error: `bad request URL: ${err.message}` });
		}
		if (target.protocol !== 'https:' && target.protocol !== 'http:') {
			return resolve({ ok: false, error: `unsupported protocol ${target.protocol}` });
		}
		if (proxy && target.protocol === 'https:') return viaTunnel(target, proxy, resolve, timeoutMs);
		if (proxy) {
			return request(
				http,
				{
					host: proxy.hostname,
					port: Number(proxy.port) || 80,
					path: url,
					headers: { host: target.host, accept: 'application/json' },
					agent: false,
				},
				res => readJson(res, resolve),
				err => resolve({ ok: false, error: err.message }),
				timeoutMs,
			);
		}
		const via = target.protocol === 'https:' ? https : http;
		const req = via.request(
			{
				hostname: target.hostname,
				port: Number(target.port) || (target.protocol === 'https:' ? 443 : 80),
				path: `${target.pathname}${target.search}`,
				headers: { host: target.host, accept: 'application/json' },
				agent: false,
			},
			res => readJson(res, resolve),
		);
		req.on('error', err => resolve({ ok: false, error: err.message }));
		req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
		req.end();
	});
}

/** The registry path for a package name: a scope's slash is percent-encoded. */
export function encodePackageName(name) {
	return String(name).replace(/\//g, '%2F');
}

/**
 * Look up `dist-tags.latest` for each name. One request per package, in order;
 * a package that fails is reported in `failed` without stopping the others.
 */
export async function latestVersions(names, opts = {}) {
	const get = opts.fetchJson ?? fetchJson;
	const base = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
	const fetchOpts = {};
	if (opts.proxy) fetchOpts.proxy = opts.proxy;
	if (opts.timeoutMs !== undefined) fetchOpts.timeoutMs = opts.timeoutMs;
	const ok = [];
	const failed = [];
	for (const name of names) {
		const result = await get(`${base}/${encodePackageName(name)}`, fetchOpts);
		if (!result || result.ok !== true) {
			failed.push({ name, error: result?.error ?? 'no result from the registry' });
			continue;
		}
		const latest = result.value?.['dist-tags']?.latest;
		if (typeof latest !== 'string' || latest === '') {
			failed.push({ name, error: 'no dist-tags.latest in the registry response' });
			continue;
		}
		ok.push({ name, latest });
	}
	return { ok, failed };
}
