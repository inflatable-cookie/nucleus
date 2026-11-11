import { fakeAdapter, observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Store, operationIdForKey, operationInputHash } from '../core/store/store';
import { Engine } from '../core/engine';
import { QueueRuntime } from '../service/runtime-owner';
import { RuntimeRetirementService, type EffigyInvoke } from '../core/runtime/runtime-retirement';
import { git } from '../core/git/index';
import { ABSENT_WORKER_REASON } from '../core/resolution';
import { operationStart, submissionSchema, type Profile, type Task } from '../shared/contracts';
import { operationSummarySchema, type OperationAcceptance } from '../shared/operations';
import type { Adapter, AgentObservation } from '../core/host';
import { timingTest, performanceAssert } from './support/timing';
import { cpuTimeMs } from './support/cpu-time';

const profile: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: ['low'] };

function dispatched(store: Store, repoPath: string): Task {
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: `Task ${repoPath}`, repoPath, planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
  return store.update(task.id, {
    phase: 'working', workspaceIntent: true, agentIntent: true,
    workspaceId: `ws-${task.id}`, directory: '/fixture', agentId: `agent-${task.id}`, runId: `run-${task.id}`,
    profile, profileGroup: 'test',
  });
}

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nsq-ops-')));
  const path = join(dir, 'queue.sqlite');
  const store = new Store(path);
  store.setMeta('hostId', 'host'); // Queue #912: register the host these timing operations route through.
  const calls = { observes: 0, archives: 0, creates: 0 };
  let gatedAgent: string | null = null;
  let openGate: (() => void) | null = null;
  let gate: Promise<void> = Promise.resolve();
  const adapter: Adapter = fakeAdapter({
    profiles: async () => [profile],
    validate: async (t: Task) => t.planningCommit,
    createWorkspace: async (t: Task) => { calls.creates++; return { id: `ws-${t.id}`, directory: '/fixture' }; },
     verifyWorkspace: async (t: Task) => t.branch,
    createAgent: async (t: Task) => { calls.creates++; return { id: `agent-${t.id}`, workspaceId: t.workspaceId }; },
    observe: async (id: string): Promise<AgentObservation> => {
      calls.observes++;
      if (gatedAgent === id) await gate;
      return { id, workspaceId: `ws-${id.slice(6)}`, status: 'idle', active: false, permissions: false, error: '' };
    },
    archiveAgent: async () => { calls.archives++; },
    archiveTaskWorkspace: async () => true,
    verifyPr: async () => ({ url: 'https://example.test/pull/1', head: 'b'.repeat(40) }),
    findOpenBranchPr: async () => [],
    originAgent: async (id: string) => ({ id, workspaceId: 'origin-ws', archived: false, status: 'idle', title: id }),
  } as unknown as Adapter);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [profile];
  store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', weight: 1, scopes: ['general'] }]);
  engine.store.setMeta('paused', true);
  return {
    dir, path, store, calls, adapter, engine,
    blockObserve: (agentId: string) => { gatedAgent = agentId; gate = new Promise<void>(resolve => { openGate = resolve; }); },
    releaseObserve: () => { openGate?.(); },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const cancel = (task: Task, reason = 'Superseded by a later ruling') => ({
  type: 'task_control' as const,
  control: { taskId: task.id, version: task.version, action: 'cancel' as const, reason, workDisposition: 'preserve' as const },
});
const resumeWorker = (task: Task, instruction = 'Continue the original handoff') => ({
  type: 'task_control' as const,
  control: { taskId: task.id, version: task.version, action:'restart' as const,role:'worker',reason:'Resume the retained worker', instruction },
});
/** Narrow an acceptance envelope; a test helper so assertions read cleanly. */
const opened = (value: OperationAcceptance) => {
  if (!('accepted' in value)) throw new Error(`Expected an accepted operation, received backpressure: ${value.reason}`);
  return value.operation;
};
const waitFor = async (predicate: () => boolean, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise(resolve => setTimeout(resolve, 5)); }
  return predicate();
};

test('acceptance is idempotent on the caller key and fails closed on different input', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, '/project-a');
    const payload = cancel(task);
    const first = await f.engine.startOperation({ key: 'op-key-1', kind: 'task_control', payload, taskId: task.id, expectedVersion: task.version });
    assert.ok('accepted' in first);
    const replay = await f.engine.startOperation({ key: 'op-key-1', kind: 'task_control', payload, taskId: task.id, expectedVersion: task.version });
    assert.ok('accepted' in replay);
    assert.equal(replay.operation.id, first.operation.id);
    assert.equal(replay.operation.id, operationIdForKey('op-key-1'));
    assert.equal(f.store.operations({ limit: 50 }).length, 1);
    await assert.rejects(
      f.engine.startOperation({ key: 'op-key-1', kind: 'task_control', payload: cancel(task, 'Different reason'), taskId: task.id, expectedVersion: task.version }),
      /different input/,
    );
    assert.equal(f.store.operations({ limit: 50 }).length, 1);
    const settled = await f.engine.awaitOperation(opened(first).id);
    assert.equal(settled.state, 'succeeded');
    assert.equal(settled.result?.taskId, task.id);
    const succeededReplay = opened(await f.engine.startOperation({ key: 'op-key-1', kind: 'task_control', payload, taskId: task.id, expectedVersion: task.version }));
    assert.equal(succeededReplay.state, 'succeeded');
    assert.equal(succeededReplay.attempts, 1);
  } finally { await f.close(); }
});

test('a draft_promote row stays readable, the RPC refuses a new one, and a stored unsettled one fails closed', async () => {
  const f = fixture();
  try {
    const payload = { type: 'draft_promote', id: 'draft-1', digest: `sha256:${'a'.repeat(64)}` };
    assert.equal(operationStart.input.safeParse({ key: 'draft-rpc', kind: 'draft_promote', payload }).success, false);
    const refused = opened(await f.engine.startOperation({ key: 'draft-engine', kind: 'draft_promote', payload }));
    const settled = await f.engine.awaitOperation(refused.id);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.result, null);
    const historical = f.store.putOperation({ ...settled, state: 'succeeded', diagnostic: '' });
    assert.equal(f.store.operation(historical.id)?.kind, 'draft_promote');
    assert.equal(f.store.operations({ limit: 10 }).find(item => item.id === historical.id)?.kind, 'draft_promote');
  } finally { await f.close(); }
});

test('saturation returns typed backpressure instead of storing an unserviceable operation', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, '/project-a');
    f.blockObserve(task.agentId!);
    f.store.setMeta('operationLimit', 1);
    const first = await f.engine.startOperation({ key: 'busy', kind: 'task_control', payload: cancel(task), taskId: task.id, expectedVersion: task.version });
    assert.ok('accepted' in first);
    assert.ok(await waitFor(() => f.store.operation(opened(first).id)?.state === 'running'), 'the slow operation must own the lane');
    const second = await f.engine.startOperation({ key: 'busy-2', kind: 'task_control', payload: cancel(task), taskId: task.id, expectedVersion: task.version });
    assert.ok('backpressured' in second);
    assert.equal(second.pending, 1);
    assert.ok(second.retryAfterMs > 0);
    assert.match(second.reason, /bound/);
    assert.equal(f.store.operations({ limit: 50 }).length, 1, 'backpressure never stores an unserviceable operation');
    f.releaseObserve();
    assert.equal((await f.engine.awaitOperation(opened(first).id)).state, 'succeeded');
  } finally { await f.close(); }
});

timingTest('an unrelated control is accepted and read while another repository holds a remote effect', async () => {
  const f = fixture();
  try {
    const slow = dispatched(f.store, '/project-a');
    const other = dispatched(f.store, '/project-b');
    f.blockObserve(slow.agentId!);
    const slowAcceptance = await f.engine.startOperation({ key: 'slow-cancel', kind: 'task_control', payload: cancel(slow), taskId: slow.id, expectedVersion: slow.version });
    assert.ok('accepted' in slowAcceptance);
    assert.ok(await waitFor(() => f.store.operation(opened(slowAcceptance).id)?.state === 'running'), 'the slow lane must be blocked on its remote effect');
    // Acceptance and reads for an unrelated task and repository stay bounded
    // while the divergent lane is still awaiting its effect.
    const started = process.cpuUsage();
    const fastAcceptance = await f.engine.startOperation({ key: 'fast-cancel', kind: 'task_control', payload: cancel(other), taskId: other.id, expectedVersion: other.version });
    const acceptanceMs = cpuTimeMs(started);
    const readStart = process.cpuUsage();
    const read = f.engine.operationStatus(opened(slowAcceptance).id);
    const readMs = cpuTimeMs(readStart);
    assert.ok('accepted' in fastAcceptance);
    performanceAssert(acceptanceMs <= 150, `unrelated acceptance took ${acceptanceMs.toFixed(1)} ms`);
    performanceAssert(readMs <= 100, `operation read took ${readMs.toFixed(1)} ms`);
    assert.equal(read.state, 'running', 'the slow operation stays unresolved while the unrelated command is accepted');
    // The bounded compatibility wait returns the accepted identity rather than
    // hanging until the remote effect finishes.
    const bounded = await f.engine.awaitOperation(opened(fastAcceptance).id, 1);
    assert.ok(['pending', 'running', 'succeeded'].includes(bounded.state));
    f.releaseObserve();
    assert.equal((await f.engine.awaitOperation(opened(slowAcceptance).id)).state, 'succeeded');
  } finally { await f.close(); }
});

test('same-task versioned controls stay ordered and a stale version fails before effect', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, '/project-a');
    const first = await f.engine.startOperation({ key: 'first-cancel', kind: 'task_control', payload: cancel(task), taskId: task.id, expectedVersion: task.version });
    assert.ok('accepted' in first);
    // A second control queued behind the first on the same task lane must
    // observe the advanced version and fail before issuing any effect.
    const stale = await f.engine.startOperation({ key: 'stale-resume', kind: 'task_control', payload: resumeWorker(task), taskId: task.id, expectedVersion: task.version });
    assert.ok('accepted' in stale);
    assert.equal((await f.engine.awaitOperation(opened(first).id)).state, 'succeeded');
    const settled = await f.engine.awaitOperation(opened(stale).id);
    assert.equal(settled.state, 'failed');
    assert.match(settled.diagnostic, /Task changed/);
    assert.equal(f.store.task(task.id).phase, 'cancelled');
    assert.equal(f.store.operations({ states: ['succeeded'] }).length, 1, 'only the ordered command settled');
  } finally { await f.close(); }
});

test('identical retries reopen one failed task control and keep its identity and attempt count', async () => {
  const f = fixture();
  try {
    const created = dispatched(f.store, '/project-a');
    const absent = f.store.update(created.id, {
      phase: 'needs_attention', reason: ABSENT_WORKER_REASON, agentIntent: true, agentId: null, runId: 'absent-run',
      workspaceId: 'ws-absent', directory: '/fixture', profile, profileGroup: 'test',
    });
    f.store.setCredential('absent-run', 'absent-token');
    f.store.setMeta('paused', false);
    let matches = 1;
    let lookups = 0;
    f.adapter.findAgents = async () => { lookups++; return matches ? [{ id: 'still-visible', workspaceId: 'ws-absent' }] : []; };
    const payload = resumeWorker(absent);
    const request = { key: 'failed-control-retry', kind: 'task_control' as const, payload, taskId: absent.id, expectedVersion: absent.version };
    const first = opened(await f.engine.startOperation(request));
    const failed = await f.engine.awaitOperation(first.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.diagnostic, /no longer proven absent/);
    assert.equal(failed.attempts, 1);
    matches = 0;
    const retries = await Promise.all(Array.from({ length: 5 }, () => f.engine.startOperation(request)));
    for (const retry of retries) {
      const operation = opened(retry);
      assert.equal(operation.id, first.id);
      assert.equal(operation.createdAt, first.createdAt);
      assert.ok([1, 2].includes(operation.attempts));
      assert.ok(['pending', 'running'].includes(operation.state));
    }
    const succeeded = await f.engine.awaitOperation(first.id);
    assert.equal(succeeded.state, 'succeeded');
    assert.equal(succeeded.attempts, 2);
    assert.equal(lookups, 2, 'concurrent acceptance schedules one re-run');
    assert.equal(f.store.operations({ limit: 50 }).length, 1);
    assert.ok(f.store.task(absent.id).version > absent.version);
    await assert.rejects(f.engine.startOperation({ ...request, payload: resumeWorker(absent, 'Changed instruction') }), /different input/);
  } finally { await f.close(); }
});

test('an uncertain external effect is recorded as durable intent, not retried blindly', async () => {
  const f = fixture();
  try {
    const created = dispatched(f.store, '/project-a');
    const absent = f.store.update(created.id, {
      phase: 'needs_attention', reason: ABSENT_WORKER_REASON, agentIntent: true, agentId: null, runId: 'absent-run',
      workspaceId: 'ws-absent', directory: '/fixture', profile, profileGroup: 'test',
    });
    f.store.setCredential('absent-run', 'absent-token');
    f.store.setMeta('paused', false);
    f.adapter.findAgents = async () => { throw new Error('connection lost while looking up the worker'); };
    const payload = resumeWorker(absent);
    const acceptance = await f.engine.startOperation({ key: 'uncertain', kind: 'task_control', payload, taskId: absent.id, expectedVersion: absent.version });
    assert.ok('accepted' in acceptance);
    const settled = await f.engine.awaitOperation(opened(acceptance).id);
    assert.equal(settled.state, 'needs_attention');
    assert.match(settled.diagnostic, /connection lost/);
    assert.equal(settled.effect?.status, 'uncertain');
    assert.equal(settled.effect?.kind, 'task_control');
    assert.equal(settled.attempts, 1);
    // Repeating the same command returns the same durable decision and never
    // issues the effect again.
    const replay = await f.engine.startOperation({ key: 'uncertain', kind: 'task_control', payload, taskId: absent.id, expectedVersion: absent.version });
    assert.ok('accepted' in replay);
    assert.equal(replay.operation.id, acceptance.operation.id);
    assert.equal(replay.operation.state, 'needs_attention');
    assert.equal(replay.operation.attempts, 1);
  } finally { await f.close(); }
});

test('stop() is bounded with queued lanes and never skips the lease release', async () => {
  const f = fixture();
  const ran: string[] = [];
  const failures: unknown[] = [];
  try {
    // With no global lane cap the only queued item is a same-key successor. The
    // active quanta finish and the queued successor is failed rather than parked,
    // so unload always releases the process lease.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = [0, 1].map(index => f.engine.scheduleLane(`lane:${index}`, 2, async () => { await gate; ran.push(`lane:${index}`); }));
    const queued = f.engine.scheduleLane('lane:0', 2, async () => { ran.push('lane:0:successor'); }).catch(error => { failures.push(error); });
    // Lanes start on a later macrotask, so let the two active quanta begin.
    await new Promise<void>(resolve => setImmediate(resolve));
    f.engine.stopped = true; // runtime.stop() flips this before engine.stop()
    release();
    const stopStarted = performance.now();
    await Promise.race([
      f.engine.stop(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('engine.stop() wedged with queued lanes')), 2_000)),
    ]);
    assert.ok(performance.now() - stopStarted < 2_000, 'stop() must be bounded');
    assert.deepEqual(ran.sort(), ['lane:0', 'lane:1'], 'active quanta finish, the queued successor does not start');
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]), /stopped before this quantum ran/);
    await Promise.allSettled([...started, queued]);
  } finally { await f.close(); }
});

test('there is no global lane cap, while one key still never runs two quanta', async () => {
  const f = fixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    for (let index = 0; index < 32; index++)
      void f.engine.scheduleLane(`lane:${index}`, 2, async () => { started.push(`lane:${index}`); await gate; });
    // Every independent lane starts at once: a blanket cap must not park work.
    // Starts are chunked across macrotasks, so wait for the last chunk.
    const deadline = Date.now() + 1_000;
    while (started.length < 32 && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.equal(started.length, 32, 'no global lane cap parks independent work');
    // A key is still an ordered queue: its second quantum cannot overlap the first.
    let running = 0, overlapped = false;
    let releaseShared!: () => void;
    const shared = new Promise<void>(resolve => { releaseShared = resolve; });
    const first = f.engine.scheduleLane('lane:shared', 2, async () => { running++; if (running > 1) overlapped = true; await shared; running--; });
    const second = f.engine.scheduleLane('lane:shared', 2, async () => { running++; if (running > 1) overlapped = true; running--; });
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(running, 1, 'one key holds exactly one active quantum');
    releaseShared();
    await first; await second;
    assert.equal(overlapped, false, 'same-key quanta never overlap');
    release();
    await f.engine.quiesce();
  } finally { await f.close(); }
});

test('a nested command lane cannot deadlock the concurrency slots', async () => {
  const f = fixture();
  try {
    // Four task-scoped commands each run their own nested task control. If the
    // command lane and its control were separate lanes, the shared key would wait
    // on itself and never finish.
    const tasks = [0, 1, 2, 3].map(() => dispatched(f.store, '/project-a'));
    const acceptance = await Promise.all(tasks.map((task, index) =>
      f.engine.startOperation({ key: `nested-${index}`, kind: 'task_control', payload: cancel(task), taskId: task.id, expectedVersion: task.version })));
    for (const value of acceptance) assert.ok('accepted' in value);
    const settled = await Promise.race([
      Promise.all(acceptance.map(value => f.engine.awaitOperation(opened(value).id, 5_000))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('nested command lanes deadlocked')), 5_000)),
    ]);
    for (const operation of settled) assert.equal(operation.state, 'succeeded');
    for (const task of tasks) assert.equal(f.store.task(task.id).phase, 'cancelled');
  } finally { await f.close(); }
});

test('restart reconciles an unfinished operation exactly once', async () => {
  const first = fixture();
  const operationKey = 'restart-operation';
  let operationId: string;
  try {
    const task = dispatched(first.store, '/project-a');
    const payload = cancel(task);
    // Persist the accepted operation without running it, exactly as a process
    // that stopped between acceptance and its lane would leave it.
    const acceptance = first.store.acceptOperation({
      key: operationKey, kind: 'task_control', inputHash: operationInputHash(payload),
      taskId: task.id, expectedVersion: task.version, hostId: task.hostId, payload,
    });
    assert.ok('accepted' in acceptance);
    operationId = acceptance.operation.id;
    first.store.putOperation({ ...acceptance.operation, state: 'running', startedAt: new Date().toISOString(), attempts: 1 });
  } finally { await first.engine.stop(); first.store.close(); }

  const reopened = new Store(first.path);
  const calls = { observes: 0, archives: 0 };
  const adapter = {
    observe: async (id: string) => { calls.observes++; return { id, workspaceId: id, status: 'idle', active: false, permissions: false, error: '' }; },
    archiveAgent: async () => { calls.archives++; },
  } as unknown as Adapter;
  const engine = new Engine(reopened, adapter, 0);
  try {
    engine.resumeOperations();
    await engine.quiesce();
    assert.equal(reopened.operation(operationId)?.state, 'succeeded');
    assert.equal(calls.observes, 1);
    // A second bootstrap cannot reissue a settled effect.
    engine.resumeOperations();
    await engine.quiesce();
    assert.equal(calls.observes, 1);
  } finally { await engine.stop(); reopened.close(); rmSync(first.dir, { recursive: true, force: true }); }
});

test('operation summaries stay bounded and carry queued/running/attention state', async () => {
  const f = fixture();
  try {
    const task = dispatched(f.store, '/project-a');
    const acceptance = await f.engine.startOperation({ key: 'summary', kind: 'task_control', payload: cancel(task), taskId: task.id, expectedVersion: task.version });
    assert.ok('accepted' in acceptance);
    const operation = f.store.operation(opened(acceptance).id)!;
    const summary = operationSummarySchema.parse({
      id: operation.id, key: operation.key, kind: operation.kind, state: operation.state,
      taskId: operation.taskId, expectedVersion: operation.expectedVersion, submissionId: operation.submissionId,
      createdAt: operation.createdAt, settledAt: operation.settledAt, diagnostic: operation.diagnostic, result: operation.result,
    });
    assert.equal(summary.taskId, task.id);
    assert.equal(summary.expectedVersion, task.version);
    assert.ok(JSON.stringify(summary).length < 1200);
    assert.equal((await f.engine.awaitOperation(operation.id)).state, 'succeeded');
  } finally { await f.close(); }
});

test('Spec 021 #7 submission result and operation status carry number and reference', async () => {
  const f = fixture();
  try {
    f.store.setMeta('hostId', 'fixture-host');
    const root = f.dir;
    await git(root, 'init', '--bare', join(root, 'origin.git'));
    await git(root, 'clone', join(root, 'origin.git'), join(root, 'repo'));
    const repo = join(root, 'repo');
    await git(repo, 'checkout', '-b', 'main');
    await git(repo, 'config', 'user.name', 'Queue test');
    await git(repo, 'config', 'user.email', 'queue@example.invalid');
    mkdirSync(join(repo, 'docs/handoffs'), { recursive: true });
    writeFileSync(join(repo, 'docs/handoffs/test.md'), '# Handoff\n\nConcrete instructions.\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'Committed handoff');
    await git(repo, 'push', 'origin', 'main');
    const commit = await git(repo, 'rev-parse', 'HEAD');
    const base = { submissionId: 'sub-operation', title: 'Submitted', repoPath: repo, planningCommit: commit, originAgentId: 'origin' };

    // A missing handoff blob is a deterministic local rejection: the operation
    // is durable, records the failure, and creates no task.
    const invalid = submissionSchema.parse({ ...base, handoffPath: 'docs/handoffs/missing.md' });
    const rejected = await f.engine.startOperation({ key: `submit:${invalid.submissionId}`, kind: 'submit', payload: { type: 'submit', submission: invalid }, submissionId: invalid.submissionId, repoPath: invalid.repoPath });
    assert.ok('accepted' in rejected);
    assert.ok(f.store.operationForKey(`submit:${invalid.submissionId}`), 'acceptance is durable before remote validation');
    const missing = await f.engine.awaitOperation(opened(rejected).id);
    assert.equal(missing.state, 'failed');
    assert.equal(f.store.tasks().length, 0, 'an invalid handoff still creates no task');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM task_numbers').get()?.count, 0);

    const submission = submissionSchema.parse({ ...base, submissionId: 'sub-valid', handoffPath: 'docs/handoffs/test.md' });
    const accepted = await f.engine.startOperation({ key: `submit:${submission.submissionId}`, kind: 'submit', payload: { type: 'submit', submission }, submissionId: submission.submissionId, repoPath: submission.repoPath });
    assert.ok('accepted' in accepted);
    const ok = await f.engine.awaitOperation(opened(accepted).id);
    assert.equal(ok.state, 'succeeded');
    assert.ok(ok.result?.taskId);
    assert.equal(ok.result?.number, 1);
    assert.equal(ok.result?.reference, 'repo#001');
    assert.equal(f.engine.operationStatus(ok.id).result?.reference, 'repo#001');
    assert.equal(ok.taskId, ok.result?.taskId, 'the settled operation names the task it created');
    assert.equal(f.store.tasks().length, 1);
    const replay = await f.engine.startOperation({ key: `submit:${submission.submissionId}`, kind: 'submit', payload: { type: 'submit', submission }, submissionId: submission.submissionId, repoPath: submission.repoPath });
    assert.ok('accepted' in replay);
    assert.equal(replay.operation.id, accepted.operation.id);
    assert.equal(f.store.tasks().length, 1);
    assert.equal(f.store.task(ok.result!.taskId!).title, 'Submitted');

    // The same submitted input can succeed once a definite recipient refusal
    // is repaired without changing the planning commit or submission ID.
    const repairable = submissionSchema.parse({ ...base, submissionId: 'sub-repairable', handoffPath: 'docs/handoffs/test.md', notifyOriginOnCloseout: true });
    f.adapter.originAgent = async () => null;
    const repairRequest = { key: `submit:${repairable.submissionId}`, kind: 'submit' as const,
      payload: { type: 'submit', submission: repairable }, submissionId: repairable.submissionId, repoPath: repairable.repoPath };
    const refused = opened(await f.engine.startOperation(repairRequest));
    const failed = await f.engine.awaitOperation(refused.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.attempts, 1);
    f.adapter.originAgent = async (id: string) => ({ id, workspaceId: 'origin-ws', archived: false, status: 'idle', title: id });
    const reopened = opened(await f.engine.startOperation(repairRequest));
    assert.equal(reopened.id, refused.id);
    assert.equal(reopened.state, 'pending');
    assert.equal(reopened.attempts, 1);
    const repaired = await f.engine.awaitOperation(refused.id);
    assert.equal(repaired.state, 'succeeded', repaired.diagnostic);
    assert.equal(repaired.attempts, 2);
    assert.equal(repaired.result?.taskId, f.store.existing(repairable)?.id);

    // A lane attached at submission survives the pre-dispatch preview's throwaway store.
    f.store.upsertLane({ key: 'lean-northstar', title: 'Lean', aim: 'Move task state into Queue', repositories: [{ origin: 'example/repo', path: repo }] });
    const laned = submissionSchema.parse({ ...base, submissionId: 'sub-laned', handoffPath: 'docs/handoffs/test.md', lanes: ['lean-northstar'] });
    const lanedAccepted = await f.engine.startOperation({ key: `submit:${laned.submissionId}`, kind: 'submit', payload: { type: 'submit', submission: laned }, submissionId: laned.submissionId, repoPath: laned.repoPath });
    assert.ok('accepted' in lanedAccepted);
    const lanedOk = await f.engine.awaitOperation(opened(lanedAccepted).id);
    assert.equal(lanedOk.state, 'succeeded', lanedOk.diagnostic);
    assert.deepEqual(f.store.task(lanedOk.result!.taskId!).lanes, ['lean-northstar']);
  } finally { await f.close(); }
});

/** 32-hex-digit Effigy scope token, as `effigy container scope --json` reports it. */
const SCOPE_TOKEN = 'ab'.repeat(16);
/** Mark a directory as an Effigy ephemeral-clone checkout so runtime-scope capture shells out. */
function markEphemeralCheckout(dir: string) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  appendFileSync(join(dir, '.git', 'config'), '\n[effigy]\n\truntimeScope = ephemeral\n');
  writeFileSync(join(dir, '.git', 'effigy-runtime-scope'), `${SCOPE_TOKEN}\n`);
}
/** Mutable Effigy gate: invocations block while `current` is set. A box (not a
 * narrowed local) so the releaser stays callable across awaits. */
interface EffigyGate { current: Promise<void> | null; release: () => void; }
const holdEffigyGate = (gate: EffigyGate) => {
  gate.current = new Promise<void>(resolve => { gate.release = resolve; });
};
const releaseEffigyGate = (gate: EffigyGate) => {
  gate.current = null;
  gate.release();
};
/** An Effigy CLI fake whose calls block while the test holds the gate. */
function gatedEffigy(gate: EffigyGate): EffigyInvoke {
  return async args => {
    const current = gate.current;
    if (current) await current;
    if (args[0] === 'container' && args[1] === 'scope')
      return { code: 0, timedOut: false, spawnError: '', output: JSON.stringify({ scope: { kind: 'ephemeral-clone', token: SCOPE_TOKEN } }) };
    return { code: 0, timedOut: false, spawnError: '', output: '' };
  };
}

test('a slow Effigy retirement returns an accepted removal operation that settles removed, and replays idempotently', async () => {
  const f = fixture();
  try {
    // A stopped task with a scoped workspace, like the 65 s runtime-scope
    // capture and retirement that timed out the CLI. Thread observation stays
    // fast; the stall is inside the Effigy capture and retire calls.
    const wsDir = join(f.dir, 'ws');
    mkdirSync(wsDir, { recursive: true });
    markEphemeralCheckout(wsDir);
    const effigyGate: EffigyGate = { current: null, release: () => {} };
    (f.engine as unknown as { retirement: RuntimeRetirementService }).retirement =
      new RuntimeRetirementService(f.store, gatedEffigy(effigyGate));
    const inserted = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Slow removal', repoPath: '/project-a', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
    const task = f.store.update(inserted.id, { phase: 'blocked', agentId: 'agent-slow-remove', workspaceId: 'ws-slow-remove', directory: wsDir });
    holdEffigyGate(effigyGate);
    const payload = { type: 'task_remove' as const, taskId: task.id, version: task.version };
    const acceptance = await f.engine.startOperation({ key: 'slow-remove', kind: 'task_remove', payload, taskId: task.id, expectedVersion: task.version });
    assert.ok('accepted' in acceptance);
    const id = opened(acceptance).id;
    assert.ok(await waitFor(() => f.store.operation(id)?.state === 'running'), 'the slow removal must stall inside Effigy capture');
    // The bounded compatibility wait returns the accepted identity instead of
    // hanging until the retirement finishes.
    const bounded = await f.engine.awaitOperation(id, 1);
    assert.ok(['pending', 'running'].includes(bounded.state), `expected an unsettled operation, got ${bounded.state}`);
    // operation-status observes the same durable operation while it runs.
    const read = f.engine.operationStatus(id);
    assert.ok(['pending', 'running'].includes(read.state));
    assert.equal(read.taskId, task.id);
    releaseEffigyGate(effigyGate);
    const settled = await f.engine.awaitOperation(id);
    assert.equal(settled.state, 'succeeded', settled.diagnostic);
    assert.equal(settled.result?.taskId, task.id);
    assert.ok(f.store.task(task.id).removedAt, 'the slow removal settles removed');
    assert.ok(f.store.task(task.id).resolution.runtimeRetirements.some(record => record.state === 'retired'),
      'the settled removal proves the Effigy retirement it stalled in');
    // Repeating the same key and input replays the stored outcome.
    const replay = await f.engine.startOperation({ key: 'slow-remove', kind: 'task_remove', payload, taskId: task.id, expectedVersion: task.version });
    assert.ok('accepted' in replay);
    assert.equal(replay.operation.id, id);
    assert.equal(replay.operation.state, 'succeeded');
    assert.equal(replay.operation.attempts, 1);
    // An already-removed task returns as removed under a fresh key, and even a
    // stale version against direct removal stays idempotent once removed.
    const current = f.store.task(task.id);
    const fresh = await f.engine.startOperation({ key: 'slow-remove-again', kind: 'task_remove',
      payload: { type: 'task_remove' as const, taskId: task.id, version: current.version }, taskId: task.id, expectedVersion: current.version });
    assert.ok('accepted' in fresh);
    const resettled = await f.engine.awaitOperation(opened(fresh).id);
    assert.equal(resettled.state, 'succeeded', resettled.diagnostic);
    assert.ok(f.store.task(task.id).removedAt);
    const direct = await f.engine.removeTask(task.id, task.version);
    assert.ok(direct.removedAt, 'direct removal of an already-removed task returns it as removed');
  } finally { await f.close(); }
});

/**
 * The public `queue.remove` compatibility wrapper against a retirement that
 * outlives the bounded wait: the wrapper must return the accepted operation
 * instead of timing out the caller, then settle and replay removed.
 */
timingTest('queue.remove returns its accepted operation when Effigy retirement outlives the compatibility wait', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nsq-remove-')));
  let runtime: QueueRuntime | null = null;
  const effigyGate: EffigyGate = { current: null, release: () => {} };
  try {
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const wsDir = join(root, 'ws');
    mkdirSync(wsDir, { recursive: true });
    markEphemeralCheckout(wsDir);
    const adapter = {
      client: { isConnected: true }, hostId: 'host',
      socketPath: join(root, 'callback.sock'), helperPath: join(root, 'worker-report.mjs'),
      connect: async () => {}, close: async () => {}, profiles: async () => [profile],
      observe: observeIdle('ws'),
      archiveAgent: async () => {},
      archiveTaskWorkspace: async () => true,
    } as unknown as Adapter;
    runtime = new QueueRuntime({ dataDir, adapterFactory: () => adapter, timers: false });
    await runtime.started;
    (runtime.engine as unknown as { retirement: RuntimeRetirementService }).retirement =
      new RuntimeRetirementService(runtime.store, gatedEffigy(effigyGate));
    const inserted = runtime.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Slow wrapper removal', repoPath: '/project-a', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
    const task = runtime.store.update(inserted.id, { phase: 'blocked', agentId: 'agent-slow-wrapper', workspaceId: 'ws-slow-wrapper', directory: wsDir });
    holdEffigyGate(effigyGate);
    const result = await runtime.removeTask({ taskId: task.id, version: task.version });
    assert.ok('accepted' in result, 'a removal that outlives the compatibility wait returns its accepted operation');
    const status = runtime.operationStatus({ operationId: result.operation.id });
    assert.equal(status.taskId, task.id);
    assert.ok(['pending', 'running'].includes(status.state));
    releaseEffigyGate(effigyGate);
    const settled = await runtime.engine.awaitOperation(result.operation.id);
    assert.equal(settled.state, 'succeeded', settled.diagnostic);
    assert.ok(runtime.store.task(task.id).removedAt, 'the slow wrapper removal settles removed');
    assert.ok(runtime.store.task(task.id).resolution.runtimeRetirements.some(record => record.state === 'retired'),
      'the settled removal proves the Effigy retirement it stalled in');
    const replay = await runtime.removeTask({ taskId: task.id, version: task.version });
    assert.ok(!('accepted' in replay) && !('backpressured' in replay), 'replaying a settled removal returns the removed task');
    assert.ok(replay.removedAt);
  } finally {
    releaseEffigyGate(effigyGate);
    if (runtime) await runtime.drain();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a task_remove operation fails closed when caller metadata disagrees with its payload', async () => {
  const f = fixture();
  try {
    const inserted = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Removal identity', repoPath: '/project-a', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
    const task = f.store.update(inserted.id, { phase: 'blocked' });
    const payload = { type: 'task_remove' as const, taskId: task.id, version: task.version };
    await assert.rejects(
      f.engine.startOperation({ key: 'remove-wrong-task', kind: 'task_remove', payload, taskId: 'other-task', expectedVersion: task.version }),
      /does not match its payload/,
    );
    await assert.rejects(
      f.engine.startOperation({ key: 'remove-wrong-version', kind: 'task_remove', payload, taskId: task.id, expectedVersion: task.version + 1 }),
      /does not match its payload/,
    );
    assert.equal(f.store.operations({ limit: 50 }).length, 0, 'a refused removal stores no operation');
    // Omitted top-level identity normalizes from the payload, so the durable
    // record and its lane always name the task the payload removes.
    const normalized = opened(await f.engine.startOperation({ key: 'remove-normalized', kind: 'task_remove', payload }));
    assert.equal(normalized.taskId, task.id);
    assert.equal(normalized.expectedVersion, task.version);
    const settled = await f.engine.awaitOperation(normalized.id);
    assert.equal(settled.state, 'succeeded', settled.diagnostic);
    assert.ok(f.store.task(task.id).removedAt);
  } finally { await f.close(); }
});

test('host reconnect does not reconcile a promotion still owned by this service', async () => {
  const f = fixture();
  try {
    let reads = 0;
    const original = f.store.sourcePromotionsForReconciliation.bind(f.store);
    f.store.sourcePromotionsForReconciliation = () => { reads++; return original(); };
    f.engine.resumeOperations(false);
    assert.equal(reads, 1, 'reconnect inspects but does not reconcile live promotions');
    f.engine.resumeOperations();
    assert.equal(reads, 2, 'a fresh service still reconciles interrupted promotions');
  } finally { await f.close(); }
});
