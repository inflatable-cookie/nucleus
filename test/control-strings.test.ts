/**
 * String and error-class pins for the daemon split (lane `nucleus-simplify`,
 * split map row T5, rules 6 and 7).
 *
 * Some text in the daemon is control flow: code matches the words of an event
 * kind, a reason, a refusal or an event detail, and the class of an error decides
 * how an operation settles. The coming move PRs change no behaviour, so a move
 * that rewords a string or rewraps an error must fail here. Current behaviour is
 * the spec.
 *
 * Two kinds of pin. Tables drive the real funnel with the real text, so a reword
 * of either side changes the outcome. Where a fixture can't reach a reader, the
 * census names the reader and each writer's fixed text and looks for them in all
 * runtime roots named by the layout contract: moving code keeps them, rewording does not.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, operationIdForKey, operationInputHash } from '../core/store/store';
import { Engine, ExternalMergeRefusal } from '../core/engine';
import {
  ABSENT_WORKER_REASON, ACCEPTED_PR_RECONCILIATION_REASON, EXTERNAL_MERGE_CHECK_RECOVERED_REASON, EXTERNAL_MERGE_CHECK_REASON_PREFIX,
  PRE_AGENT_LAUNCH_FAILURE_REASON, ProvenPreSendRefusalError, RetainedRunRefusal,
} from '../core/resolution';
import { BACKPRESSURE_DEFERRAL, isBackpressureDeferral } from '../core/host/admission';
import { ForgeOutageError } from '../core/forge/forge-health';
import { GitReadTimeoutError, SubmissionUnavailableError } from '../core/git/index';
import { hookHoldReason, isHookHoldReason } from '../core/hooks/hooks';
import { OWNER_STOP_HOLD_PREFIX } from '../core/merge/merge-hold';
import { RestartRefusal } from '../core/verbs/owner-verbs';
import { ProofExecutionRefusal, proofSingleFlightRefusal } from '../core/qa/proof-execution';
import { RepositoryRekeyRefused } from '../core/planning/repository-rekey';
import { ReviewEntryRefusal } from '../core/review/review-entry';
import { DurableFenceRefusal, runFenceRefusal } from '../core/intake/run-settlement';
import { taskControlOperation } from '../core/verbs/task-control-key';
import { LoginSessionFaultError } from '../shared/session-fault';
import { CAPACITY_WAIT_PREFIX, QA_CAPACITY_WAIT_PREFIX } from '../shared/wait-state';
import { queueOperationSchema } from '../shared/operations';
import { RETAINED_WORKER_PROFILE_REASON, runSchema, submissionSchema, taskControlInputSchema, type Run, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { runtimeSourceRoots } from './support/runtime-source-roots';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const at = new Date(Date.now() - 3_600_000).toISOString();
type Loose = any;

function fixture(t: TestContext, adapter: Loose = {}) {
  const store = new Store(':memory:');
  const engine = new Engine(store, adapter as Adapter, 60_000);
  engine.currentServiceBuildId = () => "injected-build";
  store.setMeta('paused', false);
  store.setMeta('globalLimit', 0);
  t.after(async () => { await engine.stop(); store.close(); });
  const add = (fields: Loose = {}): Task => {
    const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Pin', repoPath: '/fixture',
      planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
    return Object.keys(fields).length ? store.update(task.id, fields) : task;
  };
  return { store, engine, add, resolution: engine.resolution as Loose, internals: engine as Loose };
}

function putRun(store: Store, taskId: string, fields: Loose = {}): Run {
  const run = runSchema.parse({ id: randomUUID(), taskId, role: 'reviewer', generation: 1, head, base, agentId: 'agent', workspaceId: 'ws',
    profile: null, profileGroup: 'group', status: 'running', createdAt: at, lastObservedAt: null, active: false,
    idleSince: at, completion: null, released: false, ...fields });
  store.putRun(run);
  return run;
}

// ---------------------------------------------------------------------------
// Rule 7: the class of an error decides how an operation settles
// ---------------------------------------------------------------------------

/** Run one real task-control operation whose handler throws `error`. */
async function settle(t: TestContext, error: unknown, control: Loose = { action: 'stop', reason: 'Pin' }, before?: (id: string, store: Store) => void) {
  const f = fixture(t);
  const task = f.add();
  let thrown = 0;
  const parsed = taskControlInputSchema.parse({ taskId: task.id, version: task.version, ...control });
  const accepted = await f.engine.startOperation({ key: `pin-${randomUUID()}`, kind: 'task_control', deferSchedule: true,
    payload: { type: 'task_control', control: parsed }, taskId: task.id, expectedVersion: task.version }) as Loose;
  assert.ok('accepted' in accepted);
  f.internals.performOperation = async () => {
    thrown += 1;
    before?.(accepted.operation.id, f.store);
    throw error;
  };
  f.engine.scheduleAcceptedOperation(accepted.operation.id);
  const operation = await f.engine.awaitOperation(accepted.operation.id);
  assert.equal(thrown, 1, 'the handler override must have fired');
  return operation;
}
const armBoundary = (id: string, store: Store) => { store.putOperation({ ...store.operation(id)!, preSendBoundaryStartedAt: at }); };

// Words the prose classifier reads as uncertain. A typed refusal carrying them
// proves the class wins; `Unknown` below proves the words alone would not settle it.
const FRIGHTENING = 'its delivery is unknown and the connection timed out';

const TYPED: [string, () => Error][] = [
  ['ProvenPreSendRefusalError', () => new ProvenPreSendRefusalError(FRIGHTENING)],
  ['ReviewEntryRefusal', () => new ReviewEntryRefusal('workspace_busy', FRIGHTENING)],
  ['ExternalMergeRefusal', () => new ExternalMergeRefusal(FRIGHTENING)],
  ['RestartRefusal', () => new RestartRefusal(FRIGHTENING)],
  ['RepositoryRekeyRefused', () => new RepositoryRekeyRefused('invalid_input' as Loose, [], FRIGHTENING)],
  ['RetainedRunRefusal', () => new RetainedRunRefusal(FRIGHTENING)],
  ['DurableFenceRefusal', () => new DurableFenceRefusal(FRIGHTENING)],
];

for (const [name, make] of TYPED) {
  test(`operation state: ${name} settles failed with a receipt, whatever its prose says`, async t => {
    const operation = await settle(t, make());
    assert.equal(operation.state, 'failed');
    assert.equal(operation.effect?.status, 'reconciled');
    assert.equal(operation.preSendReceipt?.boundary, 'pre-send-refusal-v1');
    assert.equal(operation.preSendReceipt?.buildId, 'injected-build');
  });
  test(`operation state: ${name} stays failed past an armed pre-send boundary, with no new receipt`, async t => {
    const operation = await settle(t, make(), undefined, armBoundary);
    assert.equal(operation.state, 'failed');
    assert.equal(operation.preSendReceipt, undefined);
  });
  test(`operation state: rewrapping ${name} into a plain Error makes it uncertain`, async t => {
    const operation = await settle(t, new Error(make().message));
    assert.equal(operation.state, 'needs_attention');
    assert.equal(operation.effect?.status, 'uncertain');
  });
}

test('operation state: the typed set is exactly these eight classes', () => {
  // ParkedRestartPreSendRefusal is private to its file, so the set is read from
  // source rather than thrown. test/restart.cases.ts drives that class.
  const body = /const typedPreSendRefusal = \(error: unknown\): boolean =>([\s\S]*?);\n/.exec(source())?.[1];
  assert.ok(body, 'typedPreSendRefusal is gone or reshaped');
  assert.deepEqual([...body.matchAll(/instanceof (\w+)/g)].map(match => match[1]).sort(), [
    'DurableFenceRefusal', 'ExternalMergeRefusal', 'ParkedRestartPreSendRefusal', 'ProvenPreSendRefusalError',
    'RepositoryRekeyRefused', 'RestartRefusal', 'RetainedRunRefusal', 'ReviewEntryRefusal']);
});

test('operation state: a typed error outside the set takes the prose classifier', async t => {
  const refusal = new ProofExecutionRefusal('live_run', FRIGHTENING);
  assert.equal((await settle(t, refusal)).state, 'needs_attention');
  assert.equal((await settle(t, new ProofExecutionRefusal('live_run', 'Nothing frightening'))).state, 'failed');
});

for (const word of ['uncertain', 'unknown', 'timed out', 'timeout', 'connection', 'socket', 'transport', 'interrupted', 'ambiguous', 'UNKNOWN']) {
  test(`operation state: an untyped failure saying "${word}" stays uncertain`, async t => {
    const operation = await settle(t, new Error(`The call hit ${word} here`));
    assert.equal(operation.state, 'needs_attention');
    assert.equal(operation.effect?.status, 'uncertain');
    assert.equal(operation.diagnostic, `The call hit ${word} here`);
  });
}

test('operation state: any other untyped failure settles failed, and an armed boundary overrides that', async t => {
  const plain = await settle(t, new Error('A plain refusal'));
  assert.equal(plain.state, 'failed');
  assert.equal(plain.effect?.status, 'reconciled');
  assert.equal(plain.preSendReceipt, undefined);
  assert.equal((await settle(t, new Error('A plain refusal'), undefined, armBoundary)).state, 'needs_attention');
});

test('operation state: the owned-tool hold refusal needs its exact text, its own verb and no boundary', async t => {
  const retry = { action: 'retry_effect', effect: 'owned_tool.run-1', reason: 'Pin' };
  // The writer's own shape, in engine.ts: `Owned-tool hold ${runId} remains: ${hold}`.
  const refusal = 'Owned-tool hold run-1 remains: its state is unknown';
  assert.equal((await settle(t, new Error(refusal), retry)).state, 'failed');
  assert.equal((await settle(t, new Error('Owned-tool hold run-1 persists: its state is unknown'), retry)).state, 'needs_attention');
  assert.equal((await settle(t, new Error(refusal), { action: 'stop', reason: 'Pin' })).state, 'needs_attention');
  assert.equal((await settle(t, new Error(refusal), retry, armBoundary)).state, 'needs_attention');
});

for (const [name, error, state, diagnostic] of [
  ['SubmissionUnavailableError defers', new SubmissionUnavailableError('The source is unavailable'), 'pending', 'Submission validation deferred: The source is unavailable'],
  ['a transport failure defers', new Error('Transport not connected'), 'pending', 'Submission validation deferred: Transport not connected'],
  ['anything else fails', new Error('A plain refusal'), 'failed', 'A plain refusal'],
] as const) {
  test(`operation state: on submit, ${name}`, async t => {
    const f = fixture(t);
    f.internals.submissionReady = () => true;
    let thrown = 0;
    f.internals.performOperation = async () => { thrown += 1; throw error; };
    f.internals.deferGitTransient = () => false;
    const payload = { type: 'submit', submission: { title: 'Pin' } };
    // Queue #912: an accepted submit waits for a proven host; this fixture has one.
    const accepted = f.store.acceptOperation({ key: `pin-${randomUUID()}`, kind: 'submit', inputHash: operationInputHash(payload), payload, hostId: 'host' }) as Loose;
    const id = accepted.operation.id;
    await f.internals.runOperation(id);
    assert.equal(thrown, 1);
    const operation = f.store.operation(id)!;
    assert.equal(operation.state, state);
    assert.equal(operation.diagnostic, diagnostic);
  });
}

// ---------------------------------------------------------------------------
// Rule 7: error classes in the `advance` funnel
// ---------------------------------------------------------------------------

async function advanceThrows(t: TestContext, error: Error, resolutionFields: Loose = {}, phase: 'verifying' | 'merging' = 'verifying') {
  const f = fixture(t);
  const task = f.add({ phase, prNumber: 1, prHead: head });
  f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution, ...resolutionFields } });
  let thrown = 0;
  f.resolution.verification = f.resolution.advanceMerging = async () => { thrown += 1; throw error; };
  f.resolution.gitTransientFailure = () => false;
  await f.resolution.advance(f.store.task(task.id));
  assert.equal(thrown, 1, 'the funnel must have been reached');
  return f.store.task(task.id);
}

test('advance funnel: outages and read timeouts wait; they raise no attention', async t => {
  for (const error of [new ForgeOutageError(new Error('forge down')), new GitReadTimeoutError(['fetch'], 10, new Error('slow'))]) {
    const task = await advanceThrows(t, error);
    assert.equal(task.resolution.attention, false, error.constructor.name);
    assert.equal(task.resolution.stop?.reason, 'external_unavailable', error.constructor.name);
    assert.equal(task.reason, error.message);
  }
});

test('advance funnel: a login session fault defers to the environment, not attention', async t => {
  const task = await advanceThrows(t, new LoginSessionFaultError(new Error('session gone')));
  assert.equal(task.resolution.attention, false);
  assert.match(task.reason, /^Host login session is gone; replacing the Nucleus service rather than charging this task: /);
});

test('advance funnel: rewrapping the same fault as a plain Error raises attention', async t => {
  for (const original of [new ForgeOutageError(new Error('forge down')), new GitReadTimeoutError(['fetch'], 10, new Error('slow'))]) {
    const task = await advanceThrows(t, new Error(original.message));
    assert.equal(task.resolution.attention, true, original.constructor.name);
  }
});

test('advance funnel: the merged-identity refusal is matched exactly, ahead of the pending-merge wait', async t => {
  const mergeIntent = { mergeIntent: true, mergeHead: head, mergeBase: base, mergeResponseOutcome: 'pending' };
  const exact = await advanceThrows(t, new Error('Merged PR identity differs from the approved task'), mergeIntent, 'merging');
  assert.equal(exact.resolution.attention, true);
  assert.equal(exact.resolution.mergeResponseOutcome, 'pending');
  const reworded = await advanceThrows(t, new Error('Merged PR identity differs from the task'), mergeIntent, 'merging');
  assert.equal(reworded.resolution.attention, false);
  assert.equal(reworded.resolution.mergeResponseOutcome, 'uncertain');
  assert.equal(reworded.reason, 'Merge response is uncertain; checking GitHub before considering one guarded re-issue');
});

// ---------------------------------------------------------------------------
// Rule 6: refusal text
// ---------------------------------------------------------------------------

test('version hint: only a plain or pre-send "Task changed" refusal gets it, and each keeps its class', async t => {
  const f = fixture(t);
  const task = f.add();
  const stale = taskControlInputSchema.parse({ taskId: task.id, version: task.version, action: 'stop', reason: 'Pin' });
  f.store.update(task.id, { reason: 'moved on' });
  const current = f.store.task(task.id).version;
  const hint = `(the task is now version ${current}; read next again and reassess before retrying)`;
  const throwing = async (error: Error) => {
    f.internals.performTaskControlApplied = async () => { throw error; };
    return f.internals.appliedWithVersionHint(stale).then(() => assert.fail('must refuse'), (caught: Error) => caught);
  };

  const plain = await throwing(new Error('Task changed; refresh before retrying'));
  assert.equal(plain.constructor, Error);
  assert.equal(plain.message, `Task changed; refresh before retrying ${hint}`);
  // The coordinator retries only exactly this shape.
  assert.match(plain.message, COORDINATOR_VERSION_RETRY);

  const proven = await throwing(new ProvenPreSendRefusalError('Task changed; refresh before retrying'));
  assert.ok(proven instanceof ProvenPreSendRefusalError);
  assert.equal(proven.reason, `Task changed; refresh before retrying ${hint}`);
  assert.equal(proven.message, `Reviewer continuation refused before send: Task changed; refresh before retrying ${hint}`);

  const typed = new RestartRefusal('Task changed; refresh before retrying');
  assert.equal(await throwing(typed), typed, 'a typed subclass passes through untouched');
  const other = new Error('Task moved; refresh before retrying');
  assert.equal(await throwing(other), other, 'other prose passes through untouched');

  const fresh = taskControlInputSchema.parse({ ...stale, version: current });
  const same = new Error('Task changed; refresh before retrying');
  f.internals.performTaskControlApplied = async () => { throw same; };
  await assert.rejects(f.internals.appliedWithVersionHint(fresh), (caught: Error) => caught === same, 'a current version gets no hint');
});

const moveRefusals = ['Task changed during the move; read next', 'Task or run changed; refresh before retrying',
  'A run started during the move; refresh before retrying', 'A run changed during the move; refresh before retrying'];

async function moveThrowing(t: TestContext, message: string, cancels: boolean) {
  const f = fixture(t);
  const task = f.add();
  f.internals.wakeTask = async () => {};
  f.internals.wakeRepository = async () => {};
  let calls = 0;
  f.internals.moveToWork = async () => {
    calls += 1;
    if (calls > 1) return f.store.update(task.id, { reason: 'replanned' });
    if (cancels) f.store.event(task.id, 'owner_stop_sent', 'run');
    throw new Error(message);
  };
  const input = taskControlInputSchema.parse({ taskId: task.id, version: task.version, action: 'move', to: 'work', reason: 'Pin' });
  const result = await f.internals.applyTaskControlMove(input, <T>(value: T) => value).then(() => 'replanned', (error: Error) => error.message);
  return { result, calls, replans: f.store.eventsAll(task.id).filter(event => event.kind === 'owner_move_replanned') };
}

for (const message of moveRefusals) {
  test(`move: "${message}" re-plans once after this move cancelled a turn`, async t => {
    const { result, calls, replans } = await moveThrowing(t, message, true);
    assert.equal(result, 'replanned');
    assert.equal(calls, 2);
    assert.equal(replans.length, 1);
    assert.equal(replans[0]!.detail, message);
  });
}

test('move: with no cancelled turn, or other prose, the refusal stands', async t => {
  assert.deepEqual((await moveThrowing(t, moveRefusals[0]!, false)).calls, 1);
  const reworded = await moveThrowing(t, 'The task changed during the move; read next', true);
  assert.equal(reworded.result, 'The task changed during the move; read next');
  assert.equal(reworded.calls, 1);
});

test('proof race: each real single-flight refusal stands down quietly; other prose throws', async t => {
  const executor = (fields: Loose = {}) => ({ id: 'run-1', role: 'executor', head, released: false, status: 'running', completion: null, ...fields }) as Loose;
  const unreleased = proofSingleFlightRefusal({ entrypoint: 'task' } as Loose, [executor()], head);
  const spent = proofSingleFlightRefusal({ entrypoint: 'proof', proofOnly: { commit: head } } as Loose, [executor({ released: true, status: 'completed' })], head);
  const reserved = proofSingleFlightRefusal({ entrypoint: 'task' } as Loose, [executor({ released: true, status: 'completed' })], head);
  assert.equal(unreleased, 'An author-side proof execution is already dispatched and unreleased (run-1); inspect it with task.detail');
  assert.equal(spent, 'This proof-only qualification already spent its one execution (run-1, completed); it is never repeated, refunded or reset. Inspect it with task.detail');
  assert.equal(reserved, `An author-side proof execution was already reserved at ${head}; inspect it with task.detail`);

  const launch = async (message: string) => {
    const f = fixture(t);
    const task = f.add({ entrypoint: 'proof', proofOnly: { commit: head } });
    let thrown = 0;
    f.resolution.select = () => ({ profile: { id: 'profile' } });
    f.resolution.proofExecution = async () => { thrown += 1; throw new Error(message); };
    const outcome = await f.internals.launchProofOnly(task).then(() => 'quiet', (error: Error) => error.message);
    assert.equal(thrown, 1, 'the race must have been reached');
    return outcome;
  };
  for (const message of [unreleased!, spent!, reserved!]) assert.equal(await launch(message), 'quiet', message);
  assert.equal(await launch('A proof execution is already running'), 'A proof execution is already running');
});

test('store fence: exactly the real fence messages relabel a legacy refusal', async t => {
  const f = fixture(t);
  const task = f.add();
  const run = putRun(f.store, task.id);
  const control = taskControlInputSchema.parse({ taskId: task.id, version: task.version, action: 'restart', role: 'reviewer', reason: 'Pin' });
  const { key, payload } = taskControlOperation(control);
  const id = operationIdForKey(key), inputHash = operationInputHash(payload);
  const put = (diagnostic: string) => f.store.putOperation(queueOperationSchema.parse({ id, key, kind: 'task_control', inputHash, state: 'needs_attention',
    taskId: task.id, expectedVersion: control.version, createdAt: at, startedAt: at, settledAt: at, attempts: 1, diagnostic,
    effect: { kind: 'task_control', target: 'restart', intentAt: at, status: 'uncertain', result: diagnostic.slice(0, 2000), resultAt: at } }), payload);

  const delivery = runFenceRefusal(run, 'its delivery is unknown');
  const effect = runFenceRefusal(run, 'a publication is pending');
  const verb = f.internals.verbRunFenceRefusal({ run, why: 'its turn is live' });
  assert.equal(delivery, `A reviewer run (${run.id}) holds a durable side effect Queue will not act over blindly (its delivery is unknown); restart re-creates it under the same run, or wait for reconciliation to settle it`);
  assert.equal(runFenceRefusal(run, 'run-delivery x'), `A reviewer run (${run.id}) holds a durable side effect Queue will not act over blindly (run-delivery x); restart re-creates it under the same run, or wait for reconciliation to settle it`);
  assert.equal(effect, `A reviewer run (${run.id}) holds a durable side effect Queue will not act over blindly (a publication is pending); wait for that delivery or effect to settle, or retry_effect it`);
  assert.equal(verb, `A reviewer run (${run.id}) still owns this task: its turn is live`);
  for (const diagnostic of [delivery, effect, verb]) {
    put(diagnostic);
    const settled = f.store.reconcileTaskControlPreSend(id, inputHash);
    assert.equal(settled.state, 'failed', diagnostic);
    assert.ok(settled.preSendReconciledAt, diagnostic);
  }
  for (const diagnostic of [
    verb.replace('still owns this task', 'owns this task'),
    delivery.replace('will not act over blindly', 'will not act blindly'),
    effect.replace(', or retry_effect it', ''),
    runFenceRefusal({ ...run, id: 'ghost' }, 'its delivery is unknown'),
  ]) {
    put(diagnostic);
    assert.throws(() => f.store.reconcileTaskControlPreSend(id, inputHash), /^Error: The diagnostic is not one of Queue's own pre-send refusal messages; delivery remains uncertain$/, diagnostic);
  }
});

for (const [name, message, repair] of [
  ['the PR identity refusal', "PR must be open, ready, and match the task's branch and base", true],
  ['the dirty worktree refusal', 'Worker must leave a clean worktree before review: untracked file', false],
  ['the branch refusal', 'Worker must remain on queue-owned branch ns-1', false],
] as const) {
  test(`ready report: ${name} returns the task to its worker`, t => {
    const f = fixture(t);
    const task = f.add({ phase: 'awaiting_review', branch: 'ns-1' });
    assert.equal(f.resolution.responsiblePrReportRefused(task, 'run-1', 7, new Error(message)), true);
    const after = f.store.task(task.id);
    assert.equal(after.phase, 'changes_requested');
    assert.equal(Boolean(after.resolution.revisionPrRepair), repair);
    assert.equal(after.resolution.pendingWorkerInstruction, after.reason);
    assert.ok(after.reason.includes(message));
    assert.equal(f.store.eventsAll(task.id).at(-1)?.kind, 'responsible_pr_report_refused');
  });
}

test('ready report: any other text is not a report refusal', t => {
  const f = fixture(t);
  const task = f.add({ phase: 'awaiting_review', branch: 'ns-1' });
  for (const message of ["PR must be open and ready", 'The worker must leave a clean worktree before review', 'Worker must remain on branch ns-1'])
    assert.equal(f.resolution.responsiblePrReportRefused(task, 'run-1', 7, new Error(message)), false, message);
  assert.equal(f.resolution.responsiblePrReportRefused(task, 'run-1', 7, "PR must be open, ready, and match the task's branch and base"), false, 'not an Error');
  assert.equal(f.store.task(task.id).phase, 'awaiting_review');
});

test('message recipient: only the ambiguous reference refusal escapes the lookup', t => {
  const f = fixture(t);
  const from = f.add();
  const lookup = (message: string) => {
    f.store.taskIdByNumber = (() => { throw new Error(message); }) as Loose;
    return f.resolution.messageRecipientTask(from, 'repo#1');
  };
  assert.throws(() => lookup('Ambiguous task reference; use repository and number'), /^Error: Ambiguous task reference; use repository and number$/);
  assert.throws(() => lookup('Task reference not found'), (error: Error) => !error.message.startsWith('Ambiguous task reference'));
});

test('durable send: only the exact agent-gone text takes the gone branch', async t => {
  const f = fixture(t);
  const send = async (message: string) => {
    const seen: string[] = [];
    const outcome = await f.resolution.sendDurably({
      recipient: 'agent', observe: async () => { throw new Error(message); },
      lookupWait: (text: string) => `lookup: ${text}`, busyWait: () => 'busy', wait: (reason: string) => seen.push(reason), gone: () => seen.push('gone'),
      confirm: () => assert.fail('a failed lookup never sends'), target: () => assert.fail('a failed lookup never sends'), mark: () => assert.fail('a failed lookup never sends'),
    });
    assert.equal(outcome, 'done');
    return seen;
  };
  assert.deepEqual(await send('Agent was not found'), ['gone']);
  assert.deepEqual(await send('Agent not found'), ['lookup: Agent not found']);
});

// ---------------------------------------------------------------------------
// Rule 6: reason text the lifecycle reads back
// ---------------------------------------------------------------------------

test('waiting: a running reason clears the stop instead of recording one', t => {
  const f = fixture(t);
  const task = f.add();
  f.resolution.waiting(task, 'Waiting on the forge', 'external_unavailable');
  assert.equal(f.store.task(task.id).resolution.stop?.reason, 'external_unavailable');
  for (const reason of ['Reviewer thread running', 'Worker running']) {
    f.resolution.waiting(f.store.task(task.id), 'Waiting on the forge', 'external_unavailable');
    f.resolution.waiting(f.store.task(task.id), reason, 'lifecycle');
    const after = f.store.task(task.id);
    assert.equal(after.reason, reason);
    assert.equal(after.resolution.stop, null, reason);
  }
  f.resolution.waiting(f.store.task(task.id), 'Reviewer thread is running', 'lifecycle');
  assert.equal(f.store.task(task.id).resolution.stop?.reason, 'lifecycle');
});

test('attention: only the external merge check prefix remembers the phase it parked', t => {
  const f = fixture(t);
  const parked = f.add({ phase: 'verifying', reason: 'Before the check' });
  f.resolution.attention(parked, `${EXTERNAL_MERGE_CHECK_REASON_PREFIX} forge down`);
  assert.deepEqual(f.store.task(parked.id).resolution.externalMergePreAttention, { phase: 'verifying', reason: 'Before the check' });
  const other = f.add({ phase: 'verifying', reason: 'Before the check' });
  f.resolution.attention(other, 'External merge probe: forge down');
  assert.equal(f.store.task(other.id).resolution.externalMergePreAttention ?? null, null);
});

test('hook hold: the writer and reader agree on the text', () => {
  const reason = hookHoldReason({ records: [{ hookId: 'pre-merge', event: 'merge', error: 'refused' }] } as Loose);
  assert.equal(reason, 'Repository hook pre-merge merge holds this transition: refused');
  assert.equal(isHookHoldReason(reason), true);
  assert.equal(isHookHoldReason('Repository hook pre-merge holds the transition: refused'), false);
});

test('stopping: a drain waiter rejects with the exact text test support recognises', async t => {
  const f = fixture(t);
  // Observe before stopping: the rejection lands during the stop.
  const outcome = f.internals.ensureSweep('drain').then(() => 'covered', (error: Error) => error.message);
  await f.engine.stop();
  assert.equal(await outcome, 'Nucleus engine stopped before the requested reconciliation drain covered the fleet');
});

test('prefixes and reasons that code compares are byte-identical', () => {
  assert.deepEqual({ OWNER_STOP_HOLD_PREFIX, CAPACITY_WAIT_PREFIX, QA_CAPACITY_WAIT_PREFIX, RETAINED_WORKER_PROFILE_REASON, BACKPRESSURE_DEFERRAL,
    EXTERNAL_MERGE_CHECK_REASON_PREFIX, EXTERNAL_MERGE_CHECK_RECOVERED_REASON, ACCEPTED_PR_RECONCILIATION_REASON, ABSENT_WORKER_REASON, PRE_AGENT_LAUNCH_FAILURE_REASON }, {
    OWNER_STOP_HOLD_PREFIX: 'Owner stop:',
    CAPACITY_WAIT_PREFIX: 'Waiting for a project slot…',
    QA_CAPACITY_WAIT_PREFIX: 'Waiting for QA capacity (position ',
    RETAINED_WORKER_PROFILE_REASON: 'Retained worker profile is disabled or unavailable',
    BACKPRESSURE_DEFERRAL: 'Paseo admission backpressure: ',
    EXTERNAL_MERGE_CHECK_REASON_PREFIX: 'External merge check:',
    EXTERNAL_MERGE_CHECK_RECOVERED_REASON: 'External merge check recovered; resuming task',
    ACCEPTED_PR_RECONCILIATION_REASON: 'Operator requested accepted-PR workspace reconciliation',
    ABSENT_WORKER_REASON: 'Agent creation is uncertain or placement differs; no replacement launched',
    PRE_AGENT_LAUNCH_FAILURE_REASON: 'Transient worker launch failed before an agent was created',
  });
  assert.equal(isBackpressureDeferral(`${BACKPRESSURE_DEFERRAL}full`), true);
});

// ---------------------------------------------------------------------------
// Rule 7: readers and writers that look interchangeable and are not
// ---------------------------------------------------------------------------

test('don\'t normalise: store.events is the newest 100; eventsAll is everything, oldest first', t => {
  const f = fixture(t);
  const task = f.add();
  const before = f.store.eventsAll(task.id).length;
  for (let index = 0; index < 120; index += 1) f.store.event(task.id, 'pin', String(index));
  const all = f.store.eventsAll(task.id), recent = f.store.events(task.id);
  assert.equal(all.length, before + 120);
  assert.equal(recent.length, 100);
  assert.equal(all.at(-1)!.detail, '119', 'eventsAll ends with the newest');
  assert.equal(recent[0]!.detail, '119', 'events starts with the newest');
  assert.equal(recent.at(-1)!.detail, '20');
});

// The split map says only `Resolution.update` nulls the stop. Today both do on a
// reason or phase change (store.ts `lifecycleChanged`). What differs, and must not
// be normalised, is the merge and the event.
test('don\'t normalise: both updates null the stop on a reason or phase change, and keep it otherwise', t => {
  const f = fixture(t);
  const stop = { reason: 'lifecycle', detail: 'Pin', since: at, suggestedVerbs: [] };
  const stopped = () => {
    const task = f.add();
    return f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution, stop } as Loose });
  };
  const viaStore = stopped();
  f.store.update(viaStore.id, { reason: 'Changed' });
  assert.equal(f.store.task(viaStore.id).resolution.stop, null);
  const viaResolution = stopped();
  f.resolution.update(viaResolution, {}, { reason: 'Changed' });
  assert.equal(f.store.task(viaResolution.id).resolution.stop, null);
  const storeKeeps = stopped();
  f.store.update(storeKeeps.id, { reason: storeKeeps.reason, title: 'Other' });
  assert.equal(f.store.task(storeKeeps.id).resolution.stop?.reason, 'lifecycle');
  const resolutionKeeps = stopped();
  f.resolution.update(resolutionKeeps, {}, { reason: resolutionKeeps.reason });
  assert.equal(f.store.task(resolutionKeeps.id).resolution.stop?.reason, 'lifecycle');
});

test('don\'t normalise: Resolution.update merges onto the current row and records an event; store.update takes the caller\'s resolution and records none', t => {
  const f = fixture(t);
  const task = f.add();
  const stale = f.store.task(task.id);
  f.store.update(task.id, { resolution: { ...stale.resolution, revisionPrRepair: true } });

  f.resolution.update(stale, { pendingWorkerInstruction: 'Merged' });
  const merged = f.store.task(task.id);
  assert.equal(merged.resolution.revisionPrRepair, true, 'the stale read loses nothing');
  assert.equal(merged.resolution.pendingWorkerInstruction, 'Merged');
  assert.equal(f.store.eventsAll(task.id).at(-1)?.kind, 'resolution');

  const events = f.store.eventsAll(task.id).length;
  f.store.update(task.id, { resolution: stale.resolution });
  const replaced = f.store.task(task.id);
  assert.notEqual(replaced.resolution.revisionPrRepair, true, 'the stale resolution overwrites');
  assert.notEqual(replaced.resolution.pendingWorkerInstruction, 'Merged');
  assert.equal(f.store.eventsAll(task.id).length, events);
});

// ---------------------------------------------------------------------------
// Census: parse sites a fixture can't reach cheaply
// ---------------------------------------------------------------------------

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return sourceFiles(path);
  return /\.(?:ts|mjs)$/.test(name) && !/\.d\.(?:ts|mts)$/.test(name) ? [path] : [];
});
let cached: string | null = null;
/** All runtime sources: a move between folders keeps every pin below. */
function source(): string {
  const roots = runtimeSourceRoots(root);
  cached ??= [...new Set(roots)].flatMap(dir => sourceFiles(join(root, dir))).map(path => readFileSync(path, 'utf8')).join('\n');
  return cached;
}
const occurrences = (text: string, part: string) => text.split(part).length - 1;

const COORDINATOR_VERSION_RETRY = /^Task changed; refresh before (?:retrying|restarting) \(the task is now version \d+; read next again and reassess before retrying\)$/;

interface ParsedText {
  site: string;
  /** The reader's regular expression, its literal text is searched for and it must match `sample`. */
  re?: RegExp;
  /** A literal the reader compares against. */
  reads?: string[];
  /** Real text the writers produce. */
  sample?: string;
  /** Fixed text the writers must still carry. */
  writers?: string[];
}

const PARSED: ParsedText[] = [
  { site: 'uncertainOperationError', re: /uncertain|unknown|timed out|timeout|connection|socket|transport|interrupted|ambiguous/i, sample: 'its delivery is unknown' },
  { site: 'owned-tool retry refusal', re: /^Owned-tool hold .+ remains:/, sample: 'Owned-tool hold run-1 remains: live', writers: ['Owned-tool hold ${runId} remains: ${hold}'], reads: ['startsWith("owned_tool.")'] },
  { site: 'coordinator version retry', re: COORDINATOR_VERSION_RETRY, sample: 'Task changed; refresh before retrying (the task is now version 3; read next again and reassess before retrying)',
    writers: ['Task changed; refresh before retrying', '${message} (the task is now version ${current}; read next again and reassess before retrying)'] },
  { site: 'version hint', re: /^Task changed\b/, sample: 'Task changed during the move; read next', reads: ['error.constructor === Error'] },
  { site: 'move replan', re: /^(Task changed|Task or run changed|A run started during the move|A run changed during the move)/, sample: 'A run changed during the move; refresh before retrying',
    writers: ['Task changed during the move; read next', 'Task or run changed; refresh before retrying', 'A run started during the move', 'A run changed during the move; refresh before retrying'] },
  { site: 'proof single flight', re: /already dispatched and unreleased|already spent its one execution|already reserved at/, sample: 'An author-side proof execution was already reserved at abc',
    writers: ['is already dispatched and unreleased (', 'already spent its one execution (', 'was already reserved at ${head}'] },
  { site: 'reviewer crash', re: /^The reviewer (?:thread stopped|callback reminder expired)/, sample: 'The reviewer thread stopped without a callback; inspect the thread',
    writers: ['The ${run.role} thread stopped without a callback; inspect the thread', 'callback reminder expired'] },
  { site: 'missing callback', reads: ['t.reason===`The ${completed.role} thread stopped without a callback; inspect the thread`', 't.reason===`The ${completed.role} callback reminder expired`'] },
  { site: 'store fence', re: /^A ([a-z]+) run \(([^)]+)\) (?:holds a durable side effect Queue will not act over blindly \(.+\); (?:restart re-creates it under the same run, or wait for reconciliation to settle it|wait for that delivery or effect to settle, or retry_effect it)|still owns this task: .+)$/,
    sample: 'A worker run (run-1) still owns this task: live' },
  { site: 'proof hold', reads: ['`Proofs Queue cannot run, left for the planner or operator at ${pr.head}:`', 'proofHold.reason.startsWith(proofHoldPrefix)'],
    writers: ['`Proofs Queue cannot run, left for the planner or operator at ${head}: ${proofs}. Run them through the proof verb or accept the head, then release this merge hold.`'] },
  { site: 'auto-continue fence cleared', reads: ["refused?.detail.includes('unresolved task incident or recovery fence')"], writers: ['An unresolved task incident or recovery fence blocks reviewer continuation'] },
  { site: 'review recovery wait', reads: ["['Ordinary review', 'Review-entry'].some(label =>", 't.reason === `${label} waits for ${refusal}; settle it with retry_effect before continuing`',
      '/^(Ordinary review|Review-entry) waits for .+; settle it with retry_effect before continuing$/'],
    writers: ["`${run.ordinaryDetached?'Ordinary review':'Review-entry'} waits for ${recoveryEffectsRefusal(error.effects)}; settle it with retry_effect before continuing`"] },
  // Nucleus#1159: the blocked review's attention is one authored sentence; the
  // stop classification and the reconciler's reader both key on its constant.
  { site: 'blocked effect attention',
    reads: ['detail.startsWith(BLOCKED_EFFECT_ATTENTION_PREFIX)', 'stop.detail.startsWith(BLOCKED_EFFECT_ATTENTION_PREFIX)'],
    writers: ['BLOCKED_EFFECT_ATTENTION_PREFIX = "An uncertain side effect blocks review"', '`${BLOCKED_EFFECT_ATTENTION_PREFIX}: ${recoveryEffectsRefusal(blocked)}'] },
  { site: 'external merge check', reads: ['t.reason.startsWith(EXTERNAL_MERGE_CHECK_REASON_PREFIX) || t.reason === EXTERNAL_MERGE_CHECK_RECOVERED_REASON', 't.reason === ACCEPTED_PR_RECONCILIATION_REASON'] },
  { site: 'revision repair', reads: ["t.reason === 'PR must be open, ready, and match the task\\'s branch and base'"], writers: ['PR must be open, ready, and match the task\'s branch and base'] },
  { site: 'ready report checkout', re: /^(Worker must leave a clean worktree before review|Worker must remain on queue-owned branch )/, sample: 'Worker must remain on queue-owned branch ns-1',
    writers: ['Worker must leave a clean worktree before review: ${causes.join(", ")}', 'Worker must remain on queue-owned branch ${task.branch}'] },
  { site: 'waiting running', re: /\bthread running$/, sample: 'Reviewer thread running' },
  { site: 'tool issue', re: / is running$/, sample: 'observed tool call x is running', writers: [' and is running'] },
  { site: 'agent gone', reads: ["error.message === 'Agent was not found'", 'error.message !== "Agent was not found"', 'error.message === "Agent was not found"', 'const AGENT_NOT_FOUND = "Agent was not found"'], writers: ['throw new Error("Agent was not found")', "throw Error('Agent was not found')"] },
  // Task 1090: empty awaitingProofs on source approval names the ready_to_merge
  // route so a reviewer that finished source review with only release gates
  // remaining is not left without a report. Both throw sites stay byte-identical.
  { site: 'source approval empty proofs', writers: ["throw Error('Source approval requires an exact-head environment blocked review with findings and named awaiting proofs; if only release gates remain, report ready_to_merge')"] },
  { site: 'ambiguous reference', reads: ["error.message.startsWith('Ambiguous task reference')"], writers: ['Ambiguous task reference; use repository and number'] },
  { site: 'provider MCP refusal', re: /Provider '.+' does not support MCP servers/, sample: "Provider 'x' does not support MCP servers" },
  { site: 'global capacity', reads: ['capacity.startsWith("Global")'], writers: ['Global concurrent task-slot limit reached'] },
  { site: 'transient provider wait', reads: ['stop.detail.startsWith(TRANSIENT_PROVIDER_WAIT)'], writers: ["const TRANSIENT_PROVIDER_WAIT = 'Transient provider error'"] },
  { site: 'unverified provider refusal', reads: ['stop.detail.startsWith(`Reviewer run ${run.id} provider refusal is unverified`)'], writers: ['`Reviewer run ${run.id} provider refusal is unverified: ${read.gap}`'] },
  { site: 'delegated answerer', re: /^(?:planner|decider) /, sample: 'planner agent-1' },
  { site: 'delegated answerer id', re: /^(?:delegated )?(?:planner|decider)\s+(\S+)$/, sample: 'delegated planner agent-1' },
  { site: 'decision link', re: /decision (\S+)/, sample: 'q-1: decision d-1; linked', writers: ['decision ${'] },
  { site: 'decision link, bounded', re: /decision ([^;\s]+)/, sample: 'q-1: decision d-1; linked' },
  { site: 'ladder decision link', re: /decision ([0-9a-f-]{36})/, sample: 'e-1: decision 00000000-0000-4000-8000-000000000000' },
  { site: 'ask run', re: /\brun ([^\s(]+)/, sample: 'a-1: kind scope; run r-1 (worker); agent x', writers: ['${ask.id}: kind ${ask.kind}; run ${run.id} (${run.role}); agent ${run.agentId ?? \'unknown\'}; question ${digest(ask.question)} (${ask.question.length} chars)'] },
  { site: 'ask run and agent', re: /run (\S+) \([^)]+\); agent ([^;\s]+)/, sample: 'a-1: kind scope; run r-1 (worker); agent x; question d (1 chars)' },
  { site: 'ask joined', re: /queue question (\S+)/, sample: 'a-1: queue question q-1', writers: ['${ask.id}: queue question ${joined}', ': queue question ${decision.id}'], reads: ['`${askId}: queue question `', "split('queue question ')"] },
  { site: 'ask delegated planner', re: /planner (\S+);/, sample: 'a-1: task planner p-1; asked', writers: ["${rung === 'task' ? 'task planner' : 'project planner'} ${agentId}; asked"], reads: ['`${askId}: planner `', '`${askId}: task planner `', '`${askId}: project planner `'] },
  { site: 'ask delegated reviewer', re: /reviewer (\S+);/, sample: 'a-1: reviewer r-1; consult', writers: ['${ask.id}: reviewer ${reviewer}; consult'], reads: ['`${askId}: reviewer `'] },
  { site: 'ask delegated decider', reads: ['`${askId}: decider`'], writers: ['decider requested'] },
  { site: 'ladder cause', re: /cause ([0-9a-f]{64})/, sample: `e-1: cause ${'f'.repeat(64)}; run r-1; question d (1 chars)`, writers: ['${id}: cause ${input.cause}; run ${input.runId ?? \'worker\'}; question ${digest('] },
  { site: 'ladder run', re: /run (\S+?);/, sample: 'e-1: cause x; run r-1; question d (1 chars)' },
  { site: 'ladder ordinary answer', reads: ['`${id}: answered by ordinary `'], writers: ['${escalation.id}: answered by ordinary ${action}: task control moved the task', '${id}: answered by ordinary progress: the task merged or ended first'] },
  { site: 'escalation missed', reads: ['`${id}: no delegated answer was produced;`', '`${escalation.id}: no delegated answer was produced;`', '`${decision.id}: no delegated answer was produced;`'],
    writers: ['${id}: no delegated answer was produced; the escalation stays open for the planner', '${decision.id}: no delegated answer was produced; the question stays on its existing surface'] },
  { site: 'escalation waiting', reads: ['current.resolution.stop?.reason !== expected.stopReason', 'current.resolution.stop.detail !== expected.stopDetail'], writers: ['`Escalation ${id}: waiting for operator decision ${wait.target}`', '`Escalation ${id}: waiting until ${wait.target}`', '`Escalation ${id}: waiting for task ${prerequisite.reference ?? prerequisite.id} to settle`'] },
  { site: 'operator question kinds', reads: ["event.detail.includes('kind release')", "event.detail.includes('kind budget')"], writers: ['${question.id}: kind ${question.kind}; stop ${task.resolution.stop?.reason ?? \'none\'}; head ${task.prHead ?? \'none\'}; question ${digest('] },
  { site: 'operator question intent', reads: ['`question ${digest(question.question)} (${question.question.length} chars)`', '`options ${question.choices.map(choice => choice.label).join(\' | \') || \'none\'}`'] },
  { site: 'held proof answer', reads: ["event.detail.includes('Leave held for the planner')", "result.reply.choice === 'Leave held for the planner'"], writers: ["label: 'Leave held for the planner'"] },
  { site: 'proof GO answer', reads: ['`${questionId}: GO — run the qualification`', '`${goQuestionId}: GO — run the qualification`', "answer.startsWith('GO — run the qualification')"], writers: ["label: 'GO — run the qualification'"] },
  { site: 'absent catalog archive', reads: ["event.detail.includes('observed absent from the catalog and disk without a Queue archive intent')"] },
  { site: 'absent creation', reads: ["event.detail.includes(` ${run.role} creation`)"] },
  { site: 'route stop replay', reads: ["kind LIKE 'route_stop_%'"], writers: ['"route_stop_settled"', '"route_stop_intent"', '"route_stop_uncertain"', '"route_stop_sent"'] },
];

/**
 * Census text that appears at more than one site today. A reword at one site
 * leaves the others, so these carry a floor. A PR that deletes a site lowers it.
 */
const SITES: Record<string, number> = {
  "${rung === 'task' ? 'task planner' : 'project planner'} ${agentId}; asked": 3,
  'decider requested': 3,
  'Task changed; refresh before retrying': 38,
  'Task or run changed; refresh before retrying': 3,
  'A run started during the move': 4,
  'was already reserved at ${head}': 2,
  'The ${run.role} thread stopped without a callback; inspect the thread': 2,
  'callback reminder expired': 3,
  'An unresolved task incident or recovery fence blocks reviewer continuation': 2,
  't.reason === ACCEPTED_PR_RECONCILIATION_REASON': 2,
  "PR must be open, ready, and match the task's branch and base": 2,
  'Worker must remain on queue-owned branch ${task.branch}': 5,
  'capacity.startsWith("Global")': 2,
  '/^(?:planner|decider) /': 2,
  '/decision (\\S+)/': 3,
  'decision ${': 13,
  '/decision ([^;\\s]+)/': 3,
  '`${askId}: queue question `': 4,
  '${ask.id}: queue question ${joined}': 2,
  '/cause ([0-9a-f]{64})/': 2,
  '${id}: cause ${input.cause}; run ${input.runId ?? \'worker\'}; question ${digest(': 2,
  '/run (\\S+?);/': 2,
  '${question.id}: kind ${question.kind}; stop ${task.resolution.stop?.reason ?? \'none\'}; head ${task.prHead ?? \'none\'}; question ${digest(': 2,
  '"route_stop_settled"': 2,
  '"route_stop_intent"': 2,
  "throw Error('Source approval requires an exact-head environment blocked review with findings and named awaiting proofs; if only release gates remain, report ready_to_merge')": 2,
};

for (const row of PARSED) {
  test(`census: ${row.site}`, () => {
    const present = (text: string, what: string) => {
      const floor = SITES[text] ?? 1;
      assert.ok(occurrences(source(), text) >= floor, `${what} is gone or reworded at a site (want ${floor}): ${text}`);
    };
    if (row.re) {
      present(`/${row.re.source}/${row.re.flags}`, 'reader');
      assert.match(row.sample!, row.re);
    }
    for (const text of row.reads ?? []) present(text, 'reader text');
    for (const text of row.writers ?? []) present(text, 'writer text');
  });
}

/**
 * Every event kind the daemon branches on, as of split map row T5, written
 * `kind:reads:writes`: how many sites read it and how many other literals name
 * it. These are floors, because a rename at one site leaves the others standing.
 * A move keeps the counts, and a new kind or a new site needs no edit here. A PR
 * that deletes a reader or writer lowers its floor deliberately.
 */
const EVENT_KINDS = `absent_creation_replaced:2:1 absent_worker_retry:2:1 adopted:1:0 agent_ask:5:4 agent_ask_answered:6:7 agent_ask_decision:2:4 agent_ask_delegated:4:2
agent_ask_delegation_missed:1:3 agent_ask_delegation_unknown:1:4 agent_ask_joined:3:2 agent_ask_planning_ruling:2:1 agent_ask_resumed:3:2
agent_ask_reviewer_missed:1:2 agent_ask_stale_answered:1:2 agent_ask_superseded:4:4 agent_created:1:1 agent_intent:1:3 automatic_retry_suppressed:1:1
blocked_pr_identity_deferred:1:1 blocked_review_evidence:1:1 blocker_ladder_classified:1:1 callback_reminder:3:10 callback_reminder_extended:2:1
callback_reminder_skipped:1:1 cancel:1:52 checkpoint_continued:1:1 closed_out:1:5 closeout_base_renewed:1:1 closeout_hold_refresh:1:1
closeout_recovery_budget:1:1 completion_received:1:4 coordinator_action_refused:1:2 coordinator_rearm:1:1 delegated_answer:5:1 delegated_closed:3:3
delegated_decision_route:2:1 delegated_delivery:4:1 dependencies_changed:1:1 dispatch_intent:1:1
disposition_complete:2:1 disposition_requested:1:1 disposition_turn_interrupted:2:1 environment_deferred:1:3 escalation_resolved:1:1
external_merge_observed:2:3 external_workspace_archive_archived:1:3 hold:1:100 hold_until_blocked:1:1 hook_blocked:2:0 hook_execution_started:3:2
hook_failed:1:0 hook_intent:2:2 hook_published:1:0 hook_result:1:0 hook_uncertain:2:1 hook_workspace_created:1:1 hook_workspace_intent:1:1
incident:3:9 initial_pr_lookup_unavailable:1:1 main_synchronized:1:1 merge_intent:1:1 merge_verified:4:1 native_question_answered:1:1
native_question_delegated:2:1 native_question_operator:1:1 native_question_response_intent:2:1 native_question_unanswered:1:1
native_question_unknown:1:1 needs_attention:4:168 non_delivery:3:12 non_delivery_pushback:2:2 non_delivery_reset:1:2 operator_control:4:2
operator_question:8:9 operator_question_answered:10:8 operator_question_applied:3:1 operator_question_decided:1:1 operator_question_decision:4:7
operator_question_delegation_missed:1:3 operator_question_delegation_unknown:1:3 operator_question_reasked:1:1 operator_question_refused:2:2
operator_question_stale_answered:3:3 operator_question_superseded:3:5 operator_question_unknown:1:3 owned_tool_hold:5:4 owned_tool_settled:3:1
owner_control:3:9 owner_restart_instruction_sent:3:2 owner_stop_sent:5:4 owner_stop_uncertain:2:2 owner_stopped:4:1 owner_verb_deferred:1:1
paused_resume_uncertain:1:2 planner_escalation_answered:1:5 planner_escalation_attached:1:1 planner_escalation_decision:1:1
planner_escalation_decision_linked:1:3 planner_escalation_missed:2:3 planner_escalation_offered:1:1 planner_escalation_payload:2:2
planner_escalation_refusal_sent:1:1 planner_escalation_resolved:1:2 planner_escalation_sent:1:1 planner_escalation_unknown:1:6
pre_merge_candidate_stale:1:3 pre_merge_refused:2:1 pre_merge_warm_candidate_created:2:1 pre_merge_warm_candidate_missing:2:1 progress_checkpoint:2:5
project_planner_missing_notified:1:1 proof_autorun_skipped:1:2 proof_autorun_waiting_inputs:1:1 proof_worker_requested:1:2 queue_ask_delivery:1:1
queue_promoted:1:1 recovery_escalated:2:2 recovery_pending:3:1 release:1:24 report_ready_planner_notice_intent:1:1 reporting_binding_recheck:1:1
responsible_converted:1:0 responsible_fault_restart:1:1 responsible_question:1:14 responsible_question_answered:3:5
responsible_question_stale_answered:1:1 responsible_question_superseded:2:2 review_auto_continue_deferred:1:1 review_checkpoint:1:2
review_delivery_delivered:1:0 review_delivery_refused:1:0 review_delivery_reserved:1:1 review_delivery_uncertain:1:0 review_published:1:2
review_reapplied:5:4 review_result_applied:5:5 reviewer_consult:1:2 reviewer_consult_answered:1:2 reviewer_consult_missed:1:3
reviewer_consult_payload:1:2 reviewer_consult_reviewer:1:2 reviewer_consult_sent:1:2 reviewer_consult_unknown:2:4 revision_budget_exhausted:2:1
revision_requested:4:3 role_replacement:1:6 routing_signoff:1:7 run_completion:1:1 run_completion_corrected:1:1 run_intent:1:1
runnable_proof_refused:1:1 runnable_proof_started:1:1 shell_notice_cleared:1:1 shell_notice_shown:1:1 state:2:40 submitted:1:1 telemetry_recovery:1:2
telemetry_stage:1:5 transport_deferred:1:3 unchanged_check_revision_refused:2:1 unfinished_continuation:2:2 unfinished_pushback:2:2
unused_workspace_archive_intent:1:1 worker_resume_requested:5:5 workspace_archived:2:4 workspace_cleanup_wait:1:1 workspace_contents_discarded:2:3
workspace_created:1:3 workspace_creation_auto_replay:1:1 workspace_released:1:2`.split(/\s+/).map(row => {
  const [kind, reads, writes] = row.split(':');
  return { kind: kind!, reads: Number(reads), writes: Number(writes) };
});
/** Written from a template, so their literal count is zero: the reader names the kinds, the template builds them. */
const KIND_TEMPLATES = ['`review_delivery_${status}`'];

const directRead = /\bevent\.kind\s*[!=]==?\s*(['"])([a-z][a-z0-9_]+)\1/g, listRead = /\[([^\]\n]+)\]\.includes\(event\.kind\)/g;

test('census: no pinned event kind lost a reader', () => {
  const reads = new Map<string, number>();
  const read = (kind: string) => reads.set(kind, (reads.get(kind) ?? 0) + 1);
  for (const match of source().matchAll(directRead)) read(match[2]!);
  for (const match of source().matchAll(listRead)) for (const kind of match[1]!.matchAll(/['"]([a-z][a-z0-9_]+)['"]/g)) read(kind[1]!);
  const lost = EVENT_KINDS.filter(row => (reads.get(row.kind) ?? 0) < row.reads).map(row => `${row.kind}: ${reads.get(row.kind) ?? 0} of ${row.reads}`);
  assert.deepEqual(lost, [], 'a reader was renamed or removed');
});

test('census: no pinned event kind lost a writer', () => {
  const rest = source().replace(directRead, '').replace(listRead, '');
  const count = (kind: string) => occurrences(rest, `'${kind}'`) + occurrences(rest, `"${kind}"`) + occurrences(rest, `\`${kind}\``);
  const lost = EVENT_KINDS.filter(row => count(row.kind) < row.writes).map(row => `${row.kind}: ${count(row.kind)} of ${row.writes}`);
  assert.deepEqual(lost, [], 'a writer was renamed or removed');
  for (const template of KIND_TEMPLATES) assert.ok(rest.includes(template), template);
});
