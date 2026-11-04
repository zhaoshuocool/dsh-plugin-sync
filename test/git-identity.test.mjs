import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitOps } from '../git.mjs';

test('automatic commits succeed without a user Git identity or global config', async () => {
	const root = mkdtempSync(join(tmpdir(), 'sync-identity-'));
	const dir = join(root, 'work');
	const remote = join(root, 'remote.git');
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'absent.gitconfig') };
	for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[key];
	const run = (args, cwd = root, extra = {}) => spawnSync('git', args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
	assert.equal(run(['init', '--bare', remote]).status, 0);
	const subprocess = {
		async resolveExecutable() { return 'git'; },
		spawn(spec) {
			const result = run(spec.argv.slice(1), spec.cwd, spec.env);
			const reader = text => ({ readFrom: off => ({ text: off ? '' : text ?? '', nextOffset: (text ?? '').length }) });
			return { done: Promise.resolve({ exitCode: result.status }), collected: { stdout: reader(result.stdout), stderr: reader(result.stderr) } };
		},
	};
	const ops = createGitOps({ subprocess, dir, repo: remote, branch: 'main', log() {} });
	await ops.ensureWorkspace();
	assert.equal(await ops.commitPush('{}', 'sync test'), 'pushed');
	const author = run(['log', '-1', '--format=%an <%ae>'], dir);
	assert.equal(author.stdout.trim(), 'DSH Plugin Sync <dsh-plugin-sync@users.noreply.local>');
	assert.equal(run(['config', '--local', '--get', 'user.email'], dir).status, 1);
	assert.equal(run(['--git-dir', remote, 'rev-parse', 'refs/heads/main']).status, 0);
});
