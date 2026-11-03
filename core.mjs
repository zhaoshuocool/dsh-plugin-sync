// dsh-plugin-sync — pure manifest core.
//
// Zero side effects beyond an in-memory status singleton; no fs, no process
// env reads. Persistence of status.json is wired by the host shell (index.js)
// through an injected io object.

import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const PHASES = ['disabled', 'await-choose', 'await-empty-confirm', 'idle', 'syncing', 'error'];

const LOG_RING = 200;

/**
 * Normalize one manifest bundle entry.
 * @returns {{name: string, source: string|null, enabled: boolean|null} | undefined} undefined when invalid.
 */
function normalizeEntry(entry) {
	if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
	if (typeof entry.name !== 'string' || entry.name === '') return undefined;
	const source = entry.source == null ? null : (typeof entry.source === 'string' ? entry.source : undefined);
	if (source === undefined) return undefined;
	const enabled = entry.enabled == null ? null : (typeof entry.enabled === 'boolean' ? entry.enabled : undefined);
	if (enabled === undefined) return undefined;
	return { name: entry.name, source, enabled };
}

/**
 * Validate and normalize a raw manifest document.
 * @returns {{ok: true, manifest: object} | {ok: false, error: string}}
 */
export function normalizeManifest(raw) {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { ok: false, error: 'manifest must be a JSON object' };
	}
	if (raw.formatVersion !== 1) {
		return { ok: false, error: `unsupported formatVersion: ${JSON.stringify(raw.formatVersion)} (expected 1)` };
	}
	if (!Array.isArray(raw.bundles)) {
		return { ok: false, error: 'manifest.bundles must be an array' };
	}
	if (typeof raw.updatedAt !== 'string' || raw.updatedAt === '') {
		return { ok: false, error: 'manifest.updatedAt must be a non-empty string' };
	}
	if (typeof raw.updatedBy !== 'string' || raw.updatedBy === '') {
		return { ok: false, error: 'manifest.updatedBy must be a non-empty string' };
	}
	const bundles = [];
	for (const entry of raw.bundles) {
		const normalized = normalizeEntry(entry);
		if (!normalized) {
			return { ok: false, error: `invalid bundle entry: ${JSON.stringify(entry)}` };
		}
		bundles.push(normalized);
	}
	return { ok: true, manifest: { formatVersion: 1, bundles, updatedAt: raw.updatedAt, updatedBy: raw.updatedBy } };
}

/**
 * JSON.parse + normalizeManifest. Never throws.
 */
export function parseManifestJson(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: `invalid JSON: ${error.message}` };
	}
	return normalizeManifest(raw);
}

/**
 * Map pluginManager.listBundles() rows to manifest entries.
 * Excludes installation-layer rows without a source (they ship with DSH and
 * are not profile declarations); includes declared rows and any
 * source-carrying row (e.g. the sync plugin itself listed installed:false).
 */
export function bundlesFromList(bundles) {
	const entries = [];
	for (const row of bundles ?? []) {
		const hasSource = row != null && typeof row.source === 'string' && row.source !== '';
		if (row?.availability === 'installation' && !hasSource) continue;
		if (!hasSource && row?.installed !== true) continue;
		entries.push({
			name: row.name,
			source: hasSource ? row.source : null,
			enabled: row?.enabled == null ? null : (row.enabled === true),
		});
	}
	return entries;
}

function entryDiffers(a, b) {
	return a.source !== b.source || a.enabled !== b.enabled;
}

/**
 * Diff local entries against the baseline this machine last accepted.
 */
export function computeDiff(baseline, local) {
	const baseByName = new Map(baseline.map(e => [e.name, e]));
	const localByName = new Map(local.map(e => [e.name, e]));
	const added = [];
	const removed = [];
	const changed = [];
	for (const [name, entry] of localByName) {
		const base = baseByName.get(name);
		if (!base) added.push({ ...entry });
		else if (entryDiffers(base, entry)) changed.push({ ...entry });
	}
	for (const name of baseByName.keys()) {
		if (!localByName.has(name)) removed.push(name);
	}
	return { added, removed, changed };
}

/**
 * Apply an intent diff to a manifest; returns a new manifest with bumped
 * updatedAt/updatedBy. Input is never mutated.
 */
export function applyDiff(manifest, diff, machineName, now) {
	const upsert = new Map([...diff.added, ...diff.changed].map(e => [e.name, { ...e }]));
	const removedSet = new Set(diff.removed);
	const bundles = [];
	for (const entry of manifest.bundles) {
		if (removedSet.has(entry.name)) continue;
		bundles.push(upsert.has(entry.name) ? upsert.get(entry.name) : { ...entry });
	}
	for (const entry of diff.added) {
		if (!manifest.bundles.some(e => e.name === entry.name)) bundles.push({ ...entry });
	}
	return { formatVersion: 1, bundles, updatedAt: now, updatedBy: machineName };
}

/**
 * Diff expressing "local converges onto remote": added/changed carry the
 * REMOTE entries to adopt; removed lists local-only names.
 */
export function remoteWins(local, remote) {
	return computeDiff(local, remote.bundles.map(e => ({ ...e })));
}

/**
 * Union of two manifests. Same-name conflicts resolve in favor of b — the
 * manifest-level updatedAt cannot compare entries individually, so the
 * later-composed side (b) wins by rule.
 */
export function mergeUnion(a, b, machineName, now) {
	const bByName = new Map(b.bundles.map(e => [e.name, e]));
	const bundles = [];
	for (const entry of a.bundles) {
		bundles.push(bByName.has(entry.name) ? { ...bByName.get(entry.name) } : { ...entry });
	}
	for (const entry of b.bundles) {
		if (!a.bundles.some(e => e.name === entry.name)) bundles.push({ ...entry });
	}
	return { formatVersion: 1, bundles, updatedAt: now, updatedBy: machineName };
}

/**
 * Plan pluginManager actions to converge local onto remote.
 * Entries whose remote source is null name bundles that ship with the DSH
 * installation: they cannot be installed or removed via a spec, so they are
 * skipped in install/remove/reinstall.
 */
export function planConvergence(local, remote) {
	const localByName = new Map(local.map(e => [e.name, e]));
	const remoteByName = new Map(remote.bundles.map(e => [e.name, e]));
	const install = [];
	const remove = [];
	const enable = [];
	const disable = [];
	const reinstall = [];
	for (const entry of remote.bundles) {
		const mine = localByName.get(entry.name);
		if (!mine) {
			if (entry.source != null) install.push({ name: entry.name, source: entry.source });
			continue;
		}
		if (entry.source != null && entry.source !== mine.source) {
			reinstall.push({ name: entry.name, source: entry.source });
		}
		if (entry.enabled === true && mine.enabled !== true) enable.push(entry.name);
		if (entry.enabled === false && mine.enabled !== false) disable.push(entry.name);
	}
	for (const entry of local) {
		if (!remoteByName.has(entry.name) && entry.source != null) remove.push(entry.name);
	}
	return { install, remove, enable, disable, reinstall };
}

/**
 * True when a remote-sync would remove everything this machine has.
 */
export function isShrinkingToEmpty(localCount, remoteBundles) {
	return localCount > 0 && (remoteBundles?.length ?? 0) === 0;
}

/**
 * Local sync-state directory for a repo: <home>/plugin-sync/<sha256(repo)[:16]>.
 */
export function repoHashDir(home, repo) {
	const hash = createHash('sha256').update(repo).digest('hex').slice(0, 16);
	return join(home, 'plugin-sync', hash);
}

// --- status singleton (in-memory only; the host shell persists it via io) ----

const status = {
	phase: 'disabled',
	lastPullAt: null,
	lastPushAt: null,
	error: null,
	log: [],
};

/**
 * Snapshot of the sync status. The returned object and its log array are
 * copies; mutating them does not affect the singleton.
 */
export function getStatus() {
	return { ...status, log: status.log.map(e => ({ ...e })) };
}

/**
 * Merge a patch into the status. Only phase/lastPullAt/lastPushAt/error are
 * accepted; an unknown phase value is ignored.
 */
export function setStatus(patch) {
	if (patch == null || typeof patch !== 'object') return;
	if ('phase' in patch && PHASES.includes(patch.phase)) status.phase = patch.phase;
	if ('lastPullAt' in patch) status.lastPullAt = patch.lastPullAt ?? null;
	if ('lastPushAt' in patch) status.lastPushAt = patch.lastPushAt ?? null;
	if ('error' in patch) status.error = patch.error ?? null;
}

/**
 * Append one log entry; the log is a ring buffer dropping the oldest past 200.
 */
export function logStatus(level, msg) {
	status.log.push({ at: new Date().toISOString(), level, msg });
	if (status.log.length > LOG_RING) status.log.splice(0, status.log.length - LOG_RING);
}
