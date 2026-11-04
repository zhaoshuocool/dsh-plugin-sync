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

/**
 * Read the shape of an npm range: a pinned version, a range with a boundary
 * version (`^1.2.3`, `~1.2`, `>=1.0`, `1.x`, `1.x - 2`), or a floating marker
 * (`latest`, `next`, `*`) that names no version at all.
 */
function specShape(name, range) {
	const exact = /^(\^|~)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range);
	if (exact) {
		return {
			name,
			pin: exact[1] === undefined,
			triple: [Number(exact[2]), Number(exact[3] ?? 0), Number(exact[4] ?? 0)],
			floating: false,
		};
	}
	const lead = /^(\^|~)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
	if (lead) {
		return {
			name,
			pin: false,
			triple: [Number(lead[2]), Number(lead[3] ?? 0), Number(lead[4] ?? 0)],
			floating: false,
		};
	}
	return { name, pin: false, triple: null, floating: true };
}

/**
 * Parse a plain npm install spec into a spec shape; null for anything that is
 * not one (github:, file:, link:, ssh:, a Windows path, an opaque id).
 */
function npmSpec(source) {
	if (typeof source !== 'string' || source === '') return null;
	if (/^[A-Za-z][\w+.-]*:/.test(source)) return null;
	const at = source.lastIndexOf('@');
	if (at > 0) return specShape(source.slice(0, at), source.slice(at + 1));
	// No name part: only a version-shaped range (`^1.2.3`, `1.x`) is an npm
	// source here. An arbitrary word is some other transport's identifier, and
	// guessing it is "the same package" would be worse than comparing strings.
	const bare = specShape(null, source);
	return bare.floating ? null : bare;
}

const sameTriple = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/**
 * Do these two sources mean "install the same thing"?
 *
 * An npm spec is rewritten by the resolver: installing `pkg@^1.2.24` records
 * `pkg@^1.2.26`, and installing a bare pin `pkg@2.3.1` records `pkg@^2.3.1`.
 * Comparing those strings as a source change makes every machine remove and
 * reinstall the same bundle on every cycle. So the identity of an npm source is
 * its package name plus the boundary the resolver cannot move it across:
 *
 * - ranges (`^1.2.24`, `~1.2.0`, `1.x`): the same major, because a caret or
 *   tilde install never leaves its major and the resolver may move the recorded
 *   patch/minor freely. A deliberate upgrade to a new major converges with one
 *   reinstall and then settles.
 * - a pin (`2.3.1`): equal only to what was recorded for that very version
 *   (`^2.3.1`), so pinning a version still propagates — and stops propagating
 *   once every machine has it.
 * - floating specs (`latest`, `next`, `*`, `>=…`): the package name is the whole
 *   identity, since such a range can never equal a recorded version.
 *
 * Every other transport (github:, file:, link:, ssh:, bare paths) stays compared
 * exactly: those move only when someone means them to.
 */
export function sourcesEquivalent(a, b) {
	if (a === b) return true;
	const one = npmSpec(a);
	const other = npmSpec(b);
	if (one === null || other === null) return false;
	if (one.name !== other.name) return false;
	if (one.floating || other.floating) return true;
	if (one.pin || other.pin) return sameTriple(one.triple, other.triple);
	return one.triple[0] === other.triple[0];
}

function entryDiffers(a, b) {
	return !sourcesEquivalent(a.source, b.source) || a.enabled !== b.enabled;
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
 * skipped in install/remove/reinstall. `opts.selfName` names the sync bundle
 * itself: installing, removing, or reinstalling the bundle that is executing
 * the convergence would mutate the running plugin (and nest HMR transactions
 * inside its own request), so those actions are skipped for it as well; only
 * enable/disable remain planned for self.
 */
export function planConvergence(local, remote, opts = {}) {
	const self = opts.selfName ?? null;
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
			if (entry.source != null && entry.name !== self) install.push({ name: entry.name, source: entry.source });
			continue;
		}
		if (entry.source != null && !sourcesEquivalent(entry.source, mine.source) && entry.name !== self) {
			reinstall.push({ name: entry.name, source: entry.source });
		}
		if (entry.enabled === true && mine.enabled !== true) enable.push(entry.name);
		if (entry.enabled === false && mine.enabled !== false) disable.push(entry.name);
	}
	for (const entry of local) {
		if (!remoteByName.has(entry.name) && entry.source != null && entry.name !== self) remove.push(entry.name);
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
	repo: null,
	branch: null,
	proxy: null,
	machineName: null,
	intervalMs: null,
	remoteState: null,
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
 * Merge a patch into the status. Only phase/repo/branch/proxy/machineName/
 * remoteState/lastPullAt/lastPushAt/error are accepted; an unknown phase
 * value is ignored.
 */
export function setStatus(patch) {
	if (patch == null || typeof patch !== 'object') return;
	if ('phase' in patch && PHASES.includes(patch.phase)) status.phase = patch.phase;
	if ('repo' in patch) status.repo = patch.repo ?? null;
	if ('branch' in patch) status.branch = patch.branch ?? null;
	if ('proxy' in patch) status.proxy = patch.proxy ?? null;
	if ('machineName' in patch) status.machineName = patch.machineName ?? null;
	if ('intervalMs' in patch) status.intervalMs = patch.intervalMs ?? null;
	if ('remoteState' in patch) status.remoteState = patch.remoteState ?? null;
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
