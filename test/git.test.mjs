import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGitOps, runGit } from '../git.mjs';

function fakeSubprocess(responses = []) {
	const spawns = [];
	let next = 0;
	return {
		spawns,
		async resolveExecutable(name) { return `C:/fake-git/${name}.exe`; },
		spawn(spec) {
			const resp = responses[next++] ?? { code: 0, stdout: '', stderr: '' };
			const stdout = resp.stdout ?? '';
			const stderr = resp.stderr ?? '';
			const reader = (text) => ({
				readFrom: (off) => off === 0
					? { text, nextOffset: text.length, lossy: false }
					: { text: '', nextOffset: off, lossy: false },
			});
			const entry = {
				spec,
				stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
				collected: { stdout: reader(stdout), stderr: reader(stderr) },
				done: Promise.resolve({ exitCode: resp.code ?? 0, signal: resp.signal ?? null }),
				terminate() {},
				async waitForExit() { return true; },
			};
			spawns.push(entry);
			return entry;
		},
	};
}

async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), 'plugin-sync-git-'));
	return { dir, async cleanup() { await rm(dir, { recursive: true, force: true }); } };
}

function argvOf(spawns) {
	return spawns.map(s => s.spec.argv.slice(1));
}

// --- runGit ------------------------------------------------------------------

test('runGit spawns the resolved git executable in collect mode and returns outputs', async () => {
	const subprocess = fakeSubprocess([{ code: 0, stdout: 'abc123\n', stderr: '' }]);
	const result = await runGit(subprocess, ['rev-parse', 'HEAD'], { cwd: 'C:/repo' });
	assert.equal(result.code, 0);
	assert.equal(result.stdout, 'abc123\n');
	assert.equal(result.stderr, '');
	const spec = subprocess.spawns[0].spec;
	assert.deepEqual(spec.argv, ['C:/fake-git/git.exe', 'rev-parse', 'HEAD']);
	assert.equal(spec.cwd, 'C:/repo');
	assert.equal(spec.stdio.stdin, 'ignore');
	assert.equal(typeof spec.stdio.stdout, 'object');
});

// --- ensureWorkspace ----------------------------------------------------------

test('ensureWorkspace inits and adds the remote when .git is absent', async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const subprocess = fakeSubprocess();
		const ops = createGitOps({ subprocess, dir, repo: 'git@github.com:me/x.git', branch: 'main', log() {} });
		await ops.ensureWorkspace();
		assert.deepEqual(argvOf(subprocess.spawns), [
			['init', '-q'],
			['remote', 'add', 'origin', 'git@github.com:me/x.git'],
			['fetch', '-q', 'origin', 'main'],
			['reset', '-q', '--hard', 'origin/main'],
		]);
		for (const spawn of subprocess.spawns) {
			assert.equal(spawn.spec.cwd, dir);
			assert.equal(spawn.spec.env.GIT_TERMINAL_PROMPT, '0');
		}
	} finally { await cleanup(); }
});

test('ensureWorkspace fetches and hard-resets when .git already exists', async () => {
	const { dir, cleanup } = await tempDir();
	try {
		await mkdir(join(dir, '.git'));
		const subprocess = fakeSubprocess();
		const ops = createGitOps({ subprocess, dir, repo: 'git@github.com:me/x.git', branch: 'main', log() {} });
		await ops.ensureWorkspace();
		assert.deepEqual(argvOf(subprocess.spawns), [
			['fetch', '-q', 'origin', 'main'],
			['reset', '-q', '--hard', 'origin/main'],
		]);
	} finally { await cleanup(); }
});

test('ensureWorkspace survives a failing fetch (fresh empty remote branch)', async () => {
	const { dir, cleanup } = await tempDir();
	try {
		await mkdir(join(dir, '.git'));
		const subprocess = fakeSubprocess([
			{ code: 128, stdout: '', stderr: "fatal: couldn't find remote ref main" },
		]);
		const logs = [];
		const ops = createGitOps({ subprocess, dir, repo: 'x', branch: 'main', log: (l, m) => logs.push([l, m]) });
		await ops.ensureWorkspace();
		assert.deepEqual(argvOf(subprocess.spawns), [['fetch', '-q', 'origin', 'main']]);
		assert.ok(logs.length > 0);
	} finally { await cleanup(); }
});

// --- readRemote ---------------------------------------------------------------

test('readRemote returns the blob text on success', async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const text = '{"formatVersion":1}';
		const subprocess = fakeSubprocess([{ code: 0, stdout: text, stderr: '' }]);
		const ops = createGitOps({ subprocess, dir, repo: 'x', branch: 'main', log() {} });
		assert.equal(await ops.readRemote(), text);
		assert.deepEqual(argvOf(subprocess.spawns), [['show', 'origin/main:plugin-sync.json']]);
	} finally { await cleanup(); }
});

test('readRemote maps missing path and missing ref to null', async () => {
	const { dir, cleanup } = await tempDir();
	try {
		for (const stderr of [
			"fatal: path 'plugin-sync.json' does not exist in 'origin/main'",
			"fatal: invalid object name 'origin/main'.",
		]) {
			const subprocess = fakeSubprocess([{ code: 128, stdout: '', stderr }]);
			const ops = createGitOps({ subprocess, dir, repo: 'x', branch: 'main', log() {} });
			assert.equal(await ops.readRemote(), null, stderr);
		}
	} finally { await cleanup(); }
});

test('readRemote rejects on a hard git error', async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const subprocess = fakeSubprocess([{ code: 128, stdout: '', stderr: 'fatal: unable to connect to origin' }]);
		const ops = createGitOps({ subprocess, dir, repo: 'x', branch: 'main', log() {} });
		await assert.rejects(ops.readRemote(), /unable to connect/);
	} finally { await cleanup(); }
});

// --- commitPush ---------------------------------------------------------------

test('commitPush writes the manifest, commits, pushes and reports pushed', async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const subprocess = fakeSubprocess();
		const ops = createGitOps({ subprocess, dir, repo: 'x', branch: 'main', log() {} });
		const result = await ops.commitPush('{"formatVersion":1}', 'sync: me +1 @ now');
		assert.equal(result, 'pushed');
		assert.equal(await readFile(join(dir, 'plugin-sync.json'), 'utf8'), '{"formatVersion":1}');
		assert.deepEqual(argvOf(subprocess.spawns), [
			['add', 'plugin-sync.json'],
			['commit', '-q', '-m', 'sync: me +1 @ now'],
			['push', '-q', 'origin', 'HEAD:main'],
		]);
	} finally { await cleanup(); }
});

test('commitPush reports rejected when the push fails', async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const subprocess = fakeSubprocess([
			{ code: 0 }, { code: 0 },
			{ code: 1, stdout: '', stderr: 'Updates were rejected because the remote contains work that you do not have locally.' },
		]);
		const ops = createGitOps({ subprocess, dir, repo: 'x', branch: 'main', log() {} });
		assert.equal(await ops.commitPush('x', 'm'), 'rejected');
	} finally { await cleanup(); }
});

test('commitPush treats an empty commit (already in sync) as pushed without pushing', async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const subprocess = fakeSubprocess([
			{ code: 0 },
			{ code: 1, stdout: '', stderr: 'On branch main\nnothing to commit, working tree clean' },
		]);
		const logs = [];
		const ops = createGitOps({ subprocess, dir, repo: 'x', branch: 'main', log: (l, m) => logs.push([l, m]) });
		assert.equal(await ops.commitPush('x', 'm'), 'pushed');
		assert.deepEqual(argvOf(subprocess.spawns), [['add', 'plugin-sync.json'], ['commit', '-q', '-m', 'm']]);
	} finally { await cleanup(); }
});

// --- local state files --------------------------------------------------------

test('writeLocal and readLocal round-trip files under the sync dir; missing reads null', async () => {
	const { dir, cleanup } = await tempDir();
	try {
		const subprocess = fakeSubprocess();
		const ops = createGitOps({ subprocess, dir, repo: 'x', branch: 'main', log() {} });
		assert.equal(await ops.readLocal('baseline.json'), null);
		await ops.writeLocal('baseline.json', 'hello');
		assert.equal(await ops.readLocal('baseline.json'), 'hello');
	} finally { await cleanup(); }
});
