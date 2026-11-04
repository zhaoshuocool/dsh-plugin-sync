// dsh-plugin-sync — injectable sync engine.
//
// Orchestrates convergence between pluginManager state and the remote
// manifest over GitOps. All side effects arrive through deps; single-flight
// scheduling is the outer layer's job (Task 5), this engine is re-entrant and
// re-reads the remote at the start of every method.

import {
	bundlesFromList,
	parseManifestJson,
	computeDiff,
	applyDiff,
	mergeUnion,
	planConvergence,
	isShrinkingToEmpty,
	sourcesEquivalent,
	installedVersionsFromList,
	planUpdates,
	isNpmSource,
	planConfigApply,
	planConfigPush,
	mergeManifestConfig,
} from './core.mjs';

const BASELINE = 'baseline.json';
const STATE = 'state.json';
const UPDATE_STATE = 'update-state.json';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function render(manifest) {
	return JSON.stringify(manifest, null, 2);
}

function sameBundles(a, b) {
	if (a.length !== b.length) return false;
	const byName = new Map(a.map(e => [e.name, e]));
	for (const entry of b) {
		const mine = byName.get(entry.name);
		if (!mine || !sourcesEquivalent(mine.source, entry.source) || mine.enabled !== entry.enabled) return false;
	}
	return true;
}

/**
 * @param deps {{
 *   git: { ensureWorkspace(): Promise<void>, readRemote(): Promise<string|null>,
 *          commitPush(text: string, message: string): Promise<'pushed'|'rejected'>,
 *          readLocal(path: string): Promise<string|null>, writeLocal(path: string, text: string): Promise<void> },
 *   pm: { listBundles(): Promise<object[]>, installBundle(spec: string): Promise<object>,
 *         removeBundle(name: string): Promise<object>, setBundleEnabled(name: string, enabled: boolean): Promise<object> },
 *   io: { readJson(path: string): Promise<object|null>, writeJson(path: string, obj: object): Promise<void> },
 *   log(level: string, msg: string): void, machineName: string, now(): string,
 *   selfName?: string (the sync bundle's own name; excluded from self-mutating actions),
 *   updatePolicy?: 'off' | 'check' | 'auto',
 *   checkRegistry?: (names: string[]) => Promise<{ ok: {name,latest}[], failed: {name,error}[] }>
 * }}
 */
export function createSyncEngine({
	git, pm, io, log, machineName, now,
	selfName = null,
	updatePolicy = 'off',
	checkRegistry = null,
	configEditor = null,
}) {
	let emptyConfirmed = false;

	function outcome(action, { applied = [], errors = [], remoteState } = {}) {
		return { action, applied, errors, ...(remoteState !== undefined ? { remoteState } : {}) };
	}

	function asManifest(bundles, updatedAt = now(), updatedBy = machineName) {
		return { formatVersion: 1, bundles, updatedAt, updatedBy };
	}

	async function localEntries() {
		return bundlesFromList(await pm.listBundles());
	}

	async function readBaselineManifest() {
		const text = await git.readLocal(BASELINE);
		if (text == null) return { text: null, manifest: null };
		const result = parseManifestJson(text);
		if (!result.ok) return { text, manifest: null };
		return { text, manifest: result.manifest };
	}

	/** One pluginManager call with uniform failure capture. */
	async function pmCall(applied, errors, label, name, run) {
		try {
			const result = await run();
			// pluginManager methods resolve ChangeResult; treat a reported
			// failure (ok:false, application:'failed', or an error record) as
			// an error. An install racing an already-present package is fine.
			const failed = result
				&& (result.ok === false
					|| (result.application === 'failed' && result.error?.code !== 'already-installed')
					|| (result.error && result.application === undefined));
			if (failed) {
				const detail = result.error
					? (typeof result.error === 'string'
						? result.error
						: `${result.error.code ?? 'pluginManager failure'}${result.error.diagnostic ? `: ${result.error.diagnostic}` : ''}`)
					: (result.message ?? 'pluginManager reported failure');
				errors.push(`${label} ${name}: ${detail}`);
				return false;
			}
			applied.push(name);
			return true;
		} catch (error) {
			errors.push(`${label} ${name}: ${error?.message ?? String(error)}`);
			return false;
		}
	}

	/**
	 * Execute a convergence plan against pluginManager.
	 * Order: install → reinstall → enable/disable → remove — additions before
	 * subtractions, to shrink the window where an interrupted run leaves the
	 * profile with less than it had.
	 */
	async function converge(local, remote, applied, errors) {
		const plan = planConvergence(local, remote, { selfName });
		const remoteByName = new Map(remote.bundles.map(e => [e.name, e]));
		for (const entry of plan.install) {
			const ok = await pmCall(applied, errors, 'install', entry.name, () => pm.installBundle(entry.source));
			if (ok && remoteByName.get(entry.name)?.enabled === false) {
				await pmCall(applied, errors, 'disable', entry.name, () => pm.setBundleEnabled(entry.name, false));
			}
		}
		for (const entry of plan.reinstall) {
			const removed = await pmCall(applied, errors, 'remove', entry.name, () => pm.removeBundle(entry.name));
			if (removed) {
				const ok = await pmCall(applied, errors, 'install', entry.name, () => pm.installBundle(entry.source));
				if (ok && remoteByName.get(entry.name)?.enabled === false) {
					await pmCall(applied, errors, 'disable', entry.name, () => pm.setBundleEnabled(entry.name, false));
				}
			}
		}
		for (const name of plan.enable) {
			await pmCall(applied, errors, 'enable', name, () => pm.setBundleEnabled(name, true));
		}
		for (const name of plan.disable) {
			await pmCall(applied, errors, 'disable', name, () => pm.setBundleEnabled(name, false));
		}
		for (const name of plan.remove) {
			await pmCall(applied, errors, 'remove', name, () => pm.removeBundle(name));
		}
		return plan;
	}

	// --- update checking -----------------------------------------------------

	let updateState = null;

	async function loadUpdateState() {
		if (updateState !== null) return updateState;
		try {
			const saved = await io.readJson(UPDATE_STATE);
			updateState = saved && typeof saved === 'object' ? saved : {};
		} catch (error) {
			log('warn', `update state read failed: ${error?.message ?? error}`);
			updateState = {};
		}
		return updateState;
	}

	async function saveUpdateState(state) {
		updateState = state;
		try {
			await io.writeJson(UPDATE_STATE, state);
		} catch (error) {
			log('warn', `update state write failed: ${error?.message ?? error}`);
		}
	}

	function dueForCheck(state) {
		if (!state.checkedAt) return true;
		const then = Date.parse(state.checkedAt);
		const at = Date.parse(now());
		if (!Number.isFinite(then) || !Number.isFinite(at)) return true;
		return at - then >= UPDATE_CHECK_INTERVAL_MS;
	}

	/** Ask the registry which npm bundles have a newer version. Mutates nothing. */
	async function checkForUpdates(rows, { force = false } = {}) {
		const state = await loadUpdateState();
		if (!force && !dueForCheck(state)) return { updates: state.updates ?? [], cached: true };
		const entries = bundlesFromList(rows);
		const versions = installedVersionsFromList(rows);
		const names = entries
			.filter(entry => isNpmSource(entry.source) && entry.name !== selfName && versions[entry.name])
			.map(entry => entry.name);
		if (names.length === 0) {
			await saveUpdateState({ ...state, checkedAt: now(), updates: [] });
			return { updates: [] };
		}
		let registry;
		try {
			registry = await checkRegistry(names);
		} catch (error) {
			log('warn', `update check failed: ${error?.message ?? error}`);
			return { updates: state.updates ?? [], error: error?.message ?? String(error) };
		}
		const latestByName = {};
		for (const item of registry?.ok ?? []) latestByName[item.name] = item.latest;
		for (const failure of registry?.failed ?? []) log('warn', `update check: ${failure.name}: ${failure.error}`);
		const attempted = state.attempted ?? {};
		const updates = planUpdates(entries, versions, latestByName, { selfName })
			.filter(update => attempted[update.name]?.to !== update.to);
		await saveUpdateState({ ...state, checkedAt: now(), updates });
		return { updates };
	}

	/**
	 * Move bundles to the newer version: remove, then install under the source the
	 * manifest already carries. A fully successful attempt is recorded, so a
	 * registry that keeps naming a version this machine cannot resolve does not
	 * buy the same remove+install on every cycle.
	 */
	async function applyUpdateList(list, applied, errors) {
		for (const update of list) {
			const steps = [];
			const removed = await pmCall(steps, errors, 'update', update.name, () => pm.removeBundle(update.name));
			if (removed) await pmCall(steps, errors, 'update', update.name, () => pm.installBundle(update.spec));
			if (steps.length !== 2) continue;
			applied.push(update.name);
			const state = await loadUpdateState();
			await saveUpdateState({
				...state,
				attempted: { ...(state.attempted ?? {}), [update.name]: { to: update.to, at: now() } },
			});
			log('info', `updated ${update.name} ${update.from} → ${update.to}`);
		}
	}

	// --- config whitelisting -------------------------------------------------

	// Plugins whose config write the host refused (a home patch or command-line
	// overlay owns that entry). Their local value must never be pushed: pushing
	// would overwrite the shared whitelist with a value this machine cannot set.
	const configBlocked = new Set();

	function wantsConfig(remote) {
		return configEditor !== null
			&& typeof configEditor.configuration === 'function'
			&& typeof configEditor.edit === 'function'
			&& (remote?.bundles ?? []).some(entry => entry.config !== undefined);
	}

	/** The values this machine's own profile patch explicitly sets, by plugin name. */
	async function localConfigOverrides() {
		if (configEditor === null || typeof configEditor.configuration !== 'function') return {};
		let rows;
		try {
			rows = await configEditor.configuration();
		} catch (error) {
			log('warn', `configuration read failed: ${error?.message ?? error}`);
			return {};
		}
		const overrides = {};
		for (const row of rows ?? []) {
			const name = row?.entry?.options?.name;
			if (typeof name === 'string' && row.override && typeof row.override === 'object') overrides[name] = row.override;
		}
		return overrides;
	}

	/**
	 * Write the whitelisted values the manifest carries. One `edit` per plugin:
	 * each edit is a Loader reconcile, so batching a plugin's keys keeps the
	 * restart count at one per plugin instead of one per key.
	 */
	async function applyConfigs(remote, applied, errors, baselineBundles = []) {
		if (!wantsConfig(remote)) return 0;
		let rows;
		try {
			rows = await configEditor.configuration();
		} catch (error) {
			log('warn', `configuration read failed: ${error?.message ?? error}`);
			return 0;
		}
		let count = 0;
		for (const plan of planConfigApply(rows, remote.bundles, { selfName, baselineBundles })) {
			const ok = await pmCall(applied, errors, 'config', plan.name,
				() => configEditor.edit(plan.entry, current => ({ ...(current ?? {}), ...plan.values })));
			if (!ok) configBlocked.add(plan.name);
			else configBlocked.delete(plan.name);
			if (!ok) continue;
			count += 1;
			log('info', `config: ${plan.name} ${Object.keys(plan.values).join(', ')} set to the manifest value`);
		}
		return count;
	}

	function commitMessage(kind, summary) {
		return `sync(${kind}): ${machineName} ${summary} @ ${now()}`;
	}

	async function rememberState(manifest) {
		try {
			await io.writeJson(STATE, { remote: manifest, seenAt: now(), by: machineName });
		} catch (error) {
			log('warn', `state.json write failed: ${error?.message ?? error}`);
		}
	}

	/** Seed/push a manifest built from local state; returns an outcome. */
	async function seedAndPush(remoteState) {
		const local = await localEntries();
		const text = render(asManifest(local));
		const result = await git.commitPush(text, commitMessage('seed', `seeded ${local.length} bundle(s)`));
		if (result !== 'pushed') {
			return outcome('error', { errors: ['seed push rejected: remote moved during bootstrap'], remoteState });
		}
		await git.writeLocal(BASELINE, text);
		await rememberState(parseManifestJson(text).manifest);
		return outcome('bootstrapped', { applied: local.map(e => e.name), remoteState });
	}

	async function syncOnce() {
		const confirmed = emptyConfirmed;
		emptyConfirmed = false;
		await git.ensureWorkspace();
		const text = await git.readRemote();
		const { text: baselineText, manifest: baseline } = await readBaselineManifest();

		if (text === null) {
			if (baselineText === null) {
				log('info', 'remote has no manifest yet; seeding from local state');
				return await seedAndPush(undefined);
			}
			log('warn', 'remote manifest vanished after bootstrap; awaiting a mode choice');
			return outcome('await-choose', { errors: ['remote manifest is missing'] });
		}

		const parsed = parseManifestJson(text);
		if (!parsed.ok) {
			log('error', `remote manifest invalid: ${parsed.error}`);
			return outcome('error', { errors: [`remote manifest invalid: ${parsed.error}`] });
		}
		const remote = parsed.manifest;

		const local = await localEntries();

		if (baselineText === null) {
			if (sameBundles(local, remote.bundles)) {
				await git.writeLocal(BASELINE, text);
				await rememberState(remote);
				return outcome('nochange', { remoteState: remote });
			}
			log('info', 'first sync: local and remote differ; awaiting mode choice');
			return outcome('await-choose', { remoteState: remote });
		}

		if (isShrinkingToEmpty(local.length, remote.bundles) && !confirmed) {
			log('warn', 'remote manifest is empty while local has bundles; awaiting confirm');
			return outcome('await-empty-confirm', { remoteState: remote });
		}

		const applied = [];
		const errors = [];
		const plan = await converge(local, remote, applied, errors);
		const didSomething = plan.install.length + plan.reinstall.length + plan.enable.length + plan.disable.length + plan.remove.length > 0;
		if (errors.length === 0) {
			await git.writeLocal(BASELINE, text);
			await rememberState(remote);
		}
		if (errors.length > 0) {
			log('error', `convergence completed with ${errors.length} error(s)`);
			return outcome('error', { applied, errors, remoteState: remote });
		}
		// Config only after a clean convergence: a half-converged profile should
		// not also get its plugins reconfigured underneath it.
		const configCount = await applyConfigs(remote, applied, errors, baseline?.bundles ?? []);
		if (errors.length > 0) {
			log('error', `config apply completed with ${errors.length} error(s)`);
			return outcome('error', { applied, errors, remoteState: remote });
		}
		return outcome(didSomething || configCount > 0 ? 'converged' : 'nochange', { applied, remoteState: remote });
	}

	/**
	 * A sync cycle, then the update pass when the policy asks for one. The pass is
	 * kept out of the convergence path on purpose: an available update never
	 * changes what convergence decided, and it does not act at all when the
	 * convergence itself failed.
	 */
	async function pull() {
		const result = await syncOnce();
		if (updatePolicy === 'off' || typeof checkRegistry !== 'function') return result;
		let rows;
		try {
			rows = await pm.listBundles();
		} catch {
			return result;
		}
		const { updates } = await checkForUpdates(rows, { force: false });
		const applied = [...(result.applied ?? [])];
		const errors = [...(result.errors ?? [])];
		if (updatePolicy === 'auto' && updates.length > 0 && errors.length === 0) {
			await applyUpdateList(updates, applied, errors);
		}
		return { ...result, applied, errors, updates };
	}

	/** Force a registry check now, bypassing the daily cache. */
	async function checkUpdates() {
		if (typeof checkRegistry !== 'function') return { updates: [], error: 'no registry client' };
		const rows = await pm.listBundles();
		return await checkForUpdates(rows, { force: true });
	}

	/**
	 * Apply the named available updates (all of them when `names` is empty). A
	 * stored list is used when it is current; otherwise a check runs first, so the
	 * Settings button works straight after a restart.
	 */
	async function applyUpdates(names = []) {
		if (typeof checkRegistry !== 'function') return outcome('error', { errors: ['no registry client'] });
		const state = await loadUpdateState();
		let known = state.updates ?? [];
		const wanted = names.length > 0 ? known.filter(update => names.includes(update.name)) : known;
		if (wanted.length === 0) {
			known = (await checkUpdates()).updates ?? [];
		}
		const picked = names.length > 0 ? known.filter(update => names.includes(update.name)) : known;
		const applied = [];
		const errors = [];
		await applyUpdateList(picked, applied, errors);
		return {
			action: applied.length > 0 ? 'updated' : 'nochange',
			applied,
			errors,
			updates: known,
		};
	}

	async function push() {
		await git.ensureWorkspace();
		const text = await git.readRemote();
		if (text === null) return await seedAndPush();

		const parsed = parseManifestJson(text);
		if (!parsed.ok) {
			return outcome('error', { errors: [`remote manifest invalid: ${parsed.error}`] });
		}
		const remote = parsed.manifest;

		const { manifest: baseline } = await readBaselineManifest();
		const local = await localEntries();
		if (!baseline) {
			// A watcher or manual push cannot decide bootstrap policy for the user.
			if (!sameBundles(local, remote.bundles)) return outcome('await-choose', { remoteState: remote });
			await git.writeLocal(BASELINE, text);
			await rememberState(remote);
			return outcome('nochange', { remoteState: remote });
		}
		const diff = computeDiff(baseline.bundles, local);
		// A config-only change is still a change: the whitelist lives in the
		// manifest, so this machine disagreeing about a whitelisted key has to
		// reach the remote rather than sit in its own patch forever.
		const configPlans = wantsConfig(remote)
			? planConfigPush(remote.bundles, await localConfigOverrides(), { baselineBundles: baseline?.bundles ?? [] })
				.filter(plan => !configBlocked.has(plan.name))
			: [];
		if (diff.added.length + diff.removed.length + diff.changed.length === 0 && configPlans.length === 0) {
			return outcome('nochange', { remoteState: remote });
		}

		const intent = render(mergeManifestConfig(applyDiff(remote, diff, machineName, now()), remote.bundles, configPlans));
		const summary = `+${diff.added.length} ~${diff.changed.length} -${diff.removed.length}`
			+ (configPlans.length > 0 ? ` cfg${configPlans.length}` : '');
		const message = commitMessage('push', summary);
		let result = await git.commitPush(intent, message);
		let latest = remote;
		let committed = intent;
		if (result === 'rejected') {
			log('warn', 'push rejected (remote advanced); replaying intent once');
			const refetch = parseManifestJson(await git.readRemote() ?? '');
			if (!refetch.ok) {
				return outcome('error', { errors: ['push rejected and remote could not be re-read'], remoteState: remote });
			}
			latest = refetch.manifest;
			const replayConfigPlans = planConfigPush(latest.bundles,
				Object.fromEntries(configPlans.map(plan => [plan.name, plan.config])),
				{ baselineBundles: baseline?.bundles ?? [] });
			const replayed = render(mergeManifestConfig(
				applyDiff(latest, diff, machineName, now()), latest.bundles, replayConfigPlans));
			committed = replayed;
			result = await git.commitPush(replayed, commitMessage('push', `${summary} (replayed)`));
			if (result === 'pushed') {
				await git.writeLocal(BASELINE, replayed);
			}
		} else if (result === 'pushed') {
			await git.writeLocal(BASELINE, intent);
		}
		if (result !== 'pushed') {
			return outcome('error', { errors: ['push still rejected after replay'], remoteState: latest });
		}
		await rememberState(parseManifestJson(committed).manifest ?? latest);
		return outcome('pushed', {
			applied: [...diff.added.map(e => e.name), ...diff.changed.map(e => e.name), ...diff.removed,
				...configPlans.map(e => e.name)],
			remoteState: latest,
		});
	}

	async function bootstrap(mode) {
		await git.ensureWorkspace();
		const text = await git.readRemote();
		if (text === null) return await seedAndPush();

		const parsed = parseManifestJson(text);
		if (!parsed.ok) {
			return outcome('error', { errors: [`remote manifest invalid: ${parsed.error}`] });
		}
		const remote = parsed.manifest;
		const local = await localEntries();

		if (sameBundles(local, remote.bundles)) {
			await git.writeLocal(BASELINE, text);
			await rememberState(remote);
			return outcome('nochange', { remoteState: remote });
		}

		if (mode === 'merge') {
			const union = mergeUnion(remote, asManifest(local), machineName, now());
			const unionText = render(union);
			const result = await git.commitPush(unionText, commitMessage('bootstrap', `merged ${union.bundles.length} bundle(s)`));
			if (result !== 'pushed') {
				return outcome('error', { errors: ['merge push rejected; run sync again'], remoteState: remote });
			}
			await git.writeLocal(BASELINE, unionText);
			await rememberState(union);
			return outcome('bootstrapped', { applied: union.bundles.map(e => e.name), remoteState: union });
		}

		if (mode === 'remote') {
			const applied = [];
			const errors = [];
			await converge(local, remote, applied, errors);
			if (errors.length === 0) {
				await git.writeLocal(BASELINE, text);
				await rememberState(remote);
				return outcome('converged', { applied, remoteState: remote });
			}
			return outcome('error', { applied, errors, remoteState: remote });
		}

		return outcome('await-choose', { remoteState: remote });
	}

	/** One-shot: accept the next convergence onto an empty remote manifest. */
	async function confirmEmpty() {
		emptyConfirmed = true;
		return await pull();
	}

	return { pull, push, bootstrap, confirmEmpty, checkUpdates, applyUpdates };
}
