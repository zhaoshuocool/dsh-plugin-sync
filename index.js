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
import { repoHashDir, setStatus, logStatus } from './core.mjs';

export const inject = ['pluginManager', 'fs', 'subprocess', 'webServer', 'timer', 'connection'];

// --- Config (zero-dependency Standard Schema) --------------------------------

/** Accepted repo forms: URL schemes git understands, or absolute local paths. */
const REPO_PATTERN = /^(https?:\/\/|ssh:\/\/|git:\/\/|git\+|file:\/\/|git@[\w.-]+:|[A-Za-z]:[\\/]|\/)/;

const FIELD_KEYS = new Set(['repo', 'branch', 'pullIntervalMs', 'machineName']);

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
		if (!FIELD_KEYS.has(key)) issues.push({ path: [key], message: `unknown config field "${key}" (expected repo/branch/pullIntervalMs/machineName)` });
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

	if (issues.length) throw new SyncConfigError(issues);
	return { repo, branch, pullIntervalMs, machineName };
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
function publishOutcome(outcome) {
	const summary = outcome.remoteState
		? { bundles: outcome.remoteState.bundles, updatedAt: outcome.remoteState.updatedAt, updatedBy: outcome.remoteState.updatedBy }
		: null;
	switch (outcome.action) {
		case 'await-choose':
			setStatus({ phase: 'await-choose', remoteState: summary });
			break;
		case 'await-empty-confirm':
			setStatus({ phase: 'await-empty-confirm', remoteState: summary });
			break;
		case 'error':
			setStatus({ phase: 'error', lastError: outcome.errors.join('; '), remoteState: summary });
			break;
		default:
			setStatus({ phase: 'idle', lastError: null, remoteState: summary });
	}
}

export function apply(ctx, config) {
	return ctx.effect(() => {
		const conf = Config(config);
		if (!conf.repo) {
			setStatus({ phase: 'disabled', repo: null, branch: conf.branch, machineName: conf.machineName });
			return;
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
			log,
		});

		const engine = createSyncEngine({
			git,
			pm: ctx.pluginManager,
			io,
			log,
			machineName: conf.machineName,
			now: () => new Date().toISOString(),
		});
		activeEngine = engine;

		setStatus({ phase: 'idle', repo: conf.repo, branch: conf.branch, machineName: conf.machineName });

		const runLogged = (kind) => async () => {
			setStatus({ phase: 'syncing' });
			try {
				const outcome = await engine[kind]();
				publishOutcome(outcome);
				return outcome;
			} catch (error) {
				log('error', `${kind} failed: ${error?.message ?? error}`);
				setStatus({ phase: 'error', lastError: String(error?.message ?? error) });
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
				for (const close of closes) await close().catch(() => {});
				log('warn', `profile watch unavailable (${error?.message ?? error}); polling the local snapshot every 60s`);
				if (!disposed) startFallbackPolling();
				return;
			}
			if (disposed) {
				for (const close of closes) await close().catch(() => {});
				return;
			}
			watcherCloses = closes;
		})();

		return () => {
			disposed = true;
			scheduler.stop();
			controller.abort();
			for (const close of watcherCloses) void close().catch(() => {});
			if (fallbackTimer) fallbackTimer();
			if (activeEngine === engine) {
				activeEngine = null;
				activeScheduler = null;
			}
		};
	});
}
