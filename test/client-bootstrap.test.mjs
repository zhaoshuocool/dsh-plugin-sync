import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const phase of ['await-choose', 'error']) {
	test(`sync mode recovery buttons remain accessible in ${phase}`, () => {
		let plugin;
		let panel;
		let stateIndex = 0;
		const React = {
			createElement: (type, props, ...children) => ({ type, props, children }),
			useState(initial) { return [stateIndex++ === 0 ? { phase, error: 'install failed', repo: 'https://example.com/sync.git' } : initial, () => {}]; },
			useCallback: fn => fn,
			useEffect() {},
		};
		vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
			window: { __ModuleLoader__: { load(spec) { plugin = spec.factory(() => React); } } },
		});
		plugin.apply({ effect() {}, locale: { bind: () => key => key }, slots: {
			inject(_name, register) { register(); }, register(_spec, component) { panel = component; },
		} });
		const buttons = [];
		function visit(node) {
			if (Array.isArray(node)) return node.forEach(visit);
			if (!node || typeof node !== 'object') return;
			if (node.type === 'button') buttons.push(node.children.join(''));
			visit(node.children);
		}
		visit(panel());
		assert.ok(buttons.includes('bootstrapRemote'), 'remote mode must be available');
		assert.ok(buttons.includes('bootstrapMerge'), 'merge mode must be available');
	});
}
