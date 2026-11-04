import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeManifest, unsafeConfigKey, planConfigApply, planConfigPush } from '../core.mjs';

function doc(bundles) {
	return { formatVersion: 1, updatedAt: '2026-11-04T09:00:00.000Z', updatedBy: 'me', bundles };
}

function row(name, inherited, override = {}) {
	return { entry: { options: { id: name, name } }, inherited, override };
}

test('a manifest entry may carry a whitelisted config, nested values included', () => {
	const parsed = normalizeManifest(doc([
		{ name: 'a', source: 'a@1', enabled: true, config: { locale: 'zh', ui: { density: 'compact', flags: [1, 2] }, cleared: null } },
	]));
	assert.equal(parsed.ok, true);
	assert.deepEqual(parsed.manifest.bundles[0].config, { locale: 'zh', ui: { density: 'compact', flags: [1, 2] }, cleared: null });
});

test('an entry without config, or with an empty one, stays as it was', () => {
	const parsed = normalizeManifest(doc([{ name: 'a', source: 'a@1', enabled: true, config: {} }]));
	assert.equal(parsed.ok, true);
	assert.equal('config' in parsed.manifest.bundles[0], false);
});

test('secret-looking keys are refused loudly, naming the key', () => {
	for (const key of ['apiKey', 'API_KEY', 'api_key', 'apikey', 'token', 'authToken', 'authorization', 'password', 'clientSecret', 'access_token', 'private_key']) {
		const parsed = normalizeManifest(doc([{ name: 'a', source: 'a@1', enabled: true, config: { [key]: 'x' } }]));
		assert.equal(parsed.ok, false, `${key} should refuse the manifest`);
		assert.match(parsed.error, new RegExp(key), `${key} should be named in the error`);
		assert.equal(unsafeConfigKey(key), true, key);
	}
});

test('a nested secret or a __jsExpr anywhere in the value is refused', () => {
	for (const config of [
		{ providers: { p1: { apiKey: 'sk_live_x' } } },
		{ providers: { p1: { __jsExpr: 'require("fs")' } } },
		{ list: [{ token: 't' }] },
	]) {
		const parsed = normalizeManifest(doc([{ name: 'a', source: 'a@1', enabled: true, config }]));
		assert.equal(parsed.ok, false, JSON.stringify(config));
	}
	assert.equal(unsafeConfigKey('__jsExpr'), true);
	assert.equal(unsafeConfigKey('tokenizer'), false, 'a word that merely contains token is fine');
	assert.equal(unsafeConfigKey('locale'), false);
});

test('config must be a plain JSON object of JSON values', () => {
	for (const config of ['zh', 1, ['a'], null, { nested: () => 1 }, { n: Number.NaN }, { n: Number.POSITIVE_INFINITY }]) {
		const parsed = normalizeManifest(doc([{ name: 'a', source: 'a@1', enabled: true, config }]));
		assert.equal(parsed.ok, false, JSON.stringify(config));
	}
});

test('planConfigApply skips keys this machine already runs', () => {
	const remote = doc([{ name: 'ui', source: 'ui@1', enabled: true, config: { locale: 'zh', density: 'compact' } }]).bundles;
	const rows = [row('ui', { locale: 'zh', density: 'roomy', extra: 1 })];
	const plan = planConfigApply(rows, remote);
	assert.equal(plan.length, 1);
	assert.deepEqual(plan[0].values, { density: 'compact' }, 'only the differing key is written');
	assert.equal(plan[0].name, 'ui');
});

test('planConfigApply does nothing when nothing is whitelisted or installed', () => {
	const remote = doc([{ name: 'ui', source: 'ui@1', enabled: true }, { name: 'gone', source: 'gone@1', enabled: true, config: { a: 1 } }]).bundles;
	assert.deepEqual(planConfigApply([row('ui', { a: 2 })], remote), []);
});

test('planConfigApply edits the sync bundle itself last', () => {
	const remote = doc([
		{ name: 'dsh-plugin-sync', source: 'github:x/y', enabled: true, config: { updatePolicy: 'check' } },
		{ name: 'ui', source: 'ui@1', enabled: true, config: { locale: 'zh' } },
	]).bundles;
	const rows = [row('dsh-plugin-sync', {}, {}), row('ui', {}, {})];
	const plan = planConfigApply(rows, remote, { selfName: 'dsh-plugin-sync' });
	assert.deepEqual(plan.map(p => p.name), ['ui', 'dsh-plugin-sync'], 'a self edit restarts us, so it goes last');
});

test('planConfigPush copies only whitelisted keys this machine actually set', () => {
	const remote = doc([{ name: 'ui', source: 'ui@1', enabled: true, config: { locale: 'zh', density: 'compact' } }]).bundles;
	const plan = planConfigPush(remote, { ui: { locale: 'en', density: 'compact', secretThing: 'no' } });
	assert.deepEqual(plan, [{ name: 'ui', config: { locale: 'en' } }]);
});

test('planConfigPush stays quiet when this machine agrees or says nothing', () => {
	const remote = doc([{ name: 'ui', source: 'ui@1', enabled: true, config: { locale: 'zh' } }]).bundles;
	assert.deepEqual(planConfigPush(remote, { ui: { locale: 'zh' } }), []);
	assert.deepEqual(planConfigPush(remote, { ui: {} }), [], 'an unset local value does not clear the shared key');
	assert.deepEqual(planConfigPush(remote, {}), []);
});

test('planConfigPush never re-emits a secret key even if the manifest carried one', () => {
	const remote = [{ name: 'ui', source: 'ui@1', enabled: true, config: { apiKey: 'sk_x' } }];
	assert.deepEqual(planConfigPush(remote, { ui: { apiKey: 'sk_y' } }), []);
});
