// dsh-plugin-sync — system git adapter over the injected `subprocess` service.
//
// Contract facts (verified via cordis_inspect_query Service subprocess):
//   resolveExecutable(command, env?, signal?) → canonical executable path
//   spawn({argv, cwd, stdio, graceMs, signal?, env?}) → SubprocessHandle
//     stdio: { stdin: 'ignore', stdout: {maxBytes}, stderr: {maxBytes} } → collect mode
//     handle.done → { exitCode, signal }; handle.collected.{stdout,stderr}.readFrom(offset)
//       → { text, nextOffset, lossy } (offset-based, non-consuming)
//
// Credential hardening: GIT_TERMINAL_PROMPT=0 (no interactive prompts, which
// would hang the desktop app when credentials are missing). Credential output
// is never logged verbatim beyond git's own stderr.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MANIFEST = 'plugin-sync.json';
const MAX_COLLECT = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const GRACE_MS = 5_000;

const GIT_ENV = Object.freeze({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' });

/**
 * Drain one collected output reader from offset 0 to the end.
 */
function drain(reader) {
	if (!reader) return '';
	let text = '';
	let offset = 0;
	for (;;) {
		const chunk = reader.readFrom(offset);
		if (!chunk.text) break;
		text += chunk.text;
		offset = chunk.nextOffset;
		if (chunk.lossy) break;
	}
	return text;
}

/**
 * `-c` overrides routing Git's HTTP transport through a proxy. Desktop hosts
 * keep the proxy in system settings (which Git ignores) and hand the child a
 * scrubbed environment, so naming it per invocation is the only reliable way.
 * SSH remotes are untouched: they proxy through ssh's own configuration.
 */
function proxyArgs(proxy) {
	if (!proxy) return [];
	return ['-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`];
}

/**
 * Run one git command. Returns { code, stdout, stderr }; never throws for
 * non-zero exits (spawn/timeout failures surface as code: null with a
 * synthetic stderr note). `opts.proxy` routes HTTP/HTTPS transports through
 * that proxy.
 */
export async function runGit(subprocess, args, opts = {}) {
	const env = { ...(opts.env ?? GIT_ENV) };
	const gitPath = await subprocess.resolveExecutable('git', env);
	const signal = AbortSignal.timeout(opts.timeoutMs ?? GIT_TIMEOUT_MS);
	const handle = subprocess.spawn({
		argv: [gitPath, ...proxyArgs(opts.proxy), ...args],
		cwd: opts.cwd,
		stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_COLLECT }, stderr: { maxBytes: MAX_COLLECT } },
		graceMs: GRACE_MS,
		signal,
		env,
	});
	let exitCode = null;
	let spawnError = null;
	let timedOut = false;
	try {
		const outcome = await handle.done;
		exitCode = outcome?.exitCode ?? null;
	} catch (error) {
		spawnError = error;
		timedOut = signal.aborted;
	}
	const stdout = drain(handle.collected?.stdout);
	const stderr = drain(handle.collected?.stderr);
	if (spawnError) {
		const note = timedOut ? `timed out after ${opts.timeoutMs ?? GIT_TIMEOUT_MS}ms` : (spawnError?.message ?? String(spawnError));
		return { code: null, stdout, stderr: stderr ? `${stderr}\n${note}` : note };
	}
	return { code: exitCode, stdout, stderr };
}

/**
 * GitOps for one repo/branch inside the machine-local sync directory.
 * @param opts {{ subprocess: object, dir: string, repo: string, branch: string,
 *               proxy?: string|null, log(level: string, msg: string): void }}
 */
export function createGitOps({ subprocess, dir, repo, branch, proxy = null, log }) {
	const ref = `origin/${branch}`;
	// One proxy-aware runner, so every verb below reaches the network the same
	// way instead of repeating the proxy at each call site.
	const git = (spawner, args, opts = {}) => runGit(spawner, args, { ...opts, ...(proxy ? { proxy } : {}) });

	async function gitExists(path) {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Prepare the machine-local working copy: init + remote on first run,
	 * then fetch + hard reset on every run. A missing remote branch is
	 * tolerated (freshly seeded or empty repo); other fetch failures are
	 * logged and left to readRemote/push to surface.
	 */
	async function ensureWorkspace() {
		await mkdir(dir, { recursive: true });
		if (!(await gitExists(join(dir, '.git')))) {
			const init = await git(subprocess, ['init', '-q'], { cwd: dir });
			if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`);
			const remote = await git(subprocess, ['remote', 'add', 'origin', repo], { cwd: dir });
			if (remote.code !== 0 && !/already exists/i.test(remote.stderr)) {
				throw new Error(`git remote add failed: ${remote.stderr}`);
			}
		}
		const fetched = await git(subprocess, ['fetch', '-q', 'origin', branch], { cwd: dir });
		if (fetched.code !== 0) {
			log('warn', `git fetch failed (will retry next sync): ${fetched.stderr || `exit ${fetched.code}`}`);
			return;
		}
		const reset = await git(subprocess, ['reset', '-q', '--hard', ref], { cwd: dir });
		if (reset.code !== 0) log('warn', `git reset failed: ${reset.stderr}`);
	}

	/**
	 * Read plugin-sync.json from the remote branch, or null when the file or
	 * the branch does not exist upstream (verified git 2.55 wording:
	 * "does not exist in" / "invalid object name"). Throws on hard errors.
	 */
	async function readRemote() {
		const result = await git(subprocess, ['show', `${ref}:${MANIFEST}`], { cwd: dir });
		if (result.code === 0) return result.stdout;
		if (/does not exist|invalid object name/i.test(result.stderr)) return null;
		throw new Error(`git show failed: ${result.stderr || `exit ${result.code}`}`);
	}

	/**
	 * Commit the manifest text and push to the branch. 'rejected' on push
	 * failure; an empty commit (already in sync) counts as 'pushed'.
	 */
	async function commitPush(text, message) {
		await writeLocal(MANIFEST, text);
		const added = await git(subprocess, ['add', MANIFEST], { cwd: dir });
		if (added.code !== 0) throw new Error(`git add failed: ${added.stderr}`);
		const committed = await git(subprocess, ['commit', '-q', '-m', message], {
			cwd: dir,
			env: {
				...GIT_ENV,
				GIT_AUTHOR_NAME: 'DSH Plugin Sync',
				GIT_AUTHOR_EMAIL: 'dsh-plugin-sync@users.noreply.local',
				GIT_COMMITTER_NAME: 'DSH Plugin Sync',
				GIT_COMMITTER_EMAIL: 'dsh-plugin-sync@users.noreply.local',
			},
		});
		if (committed.code !== 0) {
			if (/nothing to commit/i.test(committed.stderr)) {
				log('info', 'nothing to commit; remote already matches');
				return 'pushed';
			}
			throw new Error(`git commit failed: ${committed.stderr}`);
		}
		const pushed = await git(subprocess, ['push', '-q', 'origin', `HEAD:${branch}`], { cwd: dir });
		if (pushed.code !== 0) {
			log('warn', `git push rejected: ${pushed.stderr || `exit ${pushed.code}`}`);
			return 'rejected';
		}
		return 'pushed';
	}

	async function readLocal(path) {
		try {
			return await readFile(join(dir, path), 'utf8');
		} catch (error) {
			if (error?.code === 'ENOENT') return null;
			throw error;
		}
	}

	async function writeLocal(path, text) {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, path), text, 'utf8');
	}

	return { ensureWorkspace, readRemote, commitPush, readLocal, writeLocal };
}
