// Run one file on origin/main in a disposable detached checkout.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const [file, ...extra] = process.argv.slice(2);
if (!file || extra.length || !/^test\/(?:[\w.-]+\/)*[\w.-]+\.test\.ts$/.test(file)) {
  console.error('Usage: effigy test:baseline <test/file.test.ts>');
  process.exit(2);
}
if (!process.env.TMPDIR) throw new Error('TMPDIR must name the run scratch directory');
const root = mkdtempSync(join(process.env.TMPDIR, 'nucleus-baseline-'));
const checkout = join(root, 'checkout');
const repo = process.cwd();
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit' });
let added = false;
let status = 1;
try {
  const add = run('git', ['worktree', 'add', '--detach', checkout, 'origin/main'], repo);
  if (add.status !== 0) throw new Error('Could not create baseline checkout');
  added = true;
  symlinkSync(resolve(repo, 'node_modules'), join(checkout, 'node_modules'), 'dir');
  const result = run('effigy', ['test', 'unit', '--', file], checkout);
  status = result.status ?? 1;
} finally {
  if (added && run('git', ['worktree', 'remove', '--force', checkout], repo).status !== 0) {
    console.error(`Could not remove baseline checkout: ${checkout}`);
    status = 1;
  } else rmSync(root, { recursive: true, force: true });
}
process.exit(status);
