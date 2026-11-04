import test from 'node:test';
import assert from 'node:assert/strict';

import {
	installedVersionsFromList,
	semverCompare,
	rangeAccepts,
	planUpdates,
} from '../core.mjs';

// --- installedVersionsFromList -----------------------------------------------

test('installedVersionsFromList maps each installed bundle to its version', () => {
	const rows = [
		{ name: 'a', source: 'a@^1.0.0', installed: true, version: '1.0.1' },
		{ name: 'b', source: 'github:x/b', installed: true, version: '0.2.0' },
		{ name: 'c', source: 'c@^1.0.0', installed: false },
		{ name: 'd', source: 'd@^1.0.0', installed: true },
	];
	assert.deepEqual(installedVersionsFromList(rows), { a: '1.0.1', b: '0.2.0' });
});

// --- semverCompare -----------------------------------------------------------

test('semverCompare orders versions by their triple', () => {
	assert.equal(semverCompare('1.2.29', '1.2.26'), 1);
	assert.equal(semverCompare('1.2.26', '1.2.29'), -1);
	assert.equal(semverCompare('1.2.26', '1.2.26'), 0);
	assert.equal(semverCompare('2.0.0', '1.99.99'), 1);
	assert.equal(semverCompare('1.3', '1.2.9'), 1);
});

test('semverCompare ranks a prerelease below its release', () => {
	assert.equal(semverCompare('1.3.0-beta.1', '1.3.0'), -1);
	assert.equal(semverCompare('1.3.0-beta.1', '1.2.9'), 1);
});

// --- rangeAccepts ------------------------------------------------------------

test('rangeAccepts follows caret and tilde semantics', () => {
	assert.equal(rangeAccepts('^1.2.24', '1.2.29'), true);
	assert.equal(rangeAccepts('^1.2.24', '2.0.0'), false);
	assert.equal(rangeAccepts('^0.2.3', '0.3.0'), false, 'a caret on 0.x pins the minor');
	assert.equal(rangeAccepts('~1.2.3', '1.2.9'), true);
	assert.equal(rangeAccepts('~1.2.3', '1.3.0'), false);
});

test('rangeAccepts treats an exact pin as exact and a floating range as open', () => {
	assert.equal(rangeAccepts('1.2.24', '1.2.29'), false);
	assert.equal(rangeAccepts('1.2.24', '1.2.24'), true);
	for (const spec of ['latest', 'next', '*', '>=1.2.24', '1.x', '1.x - 2']) {
		assert.equal(rangeAccepts(spec, '1.2.29'), true, spec);
	}
});

// --- planUpdates -------------------------------------------------------------

const entry = (name, source, enabled = true) => ({ name, source, enabled });

test('planUpdates offers the manifest spec when the registry is newer and the range allows it', () => {
	const updates = planUpdates(
		[entry('mgr', 'mgr@^1.2.24')],
		{ mgr: '1.2.26' },
		{ mgr: '1.2.29' },
	);
	assert.deepEqual(updates, [{ name: 'mgr', from: '1.2.26', to: '1.2.29', spec: 'mgr@^1.2.24' }]);
});

test('planUpdates is quiet when the installed version is already latest', () => {
	assert.deepEqual(planUpdates([entry('mgr', 'mgr@^1.2.24')], { mgr: '1.2.29' }, { mgr: '1.2.29' }), []);
});

test('planUpdates respects an exact pin', () => {
	assert.deepEqual(planUpdates([entry('mgr', 'mgr@1.2.24')], { mgr: '1.2.24' }, { mgr: '1.2.29' }), []);
});

test('planUpdates skips non-npm sources, the sync bundle itself, and unknown versions', () => {
	const entries = [
		entry('whale', 'github:zixin947/dsh-beichen-whale-widget'),
		entry('dsh-plugin-sync', 'github:zhaoshuocool/dsh-plugin-sync'),
		entry('nosrc', null),
	];
	const versions = { 'dsh-plugin-sync': '0.1.0' };
	const latest = { whale: '9.9.9', 'dsh-plugin-sync': '9.9.9', nosrc: '9.9.9', uninstalled: '9.9.9' };
	assert.deepEqual(planUpdates(entries, versions, latest, { selfName: 'dsh-plugin-sync' }), []);
});

test('planUpdates ignores a package the registry lookup failed for', () => {
	const updates = planUpdates([entry('a', 'a@^1.0.0'), entry('b', 'b@^1.0.0')], { a: '1.0.0', b: '1.0.0' }, { a: '1.1.0' });
	assert.deepEqual(updates, [{ name: 'a', from: '1.0.0', to: '1.1.0', spec: 'a@^1.0.0' }]);
});

test('planUpdates never downgrades', () => {
	assert.deepEqual(planUpdates([entry('a', 'a@^1.0.0')], { a: '2.0.0' }, { a: '1.9.0' }), []);
});
