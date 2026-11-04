import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Test the distributed artifact, not imports from the complete source checkout.
// Omitting a runtime module from package.json files must fail this test.
test('the packed plugin entry loads on a fresh machine', () => {
	const root = fileURLToPath(new URL('../', import.meta.url));
	const destination = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-pack-'));
	const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
	const packed = JSON.parse(execFileSync(process.execPath,
		[npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', destination],
		{ cwd: root, encoding: 'utf8' }));
	execFileSync('tar', ['-xf', join(destination, packed[0].filename), '-C', destination]);
	const loaded = spawnSync(process.execPath, ['--input-type=module', '-e',
		"const plugin = await import('./index.js'); if (typeof plugin.apply !== 'function' || typeof plugin.Config !== 'function') process.exit(2);"],
		{ cwd: join(destination, 'package'), encoding: 'utf8' });
	assert.equal(loaded.status, 0, loaded.stderr || String(loaded.error ?? 'packed entry did not load'));
});
