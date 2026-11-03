// dsh-plugin-sync — Host plugin shell.
//
// Keeps this profile's plugin bundle list mirrored to a private git repo so
// another machine signed into the same repo sees the same set. Everything
// runs through injected Host services (`pluginManager`, `fs`, `subprocess`,
// `webServer`, `timer`, plus `connection` to guard the status routes); this
// file owns wiring only. Convergence logic lives in `engine.mjs`, git access
// in `git.mjs`, and pure manifest algebra in `core.mjs` — all zero-dependency.
//
// Config is a hand-rolled Standard Schema (callable, zod-compatible): the
// bundle deliberately imports no runtime packages, so the schema cannot come
// from schemastery/zod like other plugins' usually do.

import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { createSyncEngine } from './engine.mjs';
import { createGitOps } from './git.mjs';
import { getStatus, repoHashDir, setStatus, logStatus } from './core.mjs';

export const inject = ['pluginManager', 'fs', 'subprocess', 'webServer', 'timer', 'connection', 'configEditor'];

// --- Config (zero-dependency Standard Schema) --------------------------------

/** Accepted repo forms: URL schemes git understands, or absolute local paths. */
const REPO_PATTERN = /^(https?:\/\/|ssh:\/\/|git:\/\/|git\+|file:\/\/|git@[\w.-]+:|[A-Za-z]:[\\/]|\/)/;

const FIELD_KEYS = new Set(['repo', 'branch', 'pullIntervalMs', 'machineName', 'proxy']);

/**
 * Proxy URL schemes Git's HTTP transport understands. Desktop apps usually get
 * their proxy from the system settings, which `git` never reads; the subprocess
 * environment is scrubbed too, so a proxy has to be named explicitly here.
 */
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

/** Normalize a proxy URL; returns null for "no proxy", undefined when invalid. */
function normalizeProxy(raw) {
	const trimmed = raw.trim();
	if (trimmed === '') return null;
	let parsed = null;
	try {
		parsed = new URL(trimmed);
	} catch {
		parsed = null;
	}
	if (!parsed || !PROXY_PROTOCOLS.has(parsed.protocol) || parsed.hostname === '') return undefined;
	return parsed.href.replace(/\/+$/, '');
}

class SyncConfigError extends Error {
	constructor(issues) {
		super(issues.map(issue => issue.message).join('; '));
		this.name = 'SyncConfigError';
		this.issues = issues;
	}
}

function parseConfig(data) {
	const source = data == null ? {} : data;
	if (typeof source !== 'object' || Array.isArray(source)) {
		throw new SyncConfigError([{ path: [], message: 'plugin-sync config must be an object' }]);
	}
	const issues = [];
	for (const key of Object.keys(source)) {
		if (!FIELD_KEYS.has(key)) issues.push({ path: [key], message: `unknown config field "${key}" (expected repo/branch/pullIntervalMs/machineName/proxy)` });
	}

	let repo = null;
	if (source.repo !== undefined && source.repo !== null) {
		if (typeof source.repo !== 'string') {
			issues.push({ path: ['repo'], message: 'repo must be a string or null' });
		} else {
			const trimmed = source.repo.trim();
			if (trimmed === '') repo = null;
			else if (!REPO_PATTERN.test(trimmed)) {
				issues.push({ path: ['repo'], message: `repo must be a git URL (https/ssh/git/file) or an absolute local path, got "${trimmed}"` });
			} else repo = trimmed;
		}
	}

	let branch = 'main';
	if (source.branch !== undefined) {
		if (typeof source.branch !== 'string' || !/^[^\s~^:?*\[]+(\/[^\s~^:?*\[]+)*$/.test(source.branch)) {
			issues.push({ path: ['branch'], message: 'branch must be a non-empty git ref name without spaces or special characters' });
		} else branch = source.branch;
	}

	let pullIntervalMs = 300_000;
	if (source.pullIntervalMs !== undefined) {
		if (typeof source.pullIntervalMs !== 'number' || !Number.isInteger(source.pullIntervalMs)) {
			issues.push({ path: ['pullIntervalMs'], message: 'pullIntervalMs must be an integer number of milliseconds' });
		} else if (source.pullIntervalMs < 60_000) {
			issues.push({ path: ['pullIntervalMs'], message: 'pullIntervalMs must be at least 60000 (one minute)' });
		} else pullIntervalMs = source.pullIntervalMs;
	}

	let machineName = os.hostname() || 'unknown-machine';
	if (source.machineName !== undefined) {
		if (typeof source.machineName !== 'string' || source.machineName.trim() === '' || source.machineName.length > 128) {
			issues.push({ path: ['machineName'], message: 'machineName must be a non-empty string (at most 128 characters)' });
		} else machineName = source.machineName;
	}

	let proxy = null;
	if (source.proxy !== undefined && source.proxy !== null) {
		if (typeof source.proxy !== 'string') {
			issues.push({ path: ['proxy'], message: 'proxy must be a URL string or null' });
		} else {
			const normalized = normalizeProxy(source.proxy);
			if (normalized === undefined) {
				issues.push({ path: ['proxy'], message: `proxy must be an http/https/socks URL such as "http://127.0.0.1:10808", got "${source.proxy.trim()}"` });
			} else proxy = normalized;
		}
	}

	if (issues.length) throw new SyncConfigError(issues);
	return { repo, branch, pullIntervalMs, machineName, proxy };
}

/**
 * Plugin row config schema. Callable like schemastery schemas, parse/validate
 * per the Standard Schema interface, and accepted unchanged on config write-
 * back (no volatile defaults to simplify away).
 */
export const Config = Object.assign(
	(data) => parseConfig(data),
	{
		parse: parseConfig,
		simplify: (data) => data,
		'~standard': {
			version: 1,
			vendor: 'dsh-plugin-sync',
			validate: (value) => {
				try {
					return { value: parseConfig(value), issues: undefined };
				} catch (error) {
					return { issues: error.issues ?? [{ message: String(error), path: [] }] };
				}
			},
		},
	},
);

// --- scheduler (exported for tests) -------------------------------------------

/**
 * Single-flight scheduler for sync jobs.
 * Jobs are kinds: 'sync' (pull then push), 'pull', 'push'. At most one job is
 * in flight; further requests queue and same-kind requests merge into one
 * follow-up run. Push requests from the file watcher are debounced so bursty
 * profile edits collapse into a single push.
 *
 * @param deps {{
 *   pull: () => Promise<unknown>, push: () => Promise<unknown>,
 *   intervalMs: number, debounceMs?: number, bootDelayMs?: number,
 *   timers: { setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (h: any) => void,
 *             setInterval: (fn: () => void, ms: number) => any, clearInterval: (h: any) => void }
 * }}
 */
export function createScheduler({ pull, push, intervalMs, debounceMs = 30_000, bootDelayMs = 15_000, timers }) {
	let inFlight = null;
	const queued = [];
	let debounceTimer = null;
	let bootTimer = null;
	let intervalTimer = null;
	let stopped = false;

	function drain() {
		if (stopped) return Promise.resolve();
		if (inFlight) return inFlight;
		const kinds = queued.splice(0, queued.length);
		const doPull = kinds.includes('sync') || kinds.includes('pull');
		const doPush = kinds.includes('sync') || kinds.includes('push');
		const job = (async () => {
			// Each phase fails alone: a dead remote must not skip a local push
			// replay, and the scheduler must never wedge on a rejection.
			if (doPull) {
				try {
					await pull();
				} catch { /* the injected wrapper reports and logs */ }
			}
			if (doPush) {
				try {
					await push();
				} catch { /* likewise */ }
			}
		})().then(() => {
			inFlight = null;
			if (queued.length > 0) return drain();
			return undefined;
		});
		inFlight = job;
		return job;
	}

	function enqueue(kind) {
		if (stopped) return Promise.resolve();
		if (inFlight && queued.includes(kind)) return inFlight;
		queued.push(kind);
		return drain();
	}

	return {
		start() {
			bootTimer = timers.setTimeout(() => {
				bootTimer = null;
				enqueue('pull');
				intervalTimer = timers.setInterval(() => enqueue('pull'), intervalMs);
			}, bootDelayMs);
		},
		stop() {
			stopped = true;
			if (bootTimer != null) timers.clearTimeout(bootTimer);
			if (intervalTimer != null) timers.clearInterval(intervalTimer);
			if (debounceTimer != null) timers.clearTimeout(debounceTimer);
			queued.length = 0;
		},
		triggerPush() {
			if (stopped) return;
			if (debounceTimer != null) timers.clearTimeout(debounceTimer);
			debounceTimer = timers.setTimeout(() => {
				debounceTimer = null;
				enqueue('push');
			}, debounceMs);
		},
		runNow() {
			return enqueue('sync');
		},
	};
}

// --- web API routes -----------------------------------------------------------

/** Base path of this plugin's routes. */
const BASE = '/api/plugin-sync';

/** Own bundle name; convergence never installs, removes, or reinstalls it. */
const PACKAGE_NAME = 'dsh-plugin-sync';

/** Answer one HTTP request with JSON (same idiom as other profile controllers). */
function sendJson(res, status, body) {
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	});
	res.end(JSON.stringify(body));
}

/** Read a bounded request body. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		let body = '';
		req.on('data', (chunk) => {
			body += chunk.toString('utf8');
			if (body.length > 8192) reject(new Error('body-too-large'));
		});
		req.on('end', () => resolve(body));
		req.on('error', reject);
	});
}

/**
 * Register the status/control routes on the Web server. Handlers only read
 * state or trigger the engine/scheduler; they never compute business results
 * themselves. Every request first passes Connection's trust fence.
 *
 * @param web - `ctx.webServer`.
 * @param connection - `ctx.connection`.
 * @param accessors - {{ getStatus, getScheduler, getEngine }} live accessors.
 * @returns disposer unregistering every route.
 */
export function registerRoutes(web, connection, { getStatus, getScheduler, getEngine, publish, saveConfig }) {
	const trusted = (req, res) => {
		const rejection = connection.requestRejection({ headers: req.headers ?? {} });
		if (rejection !== undefined) {
			sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' });
			return false;
		}
		return true;
	};

	const post = (path, run) => ({
		kind: 'exact',
		path,
		handler: async (req, res) => {
			if (!trusted(req, res)) return;
			if (req.method !== 'POST') {
				sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
				return;
			}
			let body = {};
			try {
				const text = await readBody(req);
				if (text.trim() !== '') body = JSON.parse(text);
			} catch {
				sendJson(res, 400, { ok: false, error: 'invalid-json-body' });
				return;
			}
			try {
				await run(req, res, body);
			} catch (error) {
				sendJson(res, error?.status ?? 500, { ok: false, error: String(error?.message ?? error) });
			}
		},
	});

	const engineRunner = (path, run) => post(path, async (req, res, body) => {
		const engine = getEngine();
		if (!engine) {
			sendJson(res, 503, { ok: false, error: 'sync-not-active' });
			return;
		}
		const outcome = await run(engine, body);
		// Publish first: the Settings tab polls the status singleton and must
		// see the phase leave await-choose as soon as this response lands.
		if (typeof publish === 'function') publish(outcome, 'pull');
		sendJson(res, 200, { ok: outcome.action !== 'error', outcome });
	});

	const routes = [
		{
			kind: 'exact',
			path: `${BASE}/status`,
			handler: async (req, res) => {
				if (!trusted(req, res)) return;
				if (req.method !== 'GET') {
					sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
					return;
				}
				sendJson(res, 200, getStatus());
			},
		},
		post(`${BASE}/run`, (req, res) => {
			const scheduler = getScheduler();
			if (!scheduler) {
				sendJson(res, 503, { ok: false, error: 'sync-not-active' });
				return;
			}
			void scheduler.runNow();
			sendJson(res, 200, { ok: true, started: true });
		}),
		engineRunner(`${BASE}/bootstrap`, (engine, body) => {
			const mode = body?.mode;
			if (mode !== 'remote' && mode !== 'merge') {
				const error = new Error("mode must be 'remote' or 'merge'");
				error.status = 400;
				throw error;
			}
			return engine.bootstrap(mode);
		}),
		engineRunner(`${BASE}/confirm-empty`, (engine) => engine.confirmEmpty()),
		post(`${BASE}/config`, async (req, res, body) => {
			if (typeof saveConfig !== 'function') {
				sendJson(res, 503, { ok: false, error: 'config-editor-unavailable' });
				return;
			}
			const values = {};
			for (const key of FIELD_KEYS) {
				if (key in body) values[key] = body[key];
			}
			if (Object.keys(values).length === 0) {
				sendJson(res, 400, { ok: false, error: 'empty-config-patch' });
				return;
			}
			// Shape-check through the same Config parser the Loader uses, then
			// persist only the fields the page actually sent.
			let parsed;
			try {
				parsed = parseConfig(values);
			} catch (error) {
				sendJson(res, 400, { ok: false, error: error?.issues?.map(i => `${i.path}: ${i.message}`).join('; ') ?? String(error?.message ?? error) });
				return;
			}
			const next = {};
			for (const key of Object.keys(values)) {
				const raw = values[key];
				if (raw === null || raw === '') {
					next[key] = null;
					continue;
				}
				next[key] = parsed[key];
			}
			await saveConfig(next);
			sendJson(res, 200, { ok: true, saved: next });
		}),
	];

	const disposers = routes.map(route => web.register(route));
	return () => {
		for (const dispose of disposers) dispose();
	};
}

// --- apply -------------------------------------------------------------------

/** The engine/scheduler of the active fiber; used by the routes (Task 6). */
let activeEngine = null;
let activeScheduler = null;

/** Read the sync engine created by the running plugin, if any. */
export function getEngine() {
	return activeEngine;
}

/** Read the scheduler created by the running plugin, if any. */
export function getScheduler() {
	return activeScheduler;
}

/** Map one engine outcome onto the shared status singleton for the UI. */
function publishOutcome(outcome, kind) {
	const summary = outcome.remoteState
		? { bundles: outcome.remoteState.bundles, updatedAt: outcome.remoteState.updatedAt, updatedBy: outcome.remoteState.updatedBy }
		: null;
	const stamp = {};
	const at = new Date().toISOString();
	if (kind === 'pull') stamp.lastPullAt = at;
	if (kind === 'push') stamp.lastPushAt = at;
	switch (outcome.action) {
		case 'await-choose':
			setStatus({ phase: 'await-choose', remoteState: summary, error: null });
			break;
		case 'await-empty-confirm':
			setStatus({ phase: 'await-empty-confirm', remoteState: summary, error: null });
			break;
		case 'error':
			setStatus({ phase: 'error', error: outcome.errors.join('; '), remoteState: summary, ...stamp });
			break;
		default:
			setStatus({ phase: 'idle', error: null, remoteState: summary ?? getStatus().remoteState, ...stamp });
	}
}

/**
 * Build this plugin's config write path.
 *
 * A Loader `Entry` keeps its identity inside `entry.options` (`id` / `name`);
 * the entry object itself has no `patchId` / `name` / `moduleName` property to
 * match on. Address our own entry the way the editor's other callers do: the
 * running fiber's own entry when the editor lists it, otherwise a lookup by
 * `options.id` — the same key the settings bundle uses.
 */
export function createSaveConfig(ctx) {
	return async (values) => {
		const entries = ctx.configEditor.entries();
		const self = ctx.fiber?.entry;
		const entry = self !== undefined && entries.includes(self)
			? self
			: entries.find(row => row?.options?.id === PACKAGE_NAME);
		if (!entry) {
			const error = new Error('this plugin is not addressable in the profile patch');
			error.status = 503;
			throw error;
		}
		// The configEditor writes the patch entry and reconciles the Loader, so a
		// save from the Settings tab behaves exactly like editing the YAML by hand.
		await ctx.configEditor.edit(entry, (current) => {
			const next = { ...(current ?? {}) };
			for (const [key, value] of Object.entries(values)) {
				if (value === null) delete next[key];
				else next[key] = value;
			}
			return next;
		});
	};
}

export function apply(ctx, config) {
	return ctx.effect(() => {
		const saveConfig = createSaveConfig(ctx);

		// Routes answer even while sync is disabled, so the Settings tab always
		// has something to read.
		const disposeRoutes = registerRoutes(ctx.webServer, ctx.connection, {
			getStatus,
			getScheduler,
			getEngine,
			publish: publishOutcome,
			saveConfig,
		});

		const conf = Config(config);
		if (!conf.repo) {
			setStatus({ phase: 'disabled', repo: null, branch: conf.branch, proxy: conf.proxy, machineName: conf.machineName, intervalMs: conf.pullIntervalMs });
			return disposeRoutes;
		}

		const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
		const syncDir = repoHashDir(dshHome, conf.repo);

		const log = (level, message) => {
			logStatus(level, message);
			const logger = ctx.logger?.('plugin-sync');
			const emit = logger?.[level === 'info' ? 'info' : level === 'warn' ? 'warn' : 'error'];
			if (emit) emit.call(logger, message);
		};

		const io = {
			async readJson(rel) {
				try {
					return JSON.parse(await readFile(path.join(syncDir, rel), 'utf8'));
				} catch (error) {
					if (error?.code === 'ENOENT') return null;
					if (error instanceof SyntaxError) return null;
					throw error;
				}
			},
			async writeJson(rel, value) {
				await mkdir(syncDir, { recursive: true });
				await writeFile(path.join(syncDir, rel), JSON.stringify(value, null, 2), 'utf8');
			},
		};

		const git = createGitOps({
			subprocess: ctx.subprocess,
			dir: syncDir,
			repo: conf.repo,
			branch: conf.branch,
			proxy: conf.proxy,
			log,
		});

		const engine = createSyncEngine({
			git,
			pm: ctx.pluginManager,
			io,
			log,
			machineName: conf.machineName,
			now: () => new Date().toISOString(),
			selfName: PACKAGE_NAME,
		});
		activeEngine = engine;

		setStatus({ phase: 'idle', repo: conf.repo, branch: conf.branch, proxy: conf.proxy, machineName: conf.machineName, intervalMs: conf.pullIntervalMs });

		const runLogged = (kind) => async () => {
			setStatus({ phase: 'syncing' });
			try {
				const outcome = await engine[kind]();
				publishOutcome(outcome, kind);
				return outcome;
			} catch (error) {
				log('error', `${kind} failed: ${error?.message ?? error}`);
				setStatus({ phase: 'error', error: String(error?.message ?? error) });
			}
		};

		const timers = {
			setTimeout: (fn, ms) => ctx.timer.timeout(fn, ms),
			clearTimeout: (stop) => stop(),
			setInterval: (fn, ms) => ctx.timer.interval(fn, ms),
			clearInterval: (stop) => stop(),
		};

		const scheduler = createScheduler({
			pull: runLogged('pull'),
			push: runLogged('push'),
			intervalMs: conf.pullIntervalMs,
			debounceMs: 30_000,
			bootDelayMs: 15_000,
			timers,
		});
		activeScheduler = scheduler;
		scheduler.start();

		// Profile edits (pnpm add / plugin toggles) rewrite package.json and
		// cordis.patch.yml; watch both directly and collapse the churn into one
		// debounced push. If the watcher cannot start, poll the local bundle
		// snapshot every 60s instead.
		const controller = new AbortController();
		// A watcher disposer may return void or a promise; await both shapes.
		const closeQuietly = async (close) => {
			try {
				await close();
			} catch { /* the watcher is already gone */ }
		};
		const profileDir = process.env.DSH_PROFILE_DIR
			?? path.join(dshHome, 'profiles', process.env.DSH_PROFILE ?? 'local');
		let watcherCloses = [];
		let fallbackTimer = null;
		let disposed = false;

		const startFallbackPolling = () => {
			let lastSnapshot = null;
			fallbackTimer = ctx.timer.interval(async () => {
				try {
					const snapshot = JSON.stringify(await ctx.pluginManager.listBundles());
					if (lastSnapshot !== null && snapshot !== lastSnapshot) scheduler.triggerPush();
					lastSnapshot = snapshot;
				} catch (error) {
					log('warn', `local snapshot poll failed: ${error?.message ?? error}`);
				}
			}, 60_000);
		};

		(async () => {
			const closes = [];
			try {
				for (const file of ['package.json', 'cordis.patch.yml']) {
					const target = await ctx.fs.resolve(path.join(profileDir, file));
					closes.push(await ctx.fs.watch(target, () => scheduler.triggerPush(), controller.signal));
				}
			} catch (error) {
				for (const close of closes) await closeQuietly(close);
				log('warn', `profile watch unavailable (${error?.message ?? error}); polling the local snapshot every 60s`);
				if (!disposed) startFallbackPolling();
				return;
			}
			if (disposed) {
				for (const close of closes) await closeQuietly(close);
				return;
			}
			watcherCloses = closes;
		})();

		return () => {
			disposed = true;
			scheduler.stop();
			controller.abort();
			for (const close of watcherCloses) void closeQuietly(close);
			if (fallbackTimer) fallbackTimer();
			disposeRoutes();
			if (activeEngine === engine) {
				activeEngine = null;
				activeScheduler = null;
			}
		};
	});
}
