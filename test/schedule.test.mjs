import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduler } from '../index.js';

function fakeTimers() {
	let now = 0;
	const entries = [];
	let nextId = 1;
	const api = {
		get now() { return now; },
		setTimeout(fn, ms) {
			const entry = { id: nextId++, at: now + ms, fn, every: null, cancelled: false };
			entries.push(entry);
			return entry.id;
		},
		clearTimeout(id) {
			const entry = entries.find(e => e.id === id);
			if (entry) entry.cancelled = true;
		},
		setInterval(fn, ms) {
			const entry = { id: nextId++, at: now + ms, fn, every: ms, cancelled: false };
			entries.push(entry);
			return entry.id;
		},
		clearInterval(id) { api.clearTimeout(id); },
		async advance(ms) {
			const target = now + ms;
			for (;;) {
				const due = entries
					.filter(e => !e.cancelled && e.at <= target)
					.sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				now = due.at;
				if (due.every) due.at = now + due.every;
				else due.cancelled = true;
				due.fn();
				await settle();
			}
			now = target;
			await settle();
		},
	};
	return api;
}

/** Let queued microtasks/promise chains run to quiescence. */
function settle() {
	return new Promise(resolve => setImmediate(resolve));
}

function makeCalls() {
	const events = [];
	let active = 0;
	let maxActive = 0;
	const track = (kind, delayMs = 0) => async () => {
		active += 1;
		maxActive = Math.max(maxActive, active);
		events.push(`${kind}:start`);
		if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
		else await settle();
		events.push(`${kind}:end`);
		active -= 1;
		return { action: kind };
	};
	return {
		events,
		pull: track('pull'),
		push: track('push'),
		get maxActive() { return maxActive; },
		count(kind) { return events.filter(e => e === `${kind}:start`).length; },
	};
}

test('triggerPush called three times produces exactly one debounced push', async () => {
	const timers = fakeTimers();
	const calls = makeCalls();
	const scheduler = createScheduler({ pull: calls.pull, push: calls.push, intervalMs: 300000, debounceMs: 30000, bootDelayMs: 15000, timers });
	scheduler.triggerPush();
	scheduler.triggerPush();
	scheduler.triggerPush();
	assert.equal(calls.count('push'), 0);
	await timers.advance(30000);
	assert.equal(calls.count('push'), 1);
	assert.equal(calls.count('pull'), 0);
	await timers.advance(60000);
	assert.equal(calls.count('push'), 1);
});

test('runNow pulls first and pushes after, in one job', async () => {
	const timers = fakeTimers();
	const calls = makeCalls();
	const scheduler = createScheduler({ pull: calls.pull, push: calls.push, intervalMs: 300000, debounceMs: 30000, bootDelayMs: 15000, timers });
	await scheduler.runNow();
	assert.deepEqual(calls.events, ['pull:start', 'pull:end', 'push:start', 'push:end']);
});

test('runNow while a job is in flight queues exactly one follow-up run, never in parallel', async () => {
	const timers = fakeTimers();
	const calls = makeCalls();
	const scheduler = createScheduler({ pull: calls.pull, push: calls.push, intervalMs: 300000, debounceMs: 30000, bootDelayMs: 15000, timers });
	const first = scheduler.runNow();
	const second = scheduler.runNow();
	const third = scheduler.runNow();
	await Promise.all([first, second, third]);
	assert.equal(calls.count('pull'), 2, 'initial run plus exactly one catch-up run');
	assert.equal(calls.count('push'), 2);
	assert.equal(calls.maxActive, 1, 'single-flight: never two jobs at once');
});

test('start runs the first pull after the boot delay, then every intervalMs until stopped', async () => {
	const timers = fakeTimers();
	const calls = makeCalls();
	const scheduler = createScheduler({ pull: calls.pull, push: calls.push, intervalMs: 100000, debounceMs: 30000, bootDelayMs: 15000, timers });
	scheduler.start();
	await timers.advance(14000);
	assert.equal(calls.count('pull'), 0);
	await timers.advance(1000);
	assert.equal(calls.count('pull'), 1);
	await timers.advance(100000);
	assert.equal(calls.count('pull'), 2);
	scheduler.stop();
	await timers.advance(300000);
	assert.equal(calls.count('pull'), 2);
});

test('a push queued by debounce while a job runs merges into exactly one later push', async () => {
	const timers = fakeTimers();
	const calls = makeCalls();
	const scheduler = createScheduler({ pull: calls.pull, push: calls.push, intervalMs: 300000, debounceMs: 10, bootDelayMs: 15000, timers });
	const first = scheduler.runNow();
	scheduler.triggerPush();
	scheduler.triggerPush();
	await timers.advance(10);
	await first;
	await settle();
	await timers.advance(10);
	await settle();
	assert.equal(calls.count('push'), 2, 'in-flight job plus one merged trailing push');
	assert.equal(calls.maxActive, 1);
});

test('a failing pull does not skip the push phase or wedge the scheduler', async () => {
	const timers = fakeTimers();
	const calls = makeCalls();
	const flaky = createScheduler({
		pull: async () => { throw new Error('remote offline'); },
		push: calls.push,
		intervalMs: 300000,
		debounceMs: 30000,
		bootDelayMs: 15000,
		timers,
	});
	await flaky.runNow();
	assert.equal(calls.count('push'), 1, 'push still ran after the failing pull');
	await flaky.runNow();
	assert.equal(calls.count('push'), 2, 'scheduler accepted the next job');
});
