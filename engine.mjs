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
} from './core.mjs';

const BASELINE = 'baseline.json';
const STATE = 'state.json';

function render(manifest) {
	return JSON.stringify(manifest, null, 2);
}

function sameBundles(a, b) {
	if (a.length !== b.length) return false;
	const byName = new Map(a.map(e => [e.name, e]));
	for (const entry of b) {
		const mine = byName.get(entry.name);
		if (!mine || mine.source !== entry.source || mine.enabled !== entry.enabled) return false;
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
 *   log(level: string, msg: string): void, machineName: string, now(): string
 * }}
 */
export function createSyncEngine({ git, pm, io, log, machineName, now }) {
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
			if (result && result.ok === false) {
				errors.push(`${label} ${name}: ${result.error ?? result.message ?? 'pluginManager reported failure'}`);
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
		const plan = planConvergence(local, remote);
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

	async function pull() {
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
		return outcome(didSomething ? 'converged' : 'nochange', { applied, remoteState: remote });
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
		const diff = computeDiff(baseline?.bundles ?? [], local);
		if (diff.added.length + diff.removed.length + diff.changed.length === 0) {
			return outcome('nochange', { remoteState: remote });
		}

		const intent = render(applyDiff(remote, diff, machineName, now()));
		const summary = `+${diff.added.length} ~${diff.changed.length} -${diff.removed.length}`;
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
			const replayed = render(applyDiff(latest, diff, machineName, now()));
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
			applied: [...diff.added.map(e => e.name), ...diff.changed.map(e => e.name), ...diff.removed],
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

	return { pull, push, bootstrap, confirmEmpty };
}
