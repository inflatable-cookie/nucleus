import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { instructionForCommit } from '../core/hooks/hooks';
import { git } from '../core/git/index';

test('committed blob facts reuse an exact path and head and re-read a different head', async () => {
  const root = mkdtempSync(join(tmpdir(), 'committed-facts-'));
  await git(root, 'init'); await git(root, 'config', 'user.name', 'Fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'instruction.md'), 'first');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'first');
  const firstHead = await git(root, 'rev-parse', 'HEAD');
  const original = childProcess.execFile;
  let reads = 0;
  childProcess.execFile = ((command: string, args: string[], ...rest: unknown[]) => {
    if (command === 'git' && ['ls-tree', 'cat-file'].includes(args[0])) reads++;
    return (original as Function)(command, args, ...rest);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const first = await instructionForCommit(root, firstHead, 'instruction.md', 'text/markdown');
    const coldReads = reads;
    assert.ok(coldReads >= 2);
    assert.deepEqual(await instructionForCommit(root, firstHead, 'instruction.md', 'text/markdown'), first);
    assert.equal(reads, coldReads);
    assert.equal(await instructionForCommit(root, firstHead, 'missing.md', 'text/markdown').catch(() => null), null);
    const missingReads = reads;
    await instructionForCommit(root, firstHead, 'missing.md', 'text/markdown').catch(() => null);
    assert.equal(reads, missingReads, 'immutable absence is cached too');
    assert.equal((await instructionForCommit(root, 'HEAD', 'instruction.md', 'text/markdown')).digest, first.digest);
    writeFileSync(join(root, 'instruction.md'), 'second');
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'second');
    const second = await instructionForCommit(root, await git(root, 'rev-parse', 'HEAD'), 'instruction.md', 'text/markdown');
    assert.notEqual(second.digest, first.digest); assert.ok(reads > coldReads);
    assert.equal((await instructionForCommit(root, 'HEAD', 'instruction.md', 'text/markdown')).digest, second.digest,
      'mutable refs must resolve again');
    assert.equal((await instructionForCommit(root, firstHead, 'instruction.md', 'text/markdown')).digest, first.digest,
      'a different working head cannot alter the pinned fact');
  } finally { childProcess.execFile = original; syncBuiltinESMExports(); }
});
