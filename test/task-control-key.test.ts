import { observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { QueueRuntime } from '../service/runtime-owner';
import { operationInputHash, type Store } from '../core/store/store';
import { TASK_CONTROL_KEY_LIMIT, taskControlOperation } from '../core/verbs/task-control-key';
import { queueOperationSchema } from '../shared/operations';
import { submissionSchema, taskControlInputSchema, type TaskControlInput } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { callCatalogueMethod } from '../service/transport/dispatch';

/**
 * The legacy `queue.task` adapter generates its own durable operation key. The
 * key must stay deterministic for identical input, separate corrected input at
 * the unchanged task version, preserve readable task/action/version identity and
 * fit the 200-character caller-key bound.
 */

const control = (input: unknown): TaskControlInput => taskControlInputSchema.parse(input);

const resume = (taskId: string, version: number, instruction: string) =>
  control({ taskId, version, action:'restart',role:'worker',reason:'Resume the retained worker', instruction });

const supersede = (taskId: string, version: number, replacementTaskId: string, reason = 'Replaced by a later ruling') =>
  control({ taskId, version, action: 'supersede', replacementTaskId, reason, workDisposition: 'preserve' });

test('identical control input generates one key however the caller orders or omits optionals', () => {
  const canonical = resume('task-1', 7, 'Continue the immutable handoff');
  const first = taskControlOperation(canonical);
  // Reordered keys and an explicitly absent optional describe the same control.
  const reordered = taskControlOperation(taskControlInputSchema.parse({
    instruction: 'Continue the immutable handoff', version: 7, taskId: 'task-1', action:'restart',role:'worker', reason:'Resume the retained worker', fresh: undefined,
  }));
  assert.equal(reordered.key, first.key, 'the same control must always produce the same generated key');
  assert.deepEqual(reordered.payload, first.payload, 'and the same canonical durable payload');
  assert.equal(taskControlOperation(canonical).key, first.key, 'generation stays deterministic across calls');
  assert.ok(first.key.endsWith(operationInputHash(first.payload)), 'the key carries the exact normalized input digest acceptance fences on');
});

test('a corrected instruction, effect or disposition changes the key at the unchanged task version', () => {
  const base = supersede('task-1', 7, 'replacement-a');
  const baseKey = taskControlOperation(base).key;
  const prefix = 'task-control:task-1:supersede:7:';
  assert.ok(baseKey.startsWith(prefix), 'task, action and version stay readable in the generated prefix');
  const changed: [string, TaskControlInput][] = [
    ['replacement', supersede('task-1', 7, 'replacement-b')],
    ['work disposition', control({ taskId: 'task-1', version: 7, action: 'supersede', replacementTaskId: 'replacement-a', reason: 'Replaced by a later ruling', workDisposition: 'retained_by_replacement' })],
    ['reason', supersede('task-1', 7, 'replacement-a', 'Replaced by a corrected ruling')],
    ['instruction', resume('task-1', 7, 'First bounded instruction')],
    ['changed instruction', resume('task-1', 7, 'Corrected bounded instruction that was previously rejected')],
    ['effect identity', control({ taskId: 'task-1', version: 7, action: 'retry_effect', effect: 'hook.hook-event-a', reason: 'Retry the held hook' })],
    ['explicit unpublished checkout discard', control({ taskId: 'task-1', version: 7, action: 'retry_effect', effect: 'hook.hook-event-a', reason: 'Retry the held hook', discard: true })],
    ['changed effect identity', control({ taskId: 'task-1', version: 7, action: 'retry_effect', effect: 'hook.hook-event-b', reason: 'Retry the held hook' })],
    ['dependencies', control({ taskId: 'task-1', version: 7, action: 'set_dependencies', dependsOn: ['task-2'] })],
    ['retained prerequisite wait', control({ taskId: 'task-1', version: 7, action: 'set_prerequisite_wait', waitsFor: ['task-2'], reason: 'Wait for source evidence' })],
    ['task version', supersede('task-1', 8, 'replacement-a')],
    ['task identity', supersede('task-2', 7, 'replacement-a')],
  ];
  const seen = new Map<string, string>([[baseKey, 'base']]);
  for (const [label, input] of changed) {
    const generated = taskControlOperation(input).key;
    assert.notEqual(generated, baseKey, `${label} must not reuse the rejected control's key`);
    assert.ok(!seen.has(generated), `${label} must not collide with another material change`);
    seen.set(generated, label);
  }
});



test('the generated key stays inside the caller-key bound and refuses to truncate identity', () => {
  // The helper's bound must be the operation contract's own caller-key bound.
  assert.equal(TASK_CONTROL_KEY_LIMIT, queueOperationSchema.shape.key.maxLength, 'the generated-key bound must match the operation key contract');
  const realistic = resume('f51dbb8f-72d5-4ef6-8ed0-d128f4dccb7e', 999999999, 'x'.repeat(12000));
  const generated = taskControlOperation(realistic);
  assert.ok(generated.key.length <= TASK_CONTROL_KEY_LIMIT, `generated key length ${generated.key.length} must stay inside the contract bound`);
  assert.ok(queueOperationSchema.shape.key.safeParse(generated.key).success, 'the generated key must satisfy the operation key contract');
  assert.equal(generated.key.slice(-64), operationInputHash(generated.payload), 'the bounded key ends with the normalized input digest');
  // The instruction never inflates the key: only its digest reaches the key.
  assert.equal(taskControlOperation(resume('f51dbb8f-72d5-4ef6-8ed0-d128f4dccb7e', 999999999, 'y')).key.length, generated.key.length);
  // A prefix too long for the bound fails closed instead of silently colliding two identities.
  const oversized = resume('t'.repeat(TASK_CONTROL_KEY_LIMIT), 1, 'Instruction');
  assert.throws(() => taskControlOperation(oversized), /caller-key bound/);
});

/** Minimal fake adapter: enough of the Paseo surface for a quiet fixture store. */
function fakeAdapter(dataDir: string): Adapter {
  return {
    client: { isConnected: true }, hostId: 'fixture-host',
    socketPath: join(dataDir, 'callback.sock'), helperPath: join(dataDir, 'worker-helper.mjs'),
    connect: async () => {}, close: async () => {}, catalog: async () => ({ providers: [] }),
    observe: observeIdle('ws', 'worker'),
    archiveAgent: async () => {},
  } as unknown as Adapter;
}

function queued(store: Store, repoPath: string) {
  return store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: `Task ${repoPath}`, repoPath,
    planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'fixture-host', 'Handoff', 'a'.repeat(40));
}

test('runtime task controls and reads resolve references before scheduling and persist a concrete version', async () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'nsq-ref-')));
  const dataDir=join(root,'nucleus');
  const runtime=new QueueRuntime({dataDir,adapterFactory:()=>fakeAdapter(dataDir),timers:false});
  try {
    runtime.store.setMeta('paused',true);
    await runtime.ensureBootstrap();
    const task=queued(runtime.store,'/project-a');
    const reference=task.reference!;
    const detail=await callCatalogueMethod(runtime,'queue.detail',{taskId:reference}) as {task:{id:string}};
    assert.equal(detail.task.id,task.id);
    const next=await callCatalogueMethod(runtime,'task.next',{taskId:reference}) as {taskId:string;verbs:Array<{verb:string;available:boolean}>};
    assert.ok(next.verbs.some(verb=>verb.verb==='set_dependencies'&&verb.available));
    runtime.store.update(task.id,{title:'An owner edit since the read'});
    const applied=await callCatalogueMethod(runtime,'queue.task',{reference,action:'hold',reason:'Wait'}) as {id:string;held:boolean;changes:string[]};
    assert.equal(applied.id,task.id);
    assert.equal(applied.held,true);
    assert.ok(applied.changes.includes('held'));
    await assert.rejects(callCatalogueMethod(runtime,'queue.task',{taskId:reference,version:task.version,action:'release'}),/Task changed/);
    const current=runtime.store.task(task.id);
    await assert.rejects(callCatalogueMethod(runtime,'queue.task',{taskId:reference,action:'route',role:'worker',profileId:'missing-profile',reason:'Next route',now:true}));
    const operations=runtime.store.operations({taskId:task.id}).filter(operation=>operation.kind==='task_control');
    assert.equal(operations.length,1);
    assert.equal(operations[0].taskId,task.id);
    assert.equal(operations[0].expectedVersion,current.version);
    const payload=runtime.store.operationPayload(operations[0].id) as {control:{taskId:string;version:number}};
    assert.equal(payload.control.taskId,task.id);
    assert.equal(payload.control.version,current.version);
  } finally {await runtime.drain();rmSync(root,{recursive:true,force:true});}
});

test('the runtime adapter accepts a corrected supersede after a rejected one at the unchanged version', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nsq-key-')));
  const dataDir = join(root, 'northstar-queue');
  const runtime = new QueueRuntime({ dataDir, adapterFactory: () => fakeAdapter(dataDir), timers: false });
  try {
    runtime.store.setMeta('paused', true);
    await runtime.ensureBootstrap();
    const task = queued(runtime.store, '/project-a');
    const replacement = queued(runtime.store, '/project-a');

    // The first attempt is rejected by the control logic, not by acceptance: the
    // incident's unchanged task version must survive it.
    const rejected = supersede(task.id, task.version, 'missing-replacement-task');
    await assert.rejects(() => runtime.taskControl(rejected), /Replacement task does not exist/);
    assert.equal(runtime.store.task(task.id).version, task.version, 'a rejected control leaves the task version unchanged');
    const afterRejection = runtime.store.operations({ taskId: task.id });
    assert.equal(afterRejection.length, 1, 'the rejected control accepted exactly one durable operation');
    assert.equal(afterRejection[0].state, 'failed');

    // Corrected input at the same version reaches the control instead of
    // colliding with the failed operation's different input digest.
    const corrected = supersede(task.id, task.version, replacement.id, 'Superseded by the corrected replacement');
    const settled = await runtime.taskControl(corrected);
    if ('accepted' in settled) await runtime.engine.awaitOperation(settled.operation.id);
    assert.equal(runtime.store.task(task.id).phase, 'cancelled');
    const accepted = runtime.store.operations({ taskId: task.id });
    assert.equal(accepted.length, 2, 'the corrected control generated its own operation identity');
    assert.equal(accepted[0].key, taskControlOperation(rejected).key);
    assert.equal(accepted[1].state, 'succeeded');
    assert.notEqual(accepted[1].key, afterRejection[0].key);
    assert.equal(accepted[1].key, taskControlOperation(corrected).key);
    assert.equal(accepted[1].inputHash, operationInputHash(taskControlOperation(corrected).payload), 'the generated key and the stored input hash agree');

    // Repeating the rejected input re-checks current state under the original
    // identity. The completed disposition refuses a second effect.
    await assert.rejects(() => runtime.taskControl(rejected), /Task disposition is already complete/);
    const replayed = runtime.store.operations({ taskId: task.id });
    assert.equal(replayed.length, 2);
    assert.equal(replayed[0].id, afterRejection[0].id);
    assert.equal(replayed[0].state, 'failed');
    assert.equal(replayed[0].attempts, 2);
  } finally {
    await runtime.drain();
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit generic caller keys keep their immutable-input conflict rejection', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nsq-key-')));
  const dataDir = join(root, 'northstar-queue');
  const runtime = new QueueRuntime({ dataDir, adapterFactory: () => fakeAdapter(dataDir), timers: false });
  try {
    runtime.store.setMeta('paused', true);
    await runtime.ensureBootstrap();
    const task = queued(runtime.store, '/project-a');
    const key = 'operator-supplied-key';
    const first = await runtime.operationStart({ key, kind: 'task_control', payload: { type: 'task_control', control: control({ taskId: task.id, version: task.version, action:'hold',reason:'Test hold' }) } });
    assert.ok('accepted' in first);
    await assert.rejects(
      () => runtime.operationStart({ key, kind: 'task_control', payload: { type: 'task_control', control: control({ taskId: task.id, version: task.version, action: 'release' }) } }),
      /different input/,
      'an explicit caller key still rejects different input',
    );
    const replay = await runtime.operationStart({ key, kind: 'task_control', payload: { type: 'task_control', control: control({ taskId: task.id, version: task.version, action:'hold',reason:'Test hold' }) } });
    assert.ok('accepted' in replay);
    assert.equal(replay.operation.id, first.operation.id);
  } finally {
    await runtime.drain();
    rmSync(root, { recursive: true, force: true });
  }
});


test('a route with now is accepted as one durable operation; a route without now stays a local control (consumer-b #658)', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nsq-key-')));
  const dataDir = join(root, 'northstar-queue');
  const runtime = new QueueRuntime({ dataDir, adapterFactory: () => fakeAdapter(dataDir), timers: false });
  try {
    runtime.store.setMeta('paused', true);
    await runtime.ensureBootstrap();
    const task = queued(runtime.store, '/project-a');
    const route = (now?: boolean) => taskControlInputSchema.parse({ taskId: task.id, version: task.version, action: 'route',
      role: 'worker', profileId: 'missing-profile', reason: 'Route the author', ...(now === undefined ? {} : { now }) });
    await assert.rejects(() => runtime.taskControl(route()));
    assert.equal(runtime.store.operations({ taskId: task.id }).length, 0, 'a local route accepts no operation');
    await assert.rejects(() => runtime.taskControl(route(true)));
    const operations = runtime.store.operations({ taskId: task.id });
    assert.equal(operations.length, 1, 'the route with now was durably accepted before it ran');
    assert.equal(operations[0].key, taskControlOperation(route(true)).key);
    assert.equal(operations[0].state, 'failed');
  } finally {
    await runtime.drain();
    rmSync(root, { recursive: true, force: true });
  }
});
