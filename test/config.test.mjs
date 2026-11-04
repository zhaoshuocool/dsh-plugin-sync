import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { Config } from '../index.js';

test('Config applies every default to an empty object', () => {
	const parsed = Config({});
	assert.deepEqual(parsed, {
		repo: null,
		branch: 'main',
		pullIntervalMs: 300000,
		machineName: os.hostname(),
		proxy: null,
		updatePolicy: 'off',
	});
});

test('Config accepts each update policy and defaults to off', () => {
	assert.equal(Config({}).updatePolicy, 'off');
	assert.equal(Config({ updatePolicy: null }).updatePolicy, 'off');
	for (const policy of ['off', 'check', 'auto']) {
		assert.equal(Config({ updatePolicy: policy }).updatePolicy, policy, policy);
	}
});

test('Config rejects an unknown update policy', () => {
	for (const policy of ['yes', 'ON', '', 1]) {
		assert.throws(
			() => Config({ updatePolicy: policy }),
			error => error.issues?.some(issue => issue.path[0] === 'updatePolicy'),
			`updatePolicy=${String(policy)} should be rejected`,
		);
	}
});

test('Config tolerates undefined/missing row config', () => {
	assert.equal(Config(undefined).repo, null);
	assert.equal(Config(null).branch, 'main');
});

test('Config normalizes an empty repo string to null (disabled)', () => {
	assert.equal(Config({ repo: '' }).repo, null);
});

test('Config accepts typical remote forms and a local path', () => {
	for (const repo of [
		'https://github.com/me/private-plugins.git',
		'git@github.com:me/private-plugins.git',
		'ssh://git@host/srv/git/plugins.git',
		'file:///D:/git/plugin-sync-origin',
		'D:/git/plugin-sync-origin',
		'/srv/git/plugins.git',
	]) {
		assert.equal(Config({ repo }).repo, repo, repo);
	}
});

test('Config rejects an unsupported repo protocol', () => {
	assert.throws(() => Config({ repo: 'ftp://x' }), /repo/);
});

test('Config rejects a too-short pull interval and non-integers', () => {
	assert.throws(() => Config({ pullIntervalMs: 5000 }), /pullIntervalMs/);
	assert.throws(() => Config({ pullIntervalMs: 60000.5 }), /pullIntervalMs/);
	assert.equal(Config({ pullIntervalMs: 60000 }).pullIntervalMs, 60000);
});

test('Config rejects empty branch and machineName', () => {
	assert.throws(() => Config({ branch: '' }), /branch/);
	assert.throws(() => Config({ machineName: '   ' }), /machineName/);
});

test('Config rejects unknown keys instead of silently dropping them', () => {
	assert.throws(() => Config({ repoos: 'x' }), /repoos|repo/);
});

test('Config implements the Standard Schema interface', () => {
	const std = Config['~standard'];
	assert.equal(std.version, 1);
	assert.equal(std.vendor, 'dsh-plugin-sync');
	const okResult = std.validate({ repo: 'https://github.com/me/x.git' });
	assert.equal(okResult.issues, undefined);
	assert.equal(okResult.value.repo, 'https://github.com/me/x.git');
	const bad = std.validate({ pullIntervalMs: '300000' });
	assert.ok(Array.isArray(bad.issues) && bad.issues.length === 1);
	assert.match(bad.issues[0].message, /pullIntervalMs/);
});

test('Config.parse matches the callable form and errors carry paths', () => {
	assert.deepEqual(Config.parse({ branch: 'dev' }).branch, 'dev');
	let caught;
	try {
		Config.parse({ branch: 42 });
	} catch (error) {
		caught = error;
	}
	assert.ok(caught);
	assert.equal(caught.issues[0].path[0], 'branch');
});

test('Config keeps a proxy URL and clears it on empty or null', () => {
	assert.equal(Config({ proxy: 'http://127.0.0.1:10808' }).proxy, 'http://127.0.0.1:10808');
	assert.equal(Config({ proxy: '  http://127.0.0.1:10808/ ' }).proxy, 'http://127.0.0.1:10808', 'trimmed, trailing slash dropped');
	assert.equal(Config({ proxy: 'socks5://127.0.0.1:1080' }).proxy, 'socks5://127.0.0.1:1080');
	assert.equal(Config({ proxy: '' }).proxy, null, 'an empty string means no proxy');
	assert.equal(Config({ proxy: null }).proxy, null);
});

test('Config rejects anything that is not a proxy URL', () => {
	for (const proxy of ['127.0.0.1:10808', 'ftp://127.0.0.1:21', 'http://', 'not a url', 10808]) {
		assert.throws(() => Config({ proxy }), /proxy/, String(proxy));
	}
});
