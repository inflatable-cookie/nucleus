import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkBridgeImports } from './check-bridge-imports.mjs';

checkBridgeImports(process.cwd());

const dir = await mkdtemp(join(tmpdir(), 'plugin-proof-'));
try {
  const outfile = join(dir, 'plugin.cjs');
  await build({ entryPoints: [resolve(process.argv[2])], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(outfile)})`], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw Error(`Plugin bundle failed to load: ${result.stderr || result.error?.message || result.signal}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
