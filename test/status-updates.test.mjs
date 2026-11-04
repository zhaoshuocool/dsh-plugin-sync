import test from 'node:test';
import assert from 'node:assert/strict';
import { getStatus, setStatus } from '../core.mjs';

test('status publishes and clears the update policy, available updates and check time', () => {
	const updates = [{ name: 'mgr', from: '1.0.0', to: '1.1.0' }];
	const lastUpdateCheckAt = '2026-11-04T04:00:00.000Z';
	setStatus({ updatePolicy: 'auto', updates, lastUpdateCheckAt });
	assert.equal(getStatus().updatePolicy, 'auto');
	assert.deepEqual(getStatus().updates, updates);
	assert.equal(getStatus().lastUpdateCheckAt, lastUpdateCheckAt);
	setStatus({ phase: 'idle' });
	assert.equal(getStatus().updatePolicy, 'auto');
	setStatus({ updatePolicy: null, updates: null, lastUpdateCheckAt: null });
	assert.equal(getStatus().updatePolicy, null);
	assert.equal(getStatus().updates, null);
	assert.equal(getStatus().lastUpdateCheckAt, null);
});
