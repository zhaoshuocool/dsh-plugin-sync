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
	const config = entryConfig(entry);
	return config === undefined ? { name: entry.name, source, enabled } : { name: entry.name, source, enabled, config };
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
		const configError = entryConfigError(entry);
		if (configError !== null) {
			// Loud on purpose: a manifest that names a secret key is refused in
			// full rather than quietly dropping the key and syncing the rest.
			const who = typeof entry?.name === 'string' ? entry.name : 'unknown';
			return { ok: false, error: `bundle "${who}": ${configError}` };
		}
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
 * Read the shape of an npm range: `pin` (one version), `caret`, `tilde`, `range`
 * (`1.x`, `1.2 - 2`, anything with trailing text), or `floating` (`latest`,
 * `next`, `*`) which names no version at all.
 */
function specShape(name, range) {
	const tripleOf = m => [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
	const kindOf = m => {
		if (m[1] === '^') return 'caret';
		if (m[1] === '~') return 'tilde';
		return m[3] !== undefined && m[4] !== undefined ? 'pin' : 'range';
	};
	const exact = /^(\^|~)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range);
	if (exact) return { name, kind: kindOf(exact), triple: tripleOf(exact) };
	const lead = /^(\^|~)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
	// Trailing text after the version (`1.x`, `1.2 - 2`, a prerelease) makes the
	// range open rather than a pin.
	if (lead) return { name, kind: 'range', triple: tripleOf(lead) };
	return { name, kind: 'floating', triple: null };
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
	return bare.kind === 'floating' ? null : bare;
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
	if (one.kind === 'floating' || other.kind === 'floating') return true;
	if (one.kind === 'pin' || other.kind === 'pin') return sameTriple(one.triple, other.triple);
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
 * A manifest entry may carry `config`: the exact keys this manifest is
 * allowed to sync for that plugin. Nothing else about a plugin's configuration
 * is ever read, written, or pushed.
 *
 * Secret-shaped keys are refused on both sides — the machine writing the
 * manifest cannot publish them, and the machine reading it cannot install them
 * into a profile patch. `__jsExpr` is refused because the profile patch YAML
 * turns that key into a live expression.
 */
const SECRET_CONFIG_KEY = /(?:^|[_$-])(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization|credential|private[_-]?key|client[_-]?secret)(?:[$_-]|$)/i;
const MAX_CONFIG_DEPTH = 6;

export function unsafeConfigKey(key) {
	const name = String(key);
	return name === '__jsExpr' || SECRET_CONFIG_KEY.test(name);
}

function isJsonScalar(value) {
	const kind = typeof value;
	if (kind === 'string' || kind === 'boolean') return true;
	if (kind === 'number') return Number.isFinite(value);
	return value === null;
}

function configValueIssues(value, path, depth, issues) {
	if (isJsonScalar(value)) return;
	if (Array.isArray(value)) {
		if (depth >= MAX_CONFIG_DEPTH) {
			issues.push(`config at "${path || '.'}" nests too deeply`);
			return;
		}
		value.forEach((item, index) => configValueIssues(item, `${path}[${index}]`, depth + 1, issues));
		return;
	}
	if (typeof value !== 'object' || value === null) {
		issues.push(`config at "${path}" is not a JSON value`);
		return;
	}
	if (depth >= MAX_CONFIG_DEPTH) {
		issues.push(`config at "${path || '.'}" nests too deeply`);
		return;
	}
	for (const [key, item] of Object.entries(value)) {
		if (unsafeConfigKey(key)) {
			issues.push(`config key "${key}" looks like a secret or an expression; it is never synced`);
			continue;
		}
		configValueIssues(item, `${path}.${key}`, depth + 1, issues);
	}
}

/** @returns string[] why this config object is unusable (empty when it is fine). */
export function configIssues(config) {
	if (typeof config !== 'object' || config === null || Array.isArray(config)) {
		return ['config must be a plain object of key/value pairs'];
	}
	const issues = [];
	for (const [key, value] of Object.entries(config)) {
		if (unsafeConfigKey(key)) {
			issues.push(`config key "${key}" looks like a secret or an expression; it is never synced`);
			continue;
		}
		configValueIssues(value, key, 1, issues);
	}
	return issues;
}

function rawEntryConfig(entry) {
	return typeof entry === 'object' && entry !== null && 'config' in entry ? entry.config : undefined;
}

/** @returns string|null the first problem with an entry's config, naming keys but never values. */
export function entryConfigError(entry) {
	const config = rawEntryConfig(entry);
	if (config === undefined) return null;
	const issues = configIssues(config);
	return issues.length > 0 ? issues[0] : null;
}

function entryConfig(entry) {
	const config = rawEntryConfig(entry);
	if (config === undefined) return undefined;
	const copy = JSON.parse(JSON.stringify(config));
	return Object.keys(copy).length === 0 ? undefined : copy;
}

function jsonEqual(a, b) {
	return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

/**
 * Which plugins need a config write to match the manifest, and only the keys
 * whose value this machine does not already run. A plugin that is not installed
 * is skipped: config is not a way to install anything.
 *
 * Three-way, exactly like the bundle list: a key whose local value differs from
 * the last synced baseline is this machine's own intent, and a remote value
 * never overwrites an intent — that key is pushed instead (see
 * `planConfigPush`). Without that rule a pull would erase whatever the user
 * changed in the Settings tab seconds before their push could carry it away.
 *
 * The sync bundle's own entry sorts last, because editing our own config
 * restarts us and we do not want to die mid-list.
 */
export function planConfigApply(rows, remoteBundles, opts = {}) {
	const self = opts.selfName ?? null;
	const baselineConfig = baselineConfigByName(opts.baselineBundles);
	const byName = new Map();
	for (const row of rows ?? []) {
		const name = row?.entry?.options?.name;
		if (typeof name === 'string') byName.set(name, row);
	}
	const plans = [];
	for (const entry of remoteBundles ?? []) {
		if (!entry || typeof entry.name !== 'string' || entry.config === undefined) continue;
		const row = byName.get(entry.name);
		if (!row) continue;
		const values = {};
		for (const [key, value] of Object.entries(entry.config)) {
			if (unsafeConfigKey(key)) continue;
			if (isLocalIntent(row.override, baselineConfig.get(entry.name), key)) continue;
			if (jsonEqual(row.inherited?.[key], value)) continue;
			values[key] = value;
		}
		if (Object.keys(values).length === 0) continue;
		plans.push({ name: entry.name, entry: row.entry, values });
	}
	plans.sort((one, other) => (one.name === self ? 1 : 0) - (other.name === self ? 1 : 0));
	return plans;
}

function baselineConfigByName(baselineBundles) {
	const byName = new Map();
	for (const entry of baselineBundles ?? []) {
		if (entry && typeof entry.name === 'string' && entry.config !== undefined) byName.set(entry.name, entry.config);
	}
	return byName;
}

/** Did this machine itself set this key to something other than the last synced value? */
function isLocalIntent(override, baselineConfig, key) {
	if (!override || typeof override !== 'object' || !Object.hasOwn(override, key)) return false;
	return !jsonEqual(override[key], baselineConfig?.[key]);
}

/**
 * What this machine would add to the shared whitelist: only keys the manifest
 * already lists, and only where this machine has its own intent — a value it
 * set that differs from the last synced manifest. A key this machine never set
 * is left alone: an absent local value is not a vote to clear a shared one.
 */
export function planConfigPush(remoteBundles, localOverrides, opts = {}) {
	const baselineConfig = baselineConfigByName(opts.baselineBundles);
	const plans = [];
	for (const entry of remoteBundles ?? []) {
		if (!entry || typeof entry.name !== 'string' || entry.config === undefined) continue;
		const override = localOverrides?.[entry.name];
		if (!override || typeof override !== 'object') continue;
		const patch = {};
		for (const key of Object.keys(entry.config)) {
			if (unsafeConfigKey(key)) continue;
			if (!isLocalIntent(override, baselineConfig.get(entry.name), key)) continue;
			if (jsonEqual(override[key], entry.config[key])) continue;
			patch[key] = override[key];
		}
		if (Object.keys(patch).length > 0) plans.push({ name: entry.name, config: patch });
	}
	return plans;
}

/**
 * Fold a push plan into a manifest that was just rebuilt from local state.
 * Rebuilt entries carry no config, so the whitelist is carried over from the
 * remote manifest first and the new values written on top — otherwise changing
 * one plugin's enabled flag would silently drop its synced keys.
 */
export function mergeManifestConfig(manifest, remoteBundles, pushPlan) {
	const patches = new Map((pushPlan ?? []).map(plan => [plan.name, plan.config]));
	const carried = new Map((remoteBundles ?? []).map(entry => [entry.name, entry.config]).filter(([, config]) => config !== undefined));
	const bundles = manifest.bundles.map(entry => {
		const base = carried.get(entry.name);
		const patch = patches.get(entry.name);
		const next = { ...entry };
		delete next.config;
		if (base !== undefined || patch !== undefined) {
			const merged = { ...(base ?? {}), ...(patch ?? {}) };
			if (Object.keys(merged).length > 0) next.config = merged;
		}
		return next;
	});
	return { ...manifest, bundles };
}

/**
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

// --- update checking ---------------------------------------------------------

/**
 * Installed version per bundle name, straight from the host's bundle rows.
 * Kept apart from the sync entries on purpose: the manifest's entries stay
 * `{ name, source, enabled }` and never carry a machine's resolved version.
 */
export function installedVersionsFromList(rows) {
	const versions = {};
	for (const row of rows ?? []) {
		if (row?.installed === true && typeof row.name === 'string' && typeof row.version === 'string' && row.version !== '') {
			versions[row.name] = row.version;
		}
	}
	return versions;
}

function parseVersion(text) {
	const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/.exec(String(text ?? ''));
	if (!match) return null;
	return {
		triple: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
		prerelease: match[4] ?? null,
	};
}

function compareTriples(a, b) {
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
	}
	return 0;
}

/**
 * -1, 0 or 1. An unparseable version compares equal, so an odd version string
 * never buys an upgrade. A prerelease ranks below the release it precedes.
 */
export function semverCompare(a, b) {
	const one = parseVersion(a);
	const other = parseVersion(b);
	if (one === null || other === null) return 0;
	const byTriple = compareTriples(one.triple, other.triple);
	if (byTriple !== 0) return byTriple;
	if (one.prerelease === other.prerelease) return 0;
	if (one.prerelease !== null) return -1;
	return 1;
}

/**
 * Would installing this range pick `version`? An exact pin says one version;
 * a caret stays in its major (and in its minor for 0.x, as npm does); a tilde
 * stays in its minor. Anything open (`latest`, `*`, `>=…`, `1.x`) is taken at
 * face value, and so is anything that is not an npm range at all — the
 * installer knows better than this parser.
 */
export function rangeAccepts(spec, version) {
	const shape = npmSpec(spec);
	if (shape === null || shape.kind === 'floating' || shape.kind === 'range') return true;
	const target = parseVersion(version);
	if (target === null) return false;
	if (shape.kind === 'pin') return compareTriples(shape.triple, target.triple) === 0 && target.prerelease === null;
	if (compareTriples(target.triple, shape.triple) < 0) return false;
	const [major, minor] = shape.triple;
	const [targetMajor, targetMinor] = target.triple;
	if (shape.kind === 'caret') return major > 0 ? targetMajor === major : targetMajor === 0 && targetMinor === minor;
	return targetMajor === major && targetMinor === minor;
}

/** True when a source is a plain npm install spec rather than a transport URL or path. */
export function isNpmSource(source) {
	return npmSpec(source) !== null;
}

/**
 * Which npm bundles the registry says are newer, and only where the manifest's
 * own range would actually pick that version — an exact pin is someone's
 * decision, and this plugin does not overrule it. The `spec` returned is the
 * manifest's source, so an update re-installs under the same range semantics
 * rather than rewriting the manifest behind the user's back.
 */
export function planUpdates(entries, installedVersions, latestByName, opts = {}) {
	const self = opts.selfName ?? null;
	const updates = [];
	for (const entry of entries ?? []) {
		if (!entry || typeof entry.name !== 'string' || entry.name === self) continue;
		if (npmSpec(entry.source) === null) continue;
		const from = installedVersions?.[entry.name];
		const to = latestByName?.[entry.name];
		if (typeof from !== 'string' || typeof to !== 'string') continue;
		if (semverCompare(to, from) <= 0) continue;
		if (!rangeAccepts(entry.source, to)) continue;
		updates.push({ name: entry.name, from, to, spec: entry.source });
	}
	return updates;
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
	updatePolicy: null,
	updates: null,
	lastUpdateCheckAt: null,
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
