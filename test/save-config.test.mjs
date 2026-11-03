import test from 'node:test';
import assert from 'node:assert/strict';

import { createSaveConfig } from '../index.js';

// `configEditor.entries()` hands back Loader entries whose identity lives in
// `entry.options`; the entry object has no `patchId` / `name` / `moduleName`
// property, which is exactly what the first implementation matched on and why
// saving from the Settings tab always reported "not addressable".
function fakeEditor({ entries, current = {} }) {
	const edits = [];
	return {
		edits,
		entries: () => entries,
		async edit(entry, apply) {
			const next = apply(current);
			edits.push({ id: entry?.options?.id, next });
			return next;
		},
	};
}

const OTHER = { options: { id: 'dsh-our-free-model', name: 'dsh-our-free-model', config: {} } };
const SELF = { options: { id: 'dsh-plugin-sync', name: 'dsh-plugin-sync', config: { repo: 'https://github.com/me/x.git' } } };

test('createSaveConfig addresses its own entry by options.id', async () => {
	const editor = fakeEditor({ entries: [OTHER, SELF], current: SELF.options.config });
	await createSaveConfig({ configEditor: editor, fiber: undefined })({ branch: 'dev' });
	assert.deepEqual(editor.edits, [{
		id: 'dsh-plugin-sync',
		next: { repo: 'https://github.com/me/x.git', branch: 'dev' },
	}]);
});

test('createSaveConfig prefers the running fiber entry the editor can see', async () => {
	const editor = fakeEditor({ entries: [SELF, OTHER], current: SELF.options.config });
	await createSaveConfig({ configEditor: editor, fiber: { entry: SELF } })({ proxy: 'http://127.0.0.1:10808' });
	assert.deepEqual(editor.edits, [{
		id: 'dsh-plugin-sync',
		next: { repo: 'https://github.com/me/x.git', proxy: 'http://127.0.0.1:10808' },
	}]);
});

test('createSaveConfig clears a field when the page sends null', async () => {
	const editor = fakeEditor({
		entries: [SELF],
		current: { repo: 'https://github.com/me/x.git', proxy: 'http://127.0.0.1:10808' },
	});
	await createSaveConfig({ configEditor: editor })({ repo: null, proxy: null });
	assert.deepEqual(editor.edits[0].next, {}, 'cleared fields are removed, not written as null');
});

test('createSaveConfig reports 503 when this plugin is not in the patch', async () => {
	const editor = fakeEditor({ entries: [OTHER] });
	let caught;
	try {
		// The editor lists another bundle's entry; this fiber's entry object is
		// not among them (a deselected or renamed row), and no listed entry has
		// our id — there is nothing safe to edit, so the save must fail loud.
		await createSaveConfig({ configEditor: editor, fiber: { entry: { options: { id: 'dsh-plugin-sync' } } } })({ branch: 'dev' });
	} catch (error) {
		caught = error;
	}
	assert.ok(caught, 'a save must fail loud rather than write someone else entry');
	assert.equal(caught.status, 503);
	assert.equal(editor.edits.length, 0);
});
