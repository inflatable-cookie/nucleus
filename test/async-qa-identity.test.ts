import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { processCommandLineAsync, findProcessByCommandTokenAsync } from '../core/machine/process-identity';
import { supervisorLivenessAsync } from '../core/machine/supervisor-liveness';
import { ProjectQaRunner } from './project-qa-runner-fixture';

test('async supervisor reads yield and retain token identity, mismatch and dead verdicts', async t => {
  const token = randomUUID();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)', token], { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(() => { try { child.kill(); } catch { /* already gone */ } });
  const pid = child.pid!;
  let yielded = false;
  const timer = setTimeout(() => { yielded = true; }, 0);
  const line = await processCommandLineAsync(pid);
  clearTimeout(timer);
  if (process.platform !== 'linux') assert.equal(yielded, true, 'OS process read must leave the event loop available');
  assert.ok(line?.includes(token));
  assert.equal((await supervisorLivenessAsync(pid, token)).state, 'live');
  assert.equal((await supervisorLivenessAsync(pid, 'different-token')).state, 'dead');
  assert.deepEqual(await findProcessByCommandTokenAsync(token), { state: 'found', pid });
  assert.equal((await findProcessByCommandTokenAsync(`absent-${randomUUID()}`)).state, 'absent');
  const closed = once(child, 'exit');
  child.kill();
  await closed;
  assert.equal((await supervisorLivenessAsync(pid, token)).state, 'dead');
  assert.equal(await processCommandLineAsync(-1), null);
});

test('an inspection finishing after the durable run changed cannot settle or publish its old snapshot', async () => {
  let run: unknown = { id: 'qa', key: 'repo', state: 'running', teardownRetryAttempt: 0 };
  let complete!: (inspection: unknown) => void;
  const inspection = new Promise(resolve => { complete = resolve; });
  let effects = 0;
  const runner = Object.assign(Object.create(ProjectQaRunner.prototype), {
    options: {}, store: { qaRun: () => run },
    inspectSupervisor: () => inspection,
    publishCommandLaunchIdentity: () => { effects++; },
    settleFromSupervisor: () => { effects++; },
    reconcileLostRun: () => { effects++; },
  }) as { watchSupervisor(id: string, key: string): Promise<void> };
  const watching = runner.watchSupervisor('qa', 'repo');
  run = { id: 'qa', key: 'repo', state: 'settled', teardownRetryAttempt: 1 };
  complete({ kind: 'settled', state: null, hostResult: null });
  await watching;
  assert.equal(effects, 0, 'changed run retires the stale inspection without effects');
});

test('unreadable asynchronous identity is unknown and death during the read is rechecked', async () => {
  assert.equal((await supervisorLivenessAsync(42, 'token', {
    alive: () => true, command: async () => null,
  })).state, 'unknown');
  let alive = true;
  assert.equal((await supervisorLivenessAsync(42, 'token', {
    alive: () => alive,
    command: async () => { alive = false; return 'node token'; },
  })).state, 'dead');
});

test('concurrent read inspections share settlement after the asynchronous scan', async () => {
  const key = randomUUID();
  const run = { id: key, key, state: 'running' };
  let inspected!: (value: unknown) => void;
  let settled!: () => void;
  const inspection = new Promise(resolve => { inspected = resolve; });
  const settlement = new Promise<void>(resolve => { settled = resolve; });
  let settlements = 0;
  const runner = Object.assign(Object.create(ProjectQaRunner.prototype), {
    store: { qaRun: () => run }, hostRuns: { get: () => ({}) },
    inspectSupervisor: () => inspection,
    settleFromSupervisor: () => { settlements++; return settlement; },
  }) as ProjectQaRunner;
  const reads = [runner.reconcile(key, key), runner.reconcile(key, key)];
  inspected({ kind: 'settled', state: null, hostResult: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settlements, 1);
  settled();
  await Promise.all(reads);
});
