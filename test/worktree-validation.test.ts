import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandLooksLikeEffigyQa, commandLooksLikeValidation, cwdInWorktree, cwdMapFromLsof,
  findWorktreeValidation, retryOnceAfterIncompleteScan, worktreeValidationVerdict, type CwdState,
} from '../core/workspaces/worktree-validation';

test('an incomplete process scan retries once and a complete scan does not retry', () => {
  let calls = 0;
  const recovered = retryOnceAfterIncompleteScan(
    () => ++calls,
    result => result === 2,
  );
  assert.equal(recovered, 2);
  assert.equal(calls, 2);

  calls = 0;
  const alreadyComplete = retryOnceAfterIncompleteScan(
    () => ++calls,
    result => result === 1,
  );
  assert.equal(alreadyComplete, 1);
  assert.equal(calls, 1);

  calls = 0;
  const remainsIncomplete = retryOnceAfterIncompleteScan(
    () => ++calls,
    () => false,
  );
  assert.equal(remainsIncomplete, 2);
  assert.equal(calls, 2, 'an unresolved scan is not retried indefinitely');
});

test('command matching recognises Effigy QA and repository QA argv, and rejects lookalikes', () => {
  assert.equal(commandLooksLikeEffigyQa('effigy qa:changed'), true);
  assert.equal(commandLooksLikeEffigyQa('/opt/homebrew/bin/effigy qa'), true);
  assert.equal(commandLooksLikeEffigyQa('node /workspace/user/effigy/dist/cli.js qa:docs'), true);
  assert.equal(commandLooksLikeEffigyQa('npx --yes effigy qa:changed'), true);
  assert.equal(commandLooksLikeEffigyQa('effigy test'), false);
  assert.equal(commandLooksLikeEffigyQa('effigy check'), false);
  assert.equal(commandLooksLikeEffigyQa('rg effigy qa:changed'), false);
  assert.equal(commandLooksLikeValidation('bun run qa', [['bun', 'run', 'qa']]), true);
  assert.equal(commandLooksLikeValidation('/usr/bin/bun run qa', [['/usr/bin/bun', 'run', 'qa']]), true);
  assert.equal(commandLooksLikeValidation('bun test', [['bun', 'run', 'qa']]), false);
});

test('cwd matching is the worktree or a directory inside it, never a sibling prefix', () => {
  assert.equal(cwdInWorktree('/tmp/ns-task', '/tmp/ns-task'), true);
  assert.equal(cwdInWorktree('/tmp/ns-task/src', '/tmp/ns-task'), true);
  assert.equal(cwdInWorktree('/tmp/ns-task-other', '/tmp/ns-task'), false);
  assert.equal(cwdInWorktree('/tmp/ns-tas', '/tmp/ns-task'), false);
});

test('findWorktreeValidation matches a live process in the worktree and ignores a sibling', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nsq-worktree-qa-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const worktree = join(root, 'task');
  const sibling = join(root, 'other');
  await import('node:fs/promises').then(fs => Promise.all([fs.mkdir(worktree), fs.mkdir(sibling)]));
  const live = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)', 'effigy', 'qa:changed'], {
    cwd: worktree, stdio: 'ignore',
  });
  const outsider = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)', 'effigy', 'qa:changed'], {
    cwd: sibling, stdio: 'ignore',
  });
  t.after(() => { try { if (live.pid) process.kill(live.pid); } catch { /* already gone */ } });
  t.after(() => { try { if (outsider.pid) process.kill(outsider.pid); } catch { /* already gone */ } });
  const found = await waitFor(() => {
    const scan = findWorktreeValidation(worktree);
    return scan.state === 'alive' ? scan : null;
  }, 8_000, 'worktree QA process');
  assert.equal(found.pid, live.pid);
  assert.match(found.command, /effigy qa:changed/);
  const other = findWorktreeValidation(sibling);
  assert.equal(other.state, 'alive');
  assert.equal(other.state === 'alive' ? other.pid : null, outsider.pid);
  assert.equal(findWorktreeValidation(join(root, 'missing')).state, 'absent');
});

test('worktreeValidationVerdict distinguishes a complete empty scan from an incomplete listing', () => {
  const worktree = '/tmp/ns-task';
  const none = () => new Map<number, CwdState>();
  assert.equal(worktreeValidationVerdict(worktree, [{ pid: 1, command: 'sleep 1' }], [], none).state, 'absent');
  assert.deepEqual(worktreeValidationVerdict(worktree, null, [], none), { state: 'unverified', reason: 'process listing failed' });
  assert.deepEqual(
    worktreeValidationVerdict(worktree, [{ pid: 1 }, { pid: 2, command: 'sleep 1' }], [], none),
    { state: 'unverified', reason: 'process listing is incomplete' },
  );
  assert.deepEqual(
    worktreeValidationVerdict(worktree, [{ pid: 1, command: 'effigy qa:changed' }], [], () => null),
    { state: 'unverified', reason: 'cwd listing failed' },
  );
  assert.deepEqual(
    worktreeValidationVerdict(worktree, [{ pid: 1, command: 'effigy qa:changed' }], [], () => new Map([[1, { state: 'unreadable' }]])),
    { state: 'unverified', reason: 'cwd listing is incomplete' },
  );
  const elsewhere = worktreeValidationVerdict(
    worktree,
    [{ pid: 1, command: 'effigy qa:changed' }],
    [],
    () => new Map([[1, { state: 'read', path: '/tmp/other' }]]),
  );
  assert.equal(elsewhere.state, 'absent');
  const gone = worktreeValidationVerdict(
    worktree,
    [{ pid: 1, command: 'effigy qa:changed' }],
    [],
    () => new Map([[1, { state: 'gone' }]]),
  );
  assert.equal(gone.state, 'absent');
  const alive = worktreeValidationVerdict(
    worktree,
    [{ pid: 1 }, { pid: 2, command: 'effigy qa:changed' }],
    [],
    () => new Map([[2, { state: 'read', path: worktree }]]),
  );
  assert.deepEqual(alive, { state: 'alive', command: 'effigy qa:changed', pid: 2 });
  const omittedAfterPartial = worktreeValidationVerdict(
    worktree,
    [{ pid: 1, command: 'effigy qa:changed' }, { pid: 2, command: 'effigy qa:changed' }],
    [],
    () => new Map([[1, { state: 'read', path: '/tmp/other' }]]),
  );
  assert.deepEqual(omittedAfterPartial, { state: 'unverified', reason: 'cwd listing is incomplete' });
});

test('cwdMapFromLsof treats omitted pids as gone only on a completed exit 0', () => {
  const listed = 'p1\nfcwd\nn/tmp/other\n';
  const complete = cwdMapFromLsof([1, 2], { status: 0, stdout: listed });
  assert.equal(complete?.get(1)?.state, 'read');
  assert.equal(complete?.get(2)?.state, 'gone');
  const nonzero = cwdMapFromLsof([1, 2], { status: 1, stdout: listed });
  assert.equal(nonzero?.get(1)?.state, 'read');
  assert.equal(nonzero?.get(2)?.state, 'unreadable');
  const timedOut = cwdMapFromLsof([1, 2], { status: null, stdout: listed, error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM' });
  assert.equal(timedOut?.get(1)?.state, 'read');
  assert.equal(timedOut?.get(2)?.state, 'unreadable');
  assert.equal(cwdMapFromLsof([1, 2], { status: 1, stdout: '' }), null);
  const omittedMatch = worktreeValidationVerdict(
    '/tmp/ns-task',
    [{ pid: 1, command: 'effigy qa:changed' }, { pid: 2, command: 'effigy qa:changed' }],
    [],
    () => cwdMapFromLsof([1, 2], { status: 1, stdout: listed }),
  );
  assert.deepEqual(omittedMatch, { state: 'unverified', reason: 'cwd listing is incomplete' });
  const printedMatch = worktreeValidationVerdict(
    '/tmp/ns-task',
    [{ pid: 1, command: 'effigy qa:changed' }, { pid: 2, command: 'effigy qa:changed' }],
    [],
    () => cwdMapFromLsof([1, 2], { status: 1, stdout: 'p2\nfcwd\nn/tmp/ns-task\n' }),
  );
  assert.deepEqual(printedMatch, { state: 'alive', command: 'effigy qa:changed', pid: 2 });
});

async function waitFor<T>(probe: () => T | null, timeoutMs: number, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}
