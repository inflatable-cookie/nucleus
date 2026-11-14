import { fakeAdapter } from './support/fakes';
import { profile as sharedProfile } from './support/fakes';
import { paseoCatalog } from './support/pool-shapes';
import { holdLifecycleFollowUps } from './support/hold-lifecycle-follow-ups';
import { waitFor } from './support/budgets';
import { test } from './support/sharded-test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, Store, operationIdForKey, operationInputHash } from '../core/store/store';
import { Engine, controlHasExternalEffect, PROFILE_CATALOG_PENDING_REASON, PROFILE_CATALOG_LOADING_REFUSAL } from '../core/engine';
import { QueueRuntime } from '../service/runtime-owner';
import { taskControlOperation } from '../core/verbs/task-control-key';
import { ABSENT_WORKER_REASON, type ResolutionAdapter } from '../core/resolution';
import { REVIEW_AUTHORIZATION_REQUIRED, reviewCheckpointPathFor, writeReviewCheckpoint } from '../core/review/review-continuation';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { runFenceRefusal } from '../core/intake/run-settlement';
import { recoveryEffects } from '../core/recovery/recovery-effects';
import { taskProgressDigest } from '../core/recovery/recovery';
import { runPrompt } from '../core/dispatch/prompts';
import { queueOperationSchema } from '../shared/operations';
import {
  REVIEW_CONTINUATION_LIMIT, operationStatus, reviewEntryRecordSchema, runSchema, submissionSchema, taskControlInputSchema, taskNextSchema,
  type Profile, type Run, type Task,
} from '../shared/contracts';
import type { Adapter } from '../core/host';
import { exactProofFixture } from './support/review-entry-fixture';
import { toolTimelinePage } from './support/tool-timeline';

/**
 * Spec 050 `restart`: one owner call gets a stopped, stalled or checkpointed run
 * going again. Queue derives the role, settles the fences the restart
 * supersedes, releases or stops the old run and starts the next one through the
 * existing internals. Every control writes one `owner_control` event.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const CALLER = 'owner-thread';

type Role = 'worker' | 'reviewer' | 'coordinator';
const profile = (id: string, model: string, roles: Role[]): Profile => sharedProfile(id, model, { provider: 'codex' });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-restart-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  // The recorded Paseo catalog (#1143's shared shape) names the models and
  // thinking levels each profile runs: a fixture model the host does not report is
  // unavailable here instead of passing on an invented catalog.
  const worker = profile('worker', 'gpt-6-luna', ['worker']);
  const reviewer = profile('reviewer', 'gpt-6.1-sol', ['reviewer']);
  const coord = profile('coord', 'gpt-6.1-terra', ['coordinator']);
  const all = [worker, reviewer, coord];
  store.setProfiles(all.map(({ available, problem, supportedThinking, ...p }) => p));
  store.setMeta('pool', all.map(item => ({ profileId: item.id, enabled: true, group: item.id, roles: [item.id === 'reviewer' ? 'reviewer' : item.id === 'coord' ? 'coordinator' : 'worker'], weight: 1, scopes: ['general'] })));
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Restart me', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);

  const observations = new Map<string, { id: string; workspaceId: string | null; status: string; active: boolean; permissions: boolean; error: string; provider?: string; model?: string; activeTurnId?: string; updatedAt?: string }>();
  const idle = (id: string, model?: string, workspaceId = 'workspace') =>
    observations.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '', provider: 'codex', model });
  idle('worker-agent', worker.model);
  idle('review-agent', reviewer.model);
  idle('coord-agent', coord.model);
  const continuations: { runId: string; messageId: string }[] = [];
  const createdRuns: Run[] = [];
  const createdRunTokens = new Map<string, string>();
  const archived = new Set<string>();
  const adapter = fakeAdapter({
    catalog: async () => paseoCatalog(),
    validate: async () => base,
    verifyWorkspace: async () => {},
    createWorkspace: async () => { throw new Error('restart fixtures do not create workspaces'); },
    createAgent: async (t: Task, token: string) => {
      createdRunTokens.set(t.runId!, token);
      const id = `worker-${t.runId}`;
      idle(id, t.profile!.model, t.workspaceId!);
      return { id, workspaceId: t.workspaceId };
    },
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' },
    originAgent: async (id: string) => ({ id, workspaceId: 'workspace', title: id, archived: archived.has(id) }),
    archiveAgent: async (id: string) => { archived.add(id); }, notify: async () => {},
    findRunAgents: async () => [],
    verifyPr: async () => ({ head: store.task(submitted.id).prHead ?? head, url: store.task(submitted.id).prUrl ?? 'https://github.com/example/repo/pull/7', repository: 'example/repo', headRepository: 'example/repo', crossRepository: false }),
    verifyPrIdentity: async () => ({ head: store.task(submitted.id).prHead ?? head, url: store.task(submitted.id).prUrl ?? 'https://github.com/example/repo/pull/7', repository: 'example/repo', headRepository: 'example/repo', crossRepository: false }),
    verifyCleanQueueWorktree: async () => {}, verifyResume: async () => {}, verifyReview: async () => 12345, publishReview: async () => 12345,
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {},
    // The launcher owns run credentials (like the real adapter, these stubs
    // never write the credentials table); the token is tracked here so the
    // test can authenticate the follow-up result on the launched run.
    createRun: async (_t: Task, r: Run, token: string) => { createdRuns.push(r); createdRunTokens.set(r.id, token); return { id: `agent-${r.id}`, workspaceId: r.workspaceId }; },
    sendRun: async (_t: Task, r: Run, token: string) => { createdRuns.push(r); createdRunTokens.set(r.id, token); },
    continueReviewer: async (_t: Task, r: Run, messageId: string) => {
      const state = observations.get(r.agentId!);
      if (!state || state.status !== 'idle' || state.active || state.permissions) return { sent: false as const, reason: 'reviewer not idle' };
      continuations.push({ runId: r.id, messageId });
      return { sent: true as const };
    },
    // This stub models an ended turn in the next observation, not just a
    // cancellation request. A pending permission remains independently live.
    stopAgentTurn: async (id: string) => {
      const state = observations.get(id);
      if (state) { state.active = false; state.status = 'idle'; state.activeTurnId = undefined; }
    },
  } as unknown as Adapter & ResolutionAdapter);
  const engine = new Engine(store, adapter, 0);
  engine.currentServiceBuildId = () => 'restart-fixture-build';
  engine.profiles = all;
  const current = () => store.task(submitted.id);
  const control = (args: Record<string, unknown> = {}) => engine.performTaskControl(taskControlInputSchema.parse({
    taskId: submitted.id, version: current().version, action: 'restart', reason: 'Owner restart', caller: CALLER, ...args,
  }));
  const events = (kind: string) => store.eventsAll(submitted.id).filter(event => event.kind === kind);
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, current())));
  return {
    dir, store, engine, adapter, profiles: { worker, reviewer, coord }, taskId: submitted.id, current, control, events, next,
    observations, createdRunTokens, createdRuns,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const ownerControlCount = (f: ReturnType<typeof fixture>) => f.events('owner_control').length;

test('a parked restart refusal keeps its execution proof and reconciles only that unchanged occurrence', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', true);
    const at = new Date().toISOString();
    f.store.putRun(runSchema.parse({ id: 'proof-recovery', taskId: f.taskId, role: 'recovery', generation: 1,
      head, base, agentId: 'coord-agent', workspaceId: 'workspace', profile: f.profiles.coord,
      status: 'running', createdAt: at, lastObservedAt: null, active: true, idleSince: null, completion: null, released: false }));
    f.store.update(f.taskId, { phase: 'needs_attention', agentId: 'worker-agent', runId: 'worker-run',
      workspaceId: 'workspace', directory: '/worktree', profile: f.profiles.worker, agentIntent: true,
      resolution: { ...f.current().resolution, attention: true, currentRunId: null } });
    const before = f.current(), runs = f.store.runs(f.taskId);
    const control = taskControlInputSchema.parse({ taskId: f.taskId, version: before.version, action: 'restart', role: 'reviewer',
      reason: 'Resume review', caller: CALLER });
    const { key, payload } = taskControlOperation(control);
    const accepted = await f.engine.startOperation({ key, kind: 'task_control', payload });
    assert.ok('accepted' in accepted);
    const failed = await f.engine.awaitOperation(accepted.operation.id);
    // Parent falsification: old prose classification made this needs_attention.
    assert.equal(failed.state, 'failed');
    assert.match(failed.diagnostic, /retained thread or uncertain delivery/);
    assert.ok(failed.preSendReceipt?.buildId);
    assert.deepEqual(f.current(), before);
    assert.deepEqual(f.store.runs(f.taskId), runs);
    assert.equal(f.createdRuns.length, 0);
    const input = operationStatus.input.parse({ operationId: failed.id, reconcilePreSendInputHash: failed.inputHash });
    const publicStatus = (args: typeof input) => QueueRuntime.prototype.operationStatus.call({ store: f.store, engine: f.engine } as QueueRuntime, args);
    assert.deepEqual(publicStatus(input), failed, 'an already definite refusal is not reported as uncertain');
    f.store.putOperation(failed, { ...payload, control: { ...control, reason: 'Mismatched stored request' } });
    await assert.rejects(f.engine.startOperation({ key, kind: 'task_control', payload }), /receipt or delivery evidence conflicts/);
    f.store.putOperation(failed, payload);

    // Simulate interruption after the durable receipt, before settlement; a
    // restarted scheduler must fence it instead of executing the control again.
    const receipt = failed.preSendReceipt!;
    const conflictingEffect = { ...receipt.effect, status: 'reconciled' as const, result: 'Observed external effect', resultAt: at };
    f.store.putOperation({ ...failed, state: 'running', settledAt: null, effect: conflictingEffect });
    f.engine.resumeOperations();
    const conflicting = await f.engine.awaitOperation(failed.id);
    assert.equal(conflicting.state, 'needs_attention');
    assert.deepEqual(conflicting.effect, conflictingEffect, 'restart preserves conflicting effect evidence');
    f.store.putOperation({ ...failed, state: 'running', settledAt: null, diagnostic: '', effect: receipt.effect });
    f.engine.resumeOperations();
    const held = await f.engine.awaitOperation(failed.id);
    assert.equal(held.state, 'needs_attention');
    assert.equal(held.attempts, 1);
    assert.throws(() => publicStatus({ ...input, reconcilePreSendInputHash: 'f'.repeat(64) }), /conflicts/);
    f.store.putOperation({ ...held, preSendReceipt: null });
    // The journal alone cannot stand in for the receipt when the boundary had
    // already armed: the legacy reconcile refuses it too.
    assert.throws(() => publicStatus(input), /evidence conflicts/);
    f.store.putOperation({ ...held, state: 'running', diagnostic: '', preSendReceipt: null, effect: receipt.effect });
    f.engine.resumeOperations();
    const unknown = await f.engine.awaitOperation(held.id);
    assert.equal(unknown.state, 'needs_attention');
    assert.match(unknown.diagnostic, /without a pre-send receipt/);
    assert.equal(unknown.attempts, 1);
    assert.equal(f.createdRuns.length, 0);
    f.store.putOperation(held);
    f.store.putRun({ ...runs[0]!, active: false });
    assert.throws(() => publicStatus(input), /evidence changed/);
    f.store.putRun(runs[0]!);
    f.store.putOperation({ ...held, attempts: 2 });
    assert.throws(() => publicStatus(input), /conflicts/);
    f.store.putOperation(held);
    for (const status of ['delivered', 'uncertain', 'reserved'] as const) {
      f.store.putRun({ ...runs[0]!, reviewDeliveries: [{ authorizationId: 'auth', operationId: held.id,
        deliveryId: `ns-review-${'a'.repeat(64)}`, taskId: f.taskId, runId: runs[0]!.id, head,
        checkpointOrdinal: 1, taskVersion: before.version, briefVersion: null, briefDigest: null,
        reason: 'Review', instruction: 'Continue', createdAt: at, status, evidence: '', observedAt: null }] });
      assert.throws(() => publicStatus(input), /reviewer delivery/);
      f.store.putRun(runs[0]!);
    }
    const settled = publicStatus(input);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.id, held.id);
    assert.equal(settled.inputHash, held.inputHash);
    assert.equal(settled.attempts, held.attempts);
    assert.deepEqual(settled.effect, held.effect);
    assert.equal(settled.diagnostic, held.diagnostic);
    assert.deepEqual(publicStatus(input), settled);
    assert.deepEqual(f.current(), before);
    assert.deepEqual(f.store.runs(f.taskId), runs);
    assert.equal(f.createdRuns.length, 0);
    f.store.putRun({ ...runs[0]!, released: true, status: 'finished', active: false });
    const repeated = await f.engine.startOperation({ key, kind: 'task_control', payload });
    assert.ok('accepted' in repeated);
    const retried = await f.engine.awaitOperation(failed.id);
    assert.equal(retried.id, failed.id);
    assert.equal(retried.attempts, 2);
    assert.equal(retried.state, 'succeeded');
    assert.deepEqual(retried.preSendHistory?.[0]?.receipt, receipt);
    assert.deepEqual(retried.preSendHistory?.[0]?.effect, held.effect);
    assert.equal(retried.preSendHistory?.[0]?.diagnostic, held.diagnostic);
  } finally { await f.close(); }
});

test('a durable parked restart records wrong-role instructions as a definite refusal', async () => {
  const f = fixture(); try {
    f.store.setMeta('paused', true);
    f.store.update(f.taskId, { phase: 'needs_attention', agentId: 'worker-agent', runId: 'worker-run',
      workspaceId: 'workspace', directory: '/worktree', profile: f.profiles.worker, agentIntent: true,
      resolution: { ...f.current().resolution, attention: true, currentRunId: null } });
    const before = f.current();
    const control = taskControlInputSchema.parse({ taskId: f.taskId, version: before.version, action: 'restart', role: 'coordinator',
      reason: 'Retry the parked step', instruction: 'This instruction cannot reach the coordinator', caller: CALLER });
    const { key, payload } = taskControlOperation(control);
    const accepted = await f.engine.startOperation({ key, kind: 'task_control', payload });
    assert.ok('accepted' in accepted);
    const failed = await f.engine.awaitOperation(accepted.operation.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.diagnostic, /instruction on a parked restart applies only/);
    assert.equal(failed.effect?.status, 'reconciled');
    assert.ok(failed.preSendReceipt);
    assert.deepEqual(f.current(), before);
    assert.equal(f.createdRuns.length, 0);
    const repeated = await f.engine.startOperation({ key, kind: 'task_control', payload });
    assert.ok('accepted' in repeated);
    const failedAgain = await f.engine.awaitOperation(accepted.operation.id);
    assert.equal(failedAgain.state, 'failed');
    assert.equal(failedAgain.attempts, 2);
    assert.equal(failedAgain.preSendReceipt?.attempt, 2);
    assert.equal(failedAgain.preSendHistory?.[0]?.diagnostic, failed.diagnostic);
    assert.deepEqual(failedAgain.preSendHistory?.[0]?.effect, failed.effect);
  } finally { await f.close(); }
});

test('a control refused by Queue\'s own fence settles as not sent, with a receipt, and blocks nothing', async () => {
  const f = fixture(); try {
    const { reviewer } = coordinatorWithReviewerFence(f);
    // The finished reviewer is idle: planning settles it with the restart.
    const at = new Date().toISOString();
    f.store.putRun({ ...reviewer, status: 'finished', active: false, idleSince: at, lastObservedAt: at });
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    // The durable fence appears while Queue observes the run: the settlement
    // boundary recheck refuses with Queue's own fence, which names the
    // uncertain run-delivery effect (task 620, PR 868). That prose never
    // decides the outcome (papercut 4b285a6e).
    f.adapter.observe = async id => {
      const reader = f.store.run(reviewer.id)!;
      if (id === 'review-agent' && reader.status !== 'uncertain') f.store.putRun({ ...reader, status: 'uncertain' });
      return f.observations.get(id)!;
    };
    const before = f.current(), runs = f.store.runs(f.taskId);
    const control = taskControlInputSchema.parse({ taskId: f.taskId, version: before.version, action: 'restart', role: 'coordinator',
      reason: 'Owner restart', caller: CALLER });
    const { key, payload } = taskControlOperation(control);
    const accepted = await f.engine.startOperation({ key, kind: 'task_control', payload, taskId: f.taskId, expectedVersion: control.version });
    assert.ok('accepted' in accepted);
    const failed = await f.engine.awaitOperation(accepted.operation.id);
    // Parent falsification: the old prose classification settled this needs_attention.
    assert.equal(failed.state, 'failed');
    assert.match(failed.diagnostic,
      new RegExp(`A reviewer run \\(${reviewer.id}\\) holds a durable side effect Queue will not act over blindly \\(run-delivery ${reviewer.id} is uncertain: run ${reviewer.id} has an uncertain delivery\\)`));
    assert.equal(failed.effect?.status, 'reconciled');
    assert.equal(failed.preSendReceipt?.boundary, 'pre-send-refusal-v1');
    assert.equal(failed.preSendReceipt?.attempt, 1);
    assert.deepEqual(f.current(), before, 'the refusal changed nothing');
    assert.deepEqual(f.store.runs(f.taskId), runs.map(run => run.id === reviewer.id ? { ...run, status: 'uncertain' } : run));
    assert.equal(f.createdRuns.length, 0);
    // A failed pre-send control is not a blocking recovery effect: only the
    // run's own recorded fence remains, never the refused control.
    const effects = recoveryEffects(f.store, f.current());
    assert.equal(effects.some(effect => effect.kind === 'operation' && effect.identity === failed.id), false);
    // The ordinary retry reopens the refused operation; both attempts keep
    // their own receipts, and the plan-time fence refuses the retry the same way.
    const retried = await f.engine.startOperation({ key, kind: 'task_control', payload });
    assert.ok('accepted' in retried);
    const again = await f.engine.awaitOperation(failed.id);
    assert.equal(again.state, 'failed');
    assert.match(again.diagnostic, new RegExp(`still owns this task: run-delivery ${reviewer.id} is uncertain: run ${reviewer.id} has an uncertain delivery`));
    assert.equal(again.attempts, 2);
    assert.equal(again.preSendReceipt?.attempt, 2);
    assert.deepEqual(again.preSendHistory?.[0]?.receipt, failed.preSendReceipt);
    assert.deepEqual(again.preSendHistory?.[0]?.effect, failed.effect);
    assert.equal(again.preSendHistory?.[0]?.diagnostic, failed.diagnostic);
  } finally { await f.close(); }
});

test('a legacy refused-but-uncertain control reconciles through its own pre-send refusal evidence', async () => {
  const f = fixture(); try {
    // The effigy#528 shape: a checkpointed reviewer whose delivery is unknown
    // fenced `restart role=reviewer`; the old settlement recorded Queue's own
    // refusal as an uncertain effect with no receipt.
    reviewingTask(f, 'reader-run', 'ckpt-1');
    f.store.putRun({ ...f.store.run('reader-run')!, status: 'uncertain' });
    const control = taskControlInputSchema.parse({ taskId: f.taskId, version: f.current().version, action: 'restart', role: 'reviewer',
      reason: 'Resume review', caller: CALLER });
    const { key, payload } = taskControlOperation(control);
    const id = operationIdForKey(key), inputHash = operationInputHash(payload);
    const at = new Date().toISOString();
    const diagnostic = runFenceRefusal(f.store.run('reader-run')!, 'its delivery is unknown');
    const operation = queueOperationSchema.parse({
      id, key, kind: 'task_control', inputHash, state: 'needs_attention', taskId: f.taskId, expectedVersion: control.version,
      createdAt: at, startedAt: at, settledAt: at, attempts: 1, diagnostic,
      effect: { kind: 'task_control', target: 'restart', intentAt: at, status: 'uncertain', result: diagnostic.slice(0, 2000), resultAt: at },
    });
    f.store.putOperation(operation, payload);
    const taskBefore = f.current(), runsBefore = f.store.runs(f.taskId);
    const input = operationStatus.input.parse({ operationId: id, reconcilePreSendInputHash: inputHash });
    const publicStatus = (args: typeof input) => QueueRuntime.prototype.operationStatus.call({ store: f.store, engine: f.engine } as QueueRuntime, args);
    // The journal must prove the refusal: a different input, a retry, an armed
    // boundary, a bound delivery or any other diagnostic stays uncertain.
    assert.throws(() => publicStatus({ ...input, reconcilePreSendInputHash: 'f'.repeat(64) }), /conflicts/);
    f.store.putOperation({ ...operation, attempts: 2 });
    assert.throws(() => publicStatus(input), /conflicts/);
    f.store.putOperation({ ...operation, preSendBoundaryStartedAt: at });
    assert.throws(() => publicStatus(input), /conflicts/);
    f.store.putOperation(operation);
    f.store.putRun({ ...f.store.run('reader-run')!, reviewDeliveries: [{ authorizationId: 'auth', operationId: id,
      deliveryId: `ns-review-${'a'.repeat(64)}`, taskId: f.taskId, runId: 'reader-run', head,
      checkpointOrdinal: 1, taskVersion: control.version, briefVersion: null, briefDigest: null,
      reason: 'Review', instruction: 'Continue', createdAt: at, status: 'reserved', evidence: '', observedAt: null }] });
    assert.throws(() => publicStatus(input), /conflicts/);
    const reader = f.store.run('reader-run')!;
    const { reviewDeliveries: withoutDelivery, ...readerWithoutDelivery } = reader;
    f.store.putRun(readerWithoutDelivery);
    const foreign = 'connection lost while continuing the reviewer';
    f.store.putOperation({ ...operation, diagnostic: foreign, effect: { ...operation.effect!, result: foreign } });
    assert.throws(() => publicStatus(input), /not one of Queue's own pre-send refusal messages/);
    const ghost = runFenceRefusal({ ...f.store.run('reader-run')!, id: 'ghost-run' }, 'its delivery is unknown');
    f.store.putOperation({ ...operation, diagnostic: ghost, effect: { ...operation.effect!, result: ghost.slice(0, 2000) } });
    assert.throws(() => publicStatus(input), /not one of Queue's own pre-send refusal messages/);
    f.store.putOperation(operation);
    // Exactly the refused population relabels: nothing re-runs, nothing retries.
    const reconciled = publicStatus(input);
    assert.equal(reconciled.state, 'failed');
    assert.equal(reconciled.diagnostic, diagnostic);
    assert.ok(reconciled.preSendReconciledAt);
    assert.equal(reconciled.preSendReceipt, undefined, 'no receipt is invented; the recorded refusal stays history');
    assert.deepEqual(publicStatus(input), reconciled, 'the reconcile is idempotent');
    assert.deepEqual(f.current(), taskBefore);
    assert.deepEqual(f.store.runs(f.taskId), runsBefore);
    assert.equal(f.createdRuns.length, 0);
    // The reconciled control no longer blocks ordinary review.
    assert.equal(recoveryEffects(f.store, f.current()).some(effect => effect.kind === 'operation'), false);
  } finally { await f.close(); }
});

/** Drives the continuation run a worker/revision restart launched and authenticates its result. */
async function advanceViaRevision(f: ReturnType<typeof fixture>, prNumber = 7): Promise<void> {
  await f.engine.wake();
  const revision = f.store.runs(f.taskId).findLast(run => run.role === 'revision');
  assert.ok(revision, 'the restart launched the continuation run');
  const token = f.createdRunTokens.get(revision!.id)!;
  const release = holdLifecycleFollowUps(f.engine);
  await f.engine.complete({ eventId: randomUUID(), taskId: f.taskId, runId: revision!.id, status: 'ready_for_review', summary: 'Ready for review', head: revision!.head, prNumber }, token);
  await waitFor(() => f.current().phase !== 'changes_requested', 10_000, 'revision to enter review');
  assert.equal(f.current().phase, 'awaiting_review', 'the authenticated result advanced the task');
  release();
}

/** Drives the fresh reviewer a restart launched and authenticates its verdict. */
async function advanceViaFreshReview(f: ReturnType<typeof fixture>): Promise<void> {
  await f.engine.wake();
  const review = f.store.runs(f.taskId).findLast(run => run.role === 'reviewer' && !run.released);
  assert.ok(review, 'the restart launched a fresh reviewer run');
  const token = f.createdRunTokens.get(review!.id)!;
  await f.engine.complete({ eventId: randomUUID(), taskId: f.taskId, runId: review!.id, status: 'changes_required', summary: 'One finding', head, reviewResponsibility: 'author', reviewText: 'Address the retry guard.' }, token);
  await f.engine.wake();
  assert.equal(f.current().phase, 'changes_requested', 'the authenticated result advanced the task');
}

/** Checks the worker identity selected by restart and authenticates its result. */
async function advanceViaWorkerRestart(f: ReturnType<typeof fixture>, fresh: boolean, prNumber = 7): Promise<void> {
  await f.engine.wake();
  assert.equal(f.current().workspaceId, 'workspace');
  assert.equal(f.current().profile?.id, f.profiles.worker.id, 'fresh uses the current route');
  if (fresh) {
    assert.notEqual(f.current().agentId, 'worker-agent');
    assert.equal(f.current().phase, 'working', f.current().reason);
    const task = f.current();
    const token = f.createdRunTokens.get(task.runId!)!;
    const response = await f.engine.complete({ eventId: randomUUID(), taskId: f.taskId, runId: task.runId!, status: 'ready_for_review', summary: 'Ready', head, prNumber }, token);
    assert.equal(response.accepted, true);
    await f.engine.wake();
    assert.ok(['awaiting_review', 'reviewing'].includes(f.current().phase), 'the authenticated worker result advanced to review');
  } else {
    assert.equal(f.current().agentId, 'worker-agent');
    const revision = f.createdRuns.findLast(run => run.role === 'revision')!;
    assert.equal(revision.agentId, 'worker-agent');
    await advanceViaRevision(f, prNumber);
  }
  assert.equal(ownerControlCount(f), 1);
}

test('restart schema requires a reason and scopes role, instruction and fresh to restart', () => {
  const baseInput = { taskId: 't', version: 1, action: 'restart' } as const;
  assert.equal(taskControlInputSchema.safeParse(baseInput).success, false, 'a reason is required');
  assert.ok(taskControlInputSchema.safeParse({ ...baseInput, reason: 'go' }).success);
  assert.ok(taskControlInputSchema.safeParse({ ...baseInput, reason: 'go', role: 'reviewer', instruction: 'finish', fresh: true }).success);
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action:'move',to:'work',reason:'Return to the retained author', fresh: true }).success, false, 'fresh is restart-only');
  assert.equal(taskControlInputSchema.safeParse({ ...baseInput, reason: 'go', profileId: 'p' }).success, false, 'a profile stays route-only');
  assert.equal(taskControlInputSchema.safeParse({ ...baseInput, reason: 'go', now: true }).success, false, 'now stays route-only');
});

for (const fresh of [false, true]) {
  test(`blocked pre-PR worker: restart returns the retained worker to work and writes one owner_control (fresh=${fresh})`, async () => {
    const f = fixture(); try {
      f.store.update(f.taskId, {
        phase: 'blocked', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
        profile: f.profiles.worker, workerModel: f.profiles.worker.model,
        completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'blocked-1', status: 'blocked', summary: 'Need a ruling' },
      });
      const restart = f.next().verbs.find(verb => verb.verb === 'restart')!;
      assert.equal(restart.available, true, JSON.stringify(restart));
      assert.equal((restart.args as Record<string, unknown>).role, 'worker');
      assert.deepEqual(restart.fill, ['reason']);

      const task = await f.control({ fresh, instruction: 'Address the blocker and continue' });
      assert.equal(task.phase, 'changes_requested');
      assert.equal(task.resolution.prePrResumeInstruction, 'Address the blocker and continue');
      assert.equal(ownerControlCount(f), 1);
      assert.equal(JSON.parse(f.events('owner_control')[0].detail).verb, 'restart');
      if (fresh) {
        // Spec 058 task 577: a fresh restart on the same model with no failure
        // or operator relay continues the retained worker and names its rule.
        assert.equal(task.replacementProfile, null);
        assert.match(f.events('worker_replacement_refused').at(-1)!.detail, /^fresh_without_cause_or_relay:/);
      }
      // The continuation run's authenticated result advances the task.
      await advanceViaWorkerRestart(f, false, 8);
    } finally { await f.close(); }
  });
}

test('restart role=worker resumes a pre-PR changes_requested task after move to work left no worker', async () => {
  const f = fixture(); try {
    // Move to work on a pre-PR task with no author leaves the #226 state when
    // the retained checkout and route exist but the worker creation has not run.
    f.store.update(f.taskId, {
      phase: 'blocked', agentId: null, runId: 'previous-worker-run',
      workspaceId: 'workspace', directory: '/worktree', profile: f.profiles.worker,
      completion: null, prUrl: null, prHead: null,
    });
    const move = f.next().verbs.find(verb => verb.verb === 'move' && verb.args?.to === 'work')!;
    assert.equal(move.available, true, JSON.stringify(move));
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...move.args,
      reason: 'Return this pre-PR task to its author', instruction: 'Continue the approved task', caller: CALLER }));
    assert.equal(moved.phase, 'changes_requested');

    const restart = f.next().verbs.find(verb => verb.verb === 'restart')!;
    assert.equal(restart.available, true, JSON.stringify(restart));
    assert.equal((restart.args as Record<string, unknown>).role, 'worker');
    const task = await f.engine.performTaskControl(taskControlInputSchema.parse({
      ...restart.args, reason: 'Resume the author after move to work', caller: CALLER,
    }));
    assert.equal(task.phase, 'changes_requested');
    await (f.engine as unknown as { recoverExhaustedWorkers(): Promise<void> }).recoverExhaustedWorkers();
    assert.ok(f.current().agentId, 'restart starts the author on the retained task');
    assert.equal(f.current().workspaceId, 'workspace');
    assert.equal(ownerControlCount(f), 2, 'move to work and restart are both audited owner controls');
  } finally { await f.close(); }
});

for (const fresh of [false, true]) {
  test(`blocked worker with a retained PR: restart resumes the blocked task (fresh=${fresh})`, async () => {
    const f = fixture(); try {
      f.store.update(f.taskId, {
        phase: 'blocked', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
        profile: f.profiles.worker, workerModel: f.profiles.worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
        completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'blocked-2', status: 'blocked', summary: 'Blocked', prNumber: 7 },
      });
      const task = await f.control({ fresh, instruction: 'Continue after the blocker' });
      assert.equal(task.phase, 'changes_requested');
      assert.equal(ownerControlCount(f), 1);
      if (fresh) {
        // Spec 058 task 577: the same model with no failure continues the
        // retained worker even through an explicit fresh restart.
        assert.equal(task.replacementProfile, null);
        assert.match(f.events('worker_replacement_refused').at(-1)!.detail, /^fresh_without_cause_or_relay:/);
      }
      await advanceViaWorkerRestart(f, false, 7);
    } finally { await f.close(); }
  });
}

test('explicit worker restart delivers its instruction at the bound PR without inventing a review defect', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'blocked_with_pr', false);
    const task = await f.control({ role: 'worker', instruction: 'Finish the blocked revision after the provider reset' });
    assert.equal(task.phase, 'changes_requested');
    assert.equal(task.prUrl, 'https://github.com/example/repo/pull/7');
    assert.equal(task.resumePrNumber, 7);
    await f.engine.wake();
    const revision = f.store.runs(f.taskId).findLast(run => run.role === 'revision')!;
    assert.equal(revision.agentId, 'worker-agent', 'the retained worker continues');
    assert.equal(revision.workspaceId, 'workspace');
    assert.equal(revision.head, head, 'the continuation stays at the bound PR head');
    assert.equal(revision.instruction, 'Finish the blocked revision after the provider reset');
    assert.deepEqual(revision.retryContext,
      { source: 'worker', runId: 'worker-run', status: 'blocked', head: null, summary: 'Owner ruling needed' },
      'the initial blocked result travels as diagnostic context, never as instruction');
    const prompt = runPrompt(f.current(), revision, '/helper', '/ticket', true);
    assert.match(prompt, /Current action: Finish the blocked revision after the provider reset/);
    assert.match(prompt, /Owner ruling needed/);
    assert.doesNotMatch(prompt, /undefined|Review findings:|public review findings/i);
    assert.doesNotMatch(prompt, /Owner restart/, 'the restart reason stays audit text, not instruction');
    assert.equal(f.current().prUrl, 'https://github.com/example/repo/pull/7', 'no replacement PR is opened');
    assert.equal(f.current().resolution.review, null, 'no review is invented for the continuation');
  } finally { await f.close(); }
});

for (const fresh of [false, true]) test(`worker restart replaces an inactive errored worker on the existing workspace and PR (fresh=${fresh})`, async () => {
  const f = fixture(); try {
    const alternate = profile('worker-alt', 'gpt-6-luna', ['worker']);
    f.engine.profiles = [f.profiles.worker, f.profiles.reviewer, f.profiles.coord, alternate];
    f.store.setMeta('pool', [
      { profileId: f.profiles.worker.id, enabled: true, group: f.profiles.worker.id, roles: ['worker'], weight: 1, scopes: ['general'] },
      { profileId: alternate.id, enabled: true, group: alternate.id, roles: ['worker'], weight: 1, scopes: ['general'] },
    ]);
    f.store.update(f.taskId, { phase: 'blocked', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
      profile: f.profiles.worker, workerModel: f.profiles.worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'errored-worker', status: 'blocked', summary: 'Provider connection error' } });
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'error', active: false, permissions: false,
      error: 'Connection error', provider: 'codex', model: f.profiles.worker.model });
    await f.control({ role: 'worker', fresh });
    await f.engine.wake();
    const task = f.current();
    assert.equal(task.profile?.id, f.profiles.worker.id, 'a connection error does not exclude the worker profile');
    assert.equal(task.retiredWorkers.length, 1);
    assert.equal(task.workspaceId, 'workspace');
    assert.equal(task.directory, '/worktree');
    assert.equal(task.prUrl, 'https://github.com/example/repo/pull/7');
    assert.equal(task.resumePrNumber, 7, 'the existing PR remains bound for resume');
    assert.equal(f.store.runs(f.taskId).some(run => run.role === 'recovery'), false);
  } finally { await f.close(); }
});

test('a settled executor does not block an explicit retained reviewer instruction at its exact PR head', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'blocked_with_pr', false);
    const at = new Date().toISOString();
    const executorId = 'settled-proof-run';
    const completion = { taskId: f.taskId, runId: executorId, eventId: 'proof-settled', status: 'proof_executed' as const,
      summary: 'The proof receipt is ready', head, proofResult: { selector: 'native-proof', status: 'failed' as const,
        exitCode: 1, evidence: 'case alpha failed' } };
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, reviewerAgentId: 'review-agent', reviewerProfile: f.profiles.reviewer },
      reason: 'Settled proof needs an owner decision' });
    f.store.putRun(runSchema.parse({ id: executorId, taskId: f.taskId, role: 'executor', generation: 1, head, base,
      agentId: 'proof-agent', workspaceId: 'workspace', profile: f.profiles.worker, status: 'finished', createdAt: at,
      lastObservedAt: at, active: false, idleSince: at, completion, released: true }));
    f.store.update(f.taskId, { proofExecutions: [{ runId: executorId, agentId: 'proof-agent', workspaceId: 'workspace',
      profile: f.profiles.worker, operationId: null, selector: 'native-proof', inputs: [], repository: 'example/repo',
      prNumber: 7, branch: 'ns-task', head, briefVersion: null, briefDigest: null,
      authorizedBy: { role: 'operator', caller: CALLER, note: null }, activatedAt: at, settledAt: at,
      status: 'failed', historical: false, exitCode: 1, evidence: 'case alpha failed' }] });

    const task = await f.control({ role: 'reviewer', instruction: 'Judge the settled proof receipt' });
    assert.equal(task.phase, 'awaiting_review');
    assert.equal(task.resolution.pendingReviewReason, 'Judge the settled proof receipt');
    assert.equal(task.resolution.reviewerAgentId, 'review-agent', 'the retained reviewer stays bound');
    assert.equal(task.prHead, head);
  } finally { await f.close(); }
});

test('a later blocked revision wins over the stale initial worker context on a restart', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'blocked_with_pr', false);
    const initial = f.current().completion!;
    const laterHead = 'd'.repeat(40), laterSummary = 'Stopped after the docs check failed';
    // The original worker callback stays immutable history while its later revision blocks.
    f.store.putRun(runSchema.parse({ id: 'later-blocked', taskId: f.taskId, role: 'revision', generation: 1, head: laterHead, base,
      agentId: 'worker-agent', workspaceId: 'workspace', profile: f.profiles.worker, status: 'finished',
      createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: false, idleSince: new Date().toISOString(),
      completion: { eventId: 'later-block', taskId: f.taskId, runId: 'later-blocked', status: 'blocked', summary: laterSummary, head: laterHead }, released: true }));
    f.store.update(f.taskId, { prHead: laterHead, reason: laterSummary, completion: initial });
    await f.control({ role: 'worker', instruction: 'Resume the latest blocked revision' });
    await f.engine.wake();
    const revision = f.store.runs(f.taskId).findLast(run => run.role === 'revision' && run.id !== 'later-blocked')!;
    assert.equal(revision.head, laterHead);
    assert.equal(revision.instruction, 'Resume the latest blocked revision');
    assert.deepEqual(revision.retryContext, { source: 'revision', runId: 'later-blocked', status: 'blocked', head: laterHead, summary: laterSummary },
      'the current authenticated block wins over the stale initial context');
    const prompt = runPrompt(f.current(), revision, '/helper', '/ticket', true);
    assert.match(prompt, new RegExp(laterSummary));
    assert.doesNotMatch(prompt, new RegExp(initial.summary!), 'the superseded initial block is not presented as current context');
    assert.doesNotMatch(prompt, /undefined|Review findings:|public review findings/i);
    assert.equal(f.current().completion?.summary, initial.summary, 'the original worker callback remains immutable');
  } finally { await f.close(); }
});

test('a refused explicit worker restart opens no PR and starts no run', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'blocked_with_pr', false);
    const state = f.observations.get('worker-agent')!;
    f.observations.set('worker-agent', { ...state, status: 'running', active: true });
    const before = restartState(f);
    await assert.rejects(f.control({ role: 'worker', instruction: 'Do the requested work' }), /active or awaiting a response/);
    assert.deepEqual(restartState(f), before, 'a refusal changes nothing');
    assert.equal(f.store.runs(f.taskId).length, 0, 'no continuation run is started');
    assert.equal(f.createdRuns.length, 0, 'no worker turn is sent');
    assert.equal(f.current().prUrl, 'https://github.com/example/repo/pull/7');
  } finally { await f.close(); }
});

for (const fresh of [false, true]) {
  test(`retained worker between runs with a PR: restart honours the selected agent mode (fresh=${fresh})`, async () => {
    const f = fixture(); try {
      f.store.update(f.taskId, {
        phase: 'changes_requested', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
        profile: f.profiles.worker, workerModel: f.profiles.worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
        completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-1', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
      });
      const task = await f.control({ fresh, instruction: 'Continue the revision' });
      assert.equal(task.phase, 'changes_requested');
      // Spec 058 task 577: no failure and no model change arms no replacement.
      assert.equal(task.failoverReason ?? '', '');
      if (fresh) assert.match(f.events('worker_replacement_refused').at(-1)!.detail, /^fresh_without_cause_or_relay:/);
      assert.equal(task.resolution.pendingWorkerInstruction, 'Continue the revision');
      assert.equal(ownerControlCount(f), 1);
      await advanceViaWorkerRestart(f, false);
    } finally { await f.close(); }
  });
}

type WorkerRestartCase = 'blocked_worker' | 'blocked_with_pr' | 'retained_worker' | 'stopped_revision';function retainedWorker(f: ReturnType<typeof fixture>, shape: WorkerRestartCase, savedActive: boolean) {
  const withPr = shape === 'blocked_with_pr' || shape === 'stopped_revision';
  f.store.update(f.taskId, {
    phase: shape.startsWith('blocked') ? 'blocked' : shape === 'stopped_revision' ? 'changes_requested' : 'needs_attention',
    agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: join(f.dir, 'worktree'),
    profile: f.profiles.worker, workerModel: f.profiles.worker.model,
    agentActive: savedActive, lastAgentStatus: savedActive ? 'running' : 'idle', lastObservedAt: new Date().toISOString(),
    ...(withPr ? { prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7 } : {}),
    ...(shape.startsWith('blocked') ? { completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'blocked',
      status: 'blocked' as const, summary: 'Owner ruling needed', ...(withPr ? { prNumber: 7 } : {}) } } : {}),
  });
  f.store.setCredential('worker-run', 'worker-token');
  if (shape === 'stopped_revision') {
    f.store.putRun(runSchema.parse({ id: 'revision-run', taskId: f.taskId, role: 'revision', generation: 1, head, base,
      agentId: 'worker-agent', workspaceId: 'workspace', profile: f.profiles.worker, status: 'running',
      createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: savedActive,
      idleSince: savedActive ? null : new Date().toISOString(), completion: null, released: false }));
    f.store.setCredential('revision-run', 'revision-token');
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: 'revision-run' } });
  }
}
function restartState(f: ReturnType<typeof fixture>) {
  return { task: f.current(), runs: f.store.runs(f.taskId), events: f.store.eventsAll(f.taskId),
    credentials: f.store.db.prepare('SELECT * FROM credentials').all() };
}

for (const shape of ['blocked_worker', 'blocked_with_pr', 'retained_worker', 'stopped_revision'] as const) {
  test(`${shape}: a restart offer observes genuine activity and refuses without cancellation`, async () => {
    const f = fixture(); try {
      retainedWorker(f, shape, true);
      f.observations.set('worker-agent', { ...f.observations.get('worker-agent')!, active: true, status: 'running', activeTurnId: 'live-turn' });
      let stops = 0;
      f.adapter.stopAgentTurn = async () => { stops++; };
      const before = restartState(f);
      for (const fresh of [false, true]) {
        const view = f.next().verbs.find(verb => verb.verb === 'restart')!;
        assert.equal(view.available, true);
        assert.match(view.note!, /freshly observes retained worker/);
        await assert.rejects(f.control({ fresh }), /retained worker is active.*route now/);
        assert.deepEqual(restartState(f), before);
      }
      assert.equal(stops, 0);
    } finally { await f.close(); }
  });

  test(`${shape}: a stale saved active flag permits recovery after fresh idle proof`, async () => {
    const f = fixture(); try {
      retainedWorker(f, shape, true);
      assert.equal(f.next().verbs.find(verb => verb.verb === 'restart')!.available, true);
      const before = f.current();
      const result = await f.control({ instruction: 'Continue the approved task' });
      assert.equal(result.phase, 'changes_requested');
      for (const key of ['agentId', 'runId', 'workspaceId', 'branch', 'prHead', 'prUrl', 'planningBase', 'handoffText'] as const)
        assert.deepEqual(result[key], before[key], key);
      assert.equal(result.resolution.pendingWorkerInstruction, 'Continue the approved task');
      assert.equal(ownerControlCount(f), 1);
      if (shape === 'stopped_revision') assert.equal(f.store.run('revision-run')!.released, true);
    } finally { await f.close(); }
  });
}

for (const timeline of ['unavailable', 'gap', 'interrupted tool'] as const) {
  for (const status of ['idle', 'error'] as const) {
    for (const fresh of [false, true]) {
      test(`ordinary worker restart recovers ${status} with ${timeline} timeline (fresh=${fresh})`, async () => {
        const f = fixture(); try {
          retainedWorker(f, 'blocked_worker', false);
          const alternate = profile('worker-alt', 'test/worker-alt', ['worker']);
          if (status === 'error') {
            f.engine.profiles = [f.profiles.worker, f.profiles.reviewer, f.profiles.coord, alternate];
            f.store.setMeta('pool', [
              { profileId: f.profiles.worker.id, enabled: true, group: f.profiles.worker.id, roles: ['worker'], weight: 1, scopes: ['general'] },
              { profileId: alternate.id, enabled: true, group: alternate.id, roles: ['worker'], weight: 1, scopes: ['general'] },
            ]);
          }
          f.store.update(f.taskId, { lastAgentStatus: status });
          f.observations.set('worker-agent', { ...f.observations.get('worker-agent')!, status,
            ...(status === 'error' ? { error: 'Connection error' } : {}) });
          let timelineReads = 0, observations = 0;
          f.adapter.agentTimelinePage = async () => {
            timelineReads++;
            if (timeline === 'unavailable') throw new Error('Timeline unavailable');
            if (timeline === 'gap') return toolTimelinePage([], { gap: true });
            return toolTimelinePage([{ timestamp: new Date().toISOString(), turnId: 'interrupted-turn',
              item: { type: 'tool_call', callId: 'interrupted-tool', status: 'running', name: 'Bash',
                detail: { type: 'shell', command: 'interrupted command' } } }]);
          };
          f.adapter.observe = async id => { observations++; return f.observations.get(id)!; };
          const view = f.next().verbs.find(verb => verb.verb === 'restart')!;
          assert.equal(view.available, true);
          const before = f.current();
          const result = await f.control({ ...view.args, fresh, instruction: 'Continue the approved task' });
          assert.equal(result.phase, 'changes_requested');
          assert.equal(result.resolution.pendingWorkerInstruction, 'Continue the approved task');
          assert.equal(result.replacementProfile, null);
          if (status === 'error') {
            await f.engine.wake();
            const replaced = f.current();
            assert.equal(replaced.profile?.id, f.profiles.worker.id, 'a connection error does not exclude the worker profile');
            assert.equal(replaced.retiredWorkers.length, 1);
            assert.equal(replaced.agentId === 'worker-agent', false);
            assert.equal(f.store.runs(f.taskId).some(run => run.role === 'recovery'), false, 'replacement does not open a recovery run');
          } else {
            // A healthy idle worker continues; only a fresh request with no failure is refused.
            assert.equal(result.failoverReason, '');
            if (fresh) assert.match(f.events('worker_replacement_refused').at(-1)!.detail, /^fresh_without_cause_or_relay:/);
            assert.equal(result.agentId, 'worker-agent');
          }
          for (const key of ['agentId', 'runId', 'workspaceId', 'branch', 'planningBase', 'handoffText'] as const)
            assert.deepEqual(result[key], before[key], key);
          assert.ok(observations > 0, 'the restart still requires fresh runtime observation');
          assert.equal(timelineReads, 0, 'ordinary restart does not require a tool-history proof');
          assert.equal(ownerControlCount(f), 1);
        } finally { await f.close(); }
      });
    }
  }
}

for (const [label, change, refusal] of [
  ['new activity', { active: true, status: 'running' }, /active.*route now/],
  ['turn ID despite idle status', { activeTurnId: 'live-turn' }, /active.*route now/],
  ['permission', { permissions: true }, /permission request/],
  ['unreadable status', { status: 'unknown' }, /not proven idle/],
  ['workspace changed', { workspaceId: 'another-workspace' }, /workspace identity changed/],
  ['agent changed', { id: 'another-agent' }, /agent or workspace identity changed/],
] as const) {
  test(`worker restart refuses ${label} after next without mutation`, async () => {
    const f = fixture(); try {
      retainedWorker(f, 'stopped_revision', false);
      // Running/unreleased is not evidence of an active turn.
      const view = f.next().verbs.find(verb => verb.verb === 'restart')!;
      assert.equal(view.available, true);
      const before = restartState(f);
      f.observations.set('worker-agent', { ...f.observations.get('worker-agent')!, ...change });
      await assert.rejects(f.control({ ...view.args, reason: 'Continue' }), refusal);
      assert.deepEqual(restartState(f), before);
    } finally { await f.close(); }
  });
}

test('saved revision and worker activity both leave the fresh restart observation available', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'stopped_revision', true);
    f.store.update(f.taskId, { lastObservedAt: '2026-01-01T00:00:00.000Z' });
    f.store.putRun({ ...f.store.run('revision-run')!, released: true, active: false, lastObservedAt: '2026-01-02T00:00:00.000Z' });
    assert.equal(f.next().verbs.find(verb => verb.verb === 'restart')!.available, true);
    f.store.update(f.taskId, { lastObservedAt: '2026-01-03T00:00:00.000Z' });
    assert.equal(f.next().verbs.find(verb => verb.verb === 'restart')!.available, true);
    const result = await f.control();
    assert.equal(result.phase, 'changes_requested');
    assert.equal(result.agentId, 'worker-agent');
    assert.equal(f.store.run('revision-run')!.released, true);
  } finally { await f.close(); }
});

test('unobservable worker restart is a definite refused operation with no lifecycle mutation', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'retained_worker', false);
    f.adapter.observe = async () => { throw new Error('Transport timeout'); };
    const before = restartState(f);
    const input = taskControlInputSchema.parse({ taskId: f.taskId, version: f.current().version, action: 'restart', reason: 'Continue' });
    const accepted = await f.engine.startOperation({ key: 'unobservable-restart', kind: 'task_control', taskId: f.taskId,
      expectedVersion: input.version, payload: { type: 'task_control', control: input } });
    assert.ok('accepted' in accepted);
    const operation = await f.engine.awaitOperation(accepted.operation.id);
    assert.equal(operation.state, 'failed');
    assert.match(operation.diagnostic, /cannot be observed \(Error: Transport timeout\).*No continuation was sent/);
    assert.equal(operation.effect?.status, 'reconciled');
    assert.deepEqual(restartState(f), before);
  } finally { await f.close(); }
});

test('a refused restart names the host observation error and its kind', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'retained_worker', false);
    // The exact failure a long T3 thread produced: a read that outlived the bound.
    f.adapter.observe = async () => {
      throw Object.assign(new Error('T3Code timeout: orchestration.subscribeThread'),
        { name: 'T3RpcError', code: 'timeout', method: 'orchestration.subscribeThread' });
    };
    const before = restartState(f);
    const input = taskControlInputSchema.parse({ taskId: f.taskId, version: f.current().version, action: 'restart', reason: 'Continue' });
    const accepted = await f.engine.startOperation({ key: 'timeout-restart', kind: 'task_control', taskId: f.taskId,
      expectedVersion: input.version, payload: { type: 'task_control', control: input } });
    assert.ok('accepted' in accepted);
    const operation = await f.engine.awaitOperation(accepted.operation.id);
    assert.equal(operation.state, 'failed');
    assert.match(operation.diagnostic,
      /The retained worker cannot be observed \(T3RpcError timeout orchestration\.subscribeThread: T3Code timeout: orchestration\.subscribeThread\); restore observation before restarting\. No continuation was sent/);
    assert.deepEqual(restartState(f), before);
  } finally { await f.close(); }
});

test('a Paseo observation refusal keeps the adapter message', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'retained_worker', false);
    // The live Paseo host answers an identity it does not hold exactly this way;
    // the refusal shows its words, as it does for every host.
    f.adapter.observe = async () => { throw new Error('Agent was not found'); };
    const before = restartState(f);
    const input = taskControlInputSchema.parse({ taskId: f.taskId, version: f.current().version, action: 'restart', reason: 'Continue' });
    const accepted = await f.engine.startOperation({ key: 'paseo-refusal-restart', kind: 'task_control', taskId: f.taskId,
      expectedVersion: input.version, payload: { type: 'task_control', control: input } });
    assert.ok('accepted' in accepted);
    const operation = await f.engine.awaitOperation(accepted.operation.id);
    assert.equal(operation.state, 'failed');
    assert.match(operation.diagnostic, /cannot be observed \(Error: Agent was not found\); restore observation before restarting\. No continuation was sent/);
    assert.deepEqual(restartState(f), before);
    // A system error code is kept as the error's kind, not filtered out.
    f.adapter.observe = async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }); };
    const next = f.current();
    const retry = await f.engine.startOperation({ key: 'paseo-code-restart', kind: 'task_control', taskId: f.taskId,
      expectedVersion: next.version, payload: { type: 'task_control', control: taskControlInputSchema.parse({
        taskId: f.taskId, version: next.version, action: 'restart', reason: 'Continue' }) } });
    assert.ok('accepted' in retry);
    const refused = await f.engine.awaitOperation(retry.operation.id);
    assert.equal(refused.state, 'failed');
    assert.match(refused.diagnostic, /cannot be observed \(Error ECONNREFUSED: connect ECONNREFUSED 127\.0\.0\.1:1\)/);
    // A numeric code and a non-dotted method are present fields too, so the
    // refusal keeps them rather than filtering on their shape.
    f.adapter.observe = async () => { throw Object.assign(new Error('Action refused'), { code: 500, method: 'paseo/observe' }); };
    const last = f.current();
    const third = await f.engine.startOperation({ key: 'paseo-shape-restart', kind: 'task_control', taskId: f.taskId,
      expectedVersion: last.version, payload: { type: 'task_control', control: taskControlInputSchema.parse({
        taskId: f.taskId, version: last.version, action: 'restart', reason: 'Continue' }) } });
    assert.ok('accepted' in third);
    const shaped = await f.engine.awaitOperation(third.operation.id);
    assert.equal(shaped.state, 'failed');
    assert.match(shaped.diagnostic, /cannot be observed \(Error 500 paseo\/observe: Action refused\)/);
  } finally { await f.close(); }
});

test('a refused restart keeps an adapter-authored method and remote tag', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'retained_worker', false);
    // The shape T3RpcError produces when the nightly fails a read with a typed tag:
    // its kind keeps the code and method, and its message keeps the tag.
    f.adapter.observe = async () => {
      throw Object.assign(new Error('T3Code remote: orchestration.subscribeThread (OrchestrationV2GetThreadProjectionError)'),
        { name: 'T3RpcError', code: 'remote', method: 'orchestration.subscribeThread', remoteTag: 'OrchestrationV2GetThreadProjectionError' });
    };
    const before = restartState(f);
    const input = taskControlInputSchema.parse({ taskId: f.taskId, version: f.current().version, action: 'restart', reason: 'Continue' });
    const accepted = await f.engine.startOperation({ key: 'tagged-restart', kind: 'task_control', taskId: f.taskId,
      expectedVersion: input.version, payload: { type: 'task_control', control: input } });
    assert.ok('accepted' in accepted);
    const operation = await f.engine.awaitOperation(accepted.operation.id);
    assert.equal(operation.state, 'failed');
    assert.match(operation.diagnostic, /cannot be observed \(T3RpcError remote orchestration\.subscribeThread: T3Code remote: orchestration\.subscribeThread \(OrchestrationV2GetThreadProjectionError\)\)/);
    assert.deepEqual(restartState(f), before);
  } finally { await f.close(); }
});

test('a finished run fenced by an unreadable observation names the host error', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'retained_worker', false);
    // A finished support run has to be observed before the restart settles it; its
    // unreadable observation must say what failed, not just that it did.
    f.store.putRun(runSchema.parse({ id: 'fenced-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base,
      agentId: 'review-agent', workspaceId: 'workspace', profile: f.profiles.reviewer, status: 'finished',
      createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, released: false,
      completion: { taskId: f.taskId, runId: 'fenced-run', eventId: 'fenced-ready', status: 'ready_for_review', summary: 'Reviewed', head } }));
    f.adapter.observe = async () => {
      throw Object.assign(new Error('T3Code timeout: orchestration.subscribeThread'),
        { name: 'T3RpcError', code: 'timeout', method: 'orchestration.subscribeThread' });
    };
    const finished = await f.engine.collectVerbFinishedRuns(f.taskId, () => false);
    const fence = finished.fenced.find(entry => entry.run.id === 'fenced-run');
    assert.ok(fence, JSON.stringify(finished.fenced.map(entry => entry.why)));
    assert.equal(fence!.why, 'its agent is unobservable (T3RpcError timeout orchestration.subscribeThread: T3Code timeout: orchestration.subscribeThread)');
    assert.match(f.engine.verbRunFenceRefusal(fence!), /still owns this task: its agent is unobservable \(T3RpcError timeout orchestration\.subscribeThread/);
  } finally { await f.close(); }
});

for (const change of ['task version', 'run binding', 'competing run', 'delivery'] as const) {
  test(`worker restart rechecks ${change} after the observation await`, async () => {
    const f = fixture(); try {
      retainedWorker(f, 'stopped_revision', false);
      let afterChange: ReturnType<typeof restartState>;
      f.adapter.observe = async id => {
        const run = f.store.run('revision-run')!;
        if (change === 'task version') f.store.update(f.taskId, { reason: 'New owner ruling' });
        if (change === 'run binding') f.store.putRun({ ...run, agentId: 'replaced-worker' });
        if (change === 'competing run') f.store.putRun({ ...run, id: 'competing-revision' });
        if (change === 'delivery') f.store.putRun({ ...run, status: 'uncertain' });
        afterChange = restartState(f);
        return f.observations.get(id)!;
      };
      await assert.rejects(f.control(), /changed during restart verification/);
      assert.deepEqual(restartState(f), afterChange!, 'only the concurrent change survives');
    } finally { await f.close(); }
  });
}

test('a worker restart applies while Queue is paused; the revision waits for unpause (round 4)', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'stopped_revision', false);
    f.adapter.observe = async id => { f.store.setMeta('paused', true); return f.observations.get(id)!; };
    const restarted = await f.control();
    assert.equal(restarted.phase, 'changes_requested', 'the owner restart recorded its state while paused');
    assert.equal(f.store.getMeta('paused'), true);
  } finally { await f.close(); }
});

test('uncertain revision delivery is refused in next and control without releasing its identity', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'stopped_revision', false);
    f.store.putRun({ ...f.store.run('revision-run')!, status: 'uncertain' });
    const before = restartState(f);
    const view = f.next().verbs.find(verb => verb.verb === 'restart')!;
    assert.equal(view.available, false);
    assert.match(view.refusal!, /uncertain delivery/);
    await assert.rejects(f.control(), /uncertain delivery/);
    assert.deepEqual(restartState(f), before);
  } finally { await f.close(); }
});

test('absent worker creation: restart replays the retained creation under the same run', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'needs_attention', reason: ABSENT_WORKER_REASON, workspaceIntent: true, agentIntent: true,
      agentId: null, runId: 'absent-run', workspaceId: 'workspace', directory: '/worktree', profile: f.profiles.worker,
      resolution: { ...f.current().resolution, attention: true },
    });
    const task = await f.control({ instruction: 'Create the worker once and continue' });
    assert.equal(task.phase, 'dispatching');
    assert.equal(task.agentIntent, false);
    assert.equal(task.runId, 'absent-run', 'the retained run ID is kept');
    assert.equal(task.restartRunId, 'absent-run', 'the launcher reuses the same run for the retried creation');
    assert.equal(ownerControlCount(f), 1);
  } finally { await f.close(); }
});

for (const fresh of [false, true]) {
  test(`stopped revision with a missing callback: restart releases it and continues the retained worker (fresh=${fresh})`, async () => {
    const f = fixture(); try {
      f.store.update(f.taskId, {
        phase: 'changes_requested', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
        profile: f.profiles.worker, workerModel: f.profiles.worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      });
      const run = runSchema.parse({
        id: 'revision-run', taskId: f.taskId, role: 'revision', generation: 1, head, base, agentId: 'worker-agent', workspaceId: 'workspace',
        profile: f.profiles.worker, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
      });
      f.store.putRun(run);
      f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id, attention: true } });

      const task = await f.control({ fresh, instruction: 'Finish the stalled revision' });
      assert.equal(f.store.run(run.id)!.released, true);
      assert.equal(f.store.run(run.id)!.status, 'superseded');
      assert.equal(task.resolution.currentRunId, null);
      assert.equal(ownerControlCount(f), 1);
      if (fresh) {
        // Spec 058 task 577: a stalled revision is an unfinished continuation,
        // not a failure, so the fresh restart continues the retained worker.
        assert.equal(task.replacementProfile, null);
        assert.match(f.events('worker_replacement_refused').at(-1)!.detail, /^fresh_without_cause_or_relay:/);
      }
      await advanceViaWorkerRestart(f, false, 7);
    } finally { await f.close(); }
  });
}

test('a stopped revision restart settles a finished idle recovery run (#3569)', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'changes_requested', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
      profile: f.profiles.worker, workerModel: f.profiles.worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
    });
    const run = runSchema.parse({
      id: 'revision-run', taskId: f.taskId, role: 'revision', generation: 1, head, base, agentId: 'worker-agent', workspaceId: 'workspace',
      profile: f.profiles.worker, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
    });
    f.store.putRun(run);
    unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId }, false);
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id, attention: true } });

    const task = await f.control({ instruction: 'Finish the stalled revision' });
    // The finished recovery run settled inside the restart's own transaction.
    const settled = f.store.run('recovery-run')!;
    assert.equal(settled.released, true);
    assert.equal(settled.status, 'finished');
    assert.equal(f.events('run_released_from_recorded_completion').length, 1);
    assert.equal(f.events('owner_fence_settled').length, 1);
    assert.equal(f.store.run(run.id)!.released, true, 'the restart superseded the stopped revision');
    assert.equal(task.resolution.recovery, null, 'the restart closed the settled episode');
    assert.equal(ownerControlCount(f), 1);
    await advanceViaWorkerRestart(f, false, 7);
  } finally { await f.close(); }
});

test('a stopped revision restart with a competing revision changes nothing', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'changes_requested', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
      profile: f.profiles.worker, workerModel: f.profiles.worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
    });
    // A second unresolved revision must refuse before any supersession.
    const runA = runSchema.parse({
      id: 'revision-run-a', taskId: f.taskId, role: 'revision', generation: 1, head, base, agentId: 'worker-agent', workspaceId: 'workspace',
      profile: f.profiles.worker, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
    });
    const runB = runSchema.parse({ ...runA, id: 'revision-run-b' });
    f.store.putRun(runA);
    f.store.putRun(runB);
    unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId }, false);
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: runB.id, attention: true } });

    const before = f.current();
    await assert.rejects(f.control({ instruction: 'Finish the stalled revision' }), /still owns this task|Another revision/);
    assert.deepEqual(f.current(), before, 'the refused restart left the task unchanged');
    assert.equal(f.store.run('recovery-run')!.released, false);
    assert.equal(f.store.run('revision-run-b')!.released, false);
    assert.equal(f.events('owner_fence_settled').length, 0);
    assert.equal(ownerControlCount(f), 0);
  } finally { await f.close(); }
});

for (const [label, overrides] of [['uncertain resolution restart', { phase: 'awaiting_review' }], ['stopped revision restart', { phase: 'changes_requested' }]] as const) {
  test(`a ${label} refuses a finished recovery run whose agent is active instead of resolving its episode`, async () => {
    const f = fixture(); try {
      if (overrides.phase === 'awaiting_review') {
        f.store.update(f.taskId, {
          phase: 'awaiting_review', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
          profile: null,
          prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
          completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-11', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
        });
        const run = runSchema.parse({
          id: 'uncertain-review-3', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: null, workspaceId: 'workspace',
          profile: f.profiles.reviewer, status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null,
          active: null, idleSince: null, completion: null, released: false,
        });
        f.store.putRun(run);
        unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId }, false);
        f.observations.set('coord-agent', { id: 'coord-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
        f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id } });
      } else {
        f.store.update(f.taskId, {
          phase: 'changes_requested', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
          profile: f.profiles.worker, workerModel: f.profiles.worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
        });
        const run = runSchema.parse({
          id: 'revision-run', taskId: f.taskId, role: 'revision', generation: 1, head, base, agentId: 'worker-agent', workspaceId: 'workspace',
          profile: f.profiles.worker, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
        });
        f.store.putRun(run);
        unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId }, false);
        f.observations.set('coord-agent', { id: 'coord-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
        f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id, attention: true } });
      }

      const before = f.current();
      // A recorded report is the coordinator run's result: the restart settles the
      // episode and its run from that report instead of fencing on live activity,
      // and the turn delivering the report is not cancelled.
      const restarted = await f.control({ instruction: 'Continue the task' });
      assert.notEqual(restarted.version, before.version, 'the restart applied');
      assert.equal(f.store.run('recovery-run')!.released, true, 'the reported run settled');
      assert.equal(f.events('owner_stop_sent').length, 0, 'the reporting turn was never cancelled');
      assert.equal(f.events('owner_fence_settled').length, 1);
      assert.equal(ownerControlCount(f), 1);
    } finally { await f.close(); }
  });
}

test('a stopped reviewer restart refuses a finished recovery run whose agent is active instead of resolving its episode', async () => {
  const f = fixture(); try {
    reviewingTask(f, 'checkpoint-run-8', 'ckpt-8');
    unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId }, false);
    f.observations.set('coord-agent', { id: 'coord-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });

    const before = f.current();
    const restarted = await f.control({ fresh: true, instruction: 'Start a fresh reviewer' });
    assert.notEqual(restarted.version, before.version, 'the restart applied');
    assert.equal(f.store.run('recovery-run')!.released, true, 'the reported run settled from its report');
    assert.equal(f.events('owner_stop_sent').length, 0, 'the reporting turn was never cancelled');
    assert.equal(f.events('owner_fence_settled').length, 1);
    assert.equal(ownerControlCount(f), 1);
  } finally { await f.close(); }
});

for (const fresh of [false, true]) {
  test(`stopped reviewer: restart honours the selected agent mode (fresh=${fresh})`, async () => {
    const f = fixture(); try {
      f.store.update(f.taskId, {
        phase: 'awaiting_review', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
        profile: f.profiles.worker, workerModel: f.profiles.worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
        completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-3', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
      });
      const run = runSchema.parse({
        id: 'review-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
        retainedRounds: 3, profile: f.profiles.reviewer, status: 'superseded', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null, released: true,
      });
      f.store.putRun(run);
      f.store.update(f.taskId, { resolution: { ...f.current().resolution, reviewerAgentId: 'review-agent', reviewerProfile: f.profiles.reviewer } });

      const task = await f.control({ fresh, instruction: 'Review the current head' });
      assert.equal(task.phase, 'awaiting_review');
      assert.equal(task.resolution.reviewerAgentId, fresh ? null : 'review-agent');

      assert.equal(ownerControlCount(f), 1);
      // The fresh reviewer's authenticated verdict advances the task.
      await advanceViaFreshReview(f);
      const review = f.createdRuns.find(item => item.role === 'reviewer')!;
      assert.equal(fresh ? review.agentId !== 'review-agent' : review.agentId === 'review-agent', true);
      assert.equal(ownerControlCount(f), 1);
    } finally { await f.close(); }
  });
}

test('absent reviewer creation: restart releases the uncertain run and resumes review', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-4', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    });
    const run = runSchema.parse({
      id: 'absent-review-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: null, workspaceId: 'workspace',
      profile: f.profiles.reviewer, status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false,
    });
    f.store.putRun(run);
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id, reviewerAgentId: null, reviewerProfile: f.profiles.reviewer } });

    const task = await f.control();
    assert.equal(f.store.run(run.id)!.released, false, 'the run is restarted, not released');
    assert.equal(f.store.run(run.id)!.agentId, 'agent-absent-review-run');
    assert.equal(task.resolution.currentRunId, run.id, 'the same run ID is kept');
    assert.equal(task.resolution.reviewerAgentId, 'agent-absent-review-run');
    assert.equal(ownerControlCount(f), 1);
    // An authenticated reviewer result on the recreated run advances the task.
    const token = f.createdRunTokens.get(run.id)!;
    await f.engine.complete({ eventId: randomUUID(), taskId: f.taskId, runId: run.id, status: 'changes_required', summary: 'The author must address the finding', head, reviewResponsibility: 'author', reviewText: 'The retry path is missing an idempotency guard; please add one.' }, token);
    assert.equal(f.store.run(run.id)!.completion?.status, 'changes_required', 'the authenticated result is recorded on the recreated run');
    assert.ok(f.events('run_completion').length >= 1, 'the authenticated result wrote its completion event');
    await f.engine.wake();
    assert.equal(f.current().phase, 'changes_requested', 'the authenticated result advanced the task');
  } finally { await f.close(); }
});

test('uncertain reviewer creation: restart binds the one exact existing agent in place on the same run', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-bound', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    });
    const run = runSchema.parse({
      id: 'absent-bound-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: null, workspaceId: 'workspace',
      profile: f.profiles.reviewer, status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false,
    });
    f.store.putRun(run);
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id, reviewerAgentId: null, reviewerProfile: f.profiles.reviewer, attention: true } });
    (f.adapter as unknown as { findRunAgents: () => Promise<{ id: string; workspaceId: string }[]> }).findRunAgents = async () => [{ id: 'found-reviewer-agent', workspaceId: 'workspace' }];

    const task = await f.control();
    assert.equal(f.store.run(run.id)!.agentId, 'found-reviewer-agent', 'the found agent is bound on the same run');
    assert.equal(f.store.run(run.id)!.released, false, 'the run is never superseded');
    assert.equal(task.resolution.currentRunId, run.id, 'no second run is created');
    assert.equal(task.resolution.reviewerAgentId, 'found-reviewer-agent');
    assert.equal(ownerControlCount(f), 1);
  } finally { await f.close(); }
});

test('uncertain reviewer creation: a single match outside the retained workspace refuses without creating a second agent', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-misplaced', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    });
    const run = runSchema.parse({
      id: 'absent-misplaced-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: null, workspaceId: 'workspace',
      profile: f.profiles.reviewer, status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false,
    });
    f.store.putRun(run);
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id, reviewerAgentId: null, reviewerProfile: f.profiles.reviewer, attention: true } });
    (f.adapter as unknown as { findRunAgents: () => Promise<{ id: string; workspaceId: string | null }[]> }).findRunAgents = async () => [{ id: 'misplaced-reviewer-agent', workspaceId: 'other-workspace' }];

    await assert.rejects(f.control(), /outside the retained workspace/);
    assert.equal(f.store.run(run.id)!.agentId, null, 'the misplaced agent is not bound');
    assert.equal(f.store.run(run.id)!.released, false, 'the run is not superseded');
    assert.equal(f.createdRuns.length, 0, 'no second agent is created for the same run');
    assert.equal(ownerControlCount(f), 0, 'a refused restart writes no owner_control event');
  } finally { await f.close(); }
});

for (const fresh of [false, true]) {
  test(`checkpointed reviewer with an escalated incident on a superseded run: restart ${fresh ? 'starts a fresh reviewer' : 'continues the same agent'}`, async () => {
    const f = fixture(); try {
      f.store.update(f.taskId, {
        phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
        agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
        prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
        completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-5', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
      });
      const run = runSchema.parse({
        id: 'checkpoint-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
        profile: f.profiles.reviewer, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
      });
      f.store.putRun(run);
      // The #553 shape: the checkpoint's own incident and recovery are escalated
      // while a superseded reviewer run still owns the task.
      f.store.update(f.taskId, {
        resolution: {
          ...f.current().resolution, currentRunId: run.id, reviewerAgentId: 'review-agent', reviewerProfile: f.profiles.reviewer, attention: true,
          incident: { id: 'inc-1', role: 'reviewer', runId: 'superseded-run', cause: 'missing_callback', action: '', attempt: 0, detail: 'superseded run stalled', status: 'escalated', fingerprint: 'inc-1', turnId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          recovery: { id: 'rec-1', key: 'k', generation: 1, runId: null, agentId: null, status: 'escalated', summary: 'superseded run stalled', idleSince: null, incidentId: 'inc-1' },
        },
      });
      // The authenticated checkpoint and its receipt (Spec 044 record shape).
      const ordinal = 1, at = new Date().toISOString();
      const checkpoint = { covered: ['a'], remaining: ['b'] };
      const callback = { eventId: 'ckpt-event', taskId: f.taskId, runId: run.id, status: 'review_in_progress', summary: 'Reading budget exhausted', head, checkpoint };
      const callbackDigest = digest(JSON.stringify(callback)), checkpointDigest = digest(JSON.stringify(checkpoint));
      const record = { ordinal, checkpoint, head, at, runId: run.id, path: reviewCheckpointPathFor(f.store, f.taskId, run.id, ordinal),
        eventId: 'ckpt-event', callbackDigest, checkpointDigest };
      const response = { accepted: true, eventId: 'ckpt-event', checkpoint: { ordinal, budget: REVIEW_CONTINUATION_LIMIT, continued: false, attention: REVIEW_AUTHORIZATION_REQUIRED, checkpointDigest } };
      f.store.setCredential(run.id, 'token');
      f.store.transaction(() => {
        writeReviewCheckpoint(f.store, f.taskId, record);
        f.store.putRun({ ...f.store.run(run.id)!, reviewCheckpoints: [record] });
        f.store.update(f.taskId, { reason: REVIEW_AUTHORIZATION_REQUIRED });
        f.store.event(f.taskId, 'review_checkpoint', `${ordinal}/${REVIEW_CONTINUATION_LIMIT} ckpt-event run ${run.id} at ${head}`);
        f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run('ckpt-event', f.taskId, run.id, callbackDigest, JSON.stringify(response));
      });

      const task = await f.control({ fresh, instruction: 'Finish the remaining reading and report' });
      assert.equal(task.resolution.incident?.status, 'resolved');
      assert.equal(task.resolution.recovery?.status, 'resolved');
      assert.equal(task.resolution.attention, false);
      assert.equal(f.events('owner_fence_settled').length, 1);
      assert.equal(ownerControlCount(f), 1);
      if (fresh) {
        assert.equal(f.store.run(run.id)!.released, true);
        assert.ok(f.store.run(run.id)!.replacedAt);
        assert.equal(f.store.run(run.id)!.status, 'superseded');
        assert.equal(f.store.run(run.id)!.completion, null, 'restart does not invent a verdict');
        assert.equal(task.phase, 'awaiting_review');
        assert.equal(task.resolution.currentRunId, null);
        await advanceViaFreshReview(f);
        const replacement = f.createdRuns.find(item => item.role === 'reviewer')!;
        assert.notEqual(replacement.id, run.id);
        assert.notEqual(f.store.run(replacement.id)!.agentId, run.agentId);
        assert.equal(replacement.head, head);
        assert.equal(replacement.workspaceId, run.workspaceId);
        assert.equal(f.current().prUrl, task.prUrl);
        assert.equal(ownerControlCount(f), 1);
      } else {
        // The same-head reviewer's authenticated result advances the task.
        await f.engine.complete({ eventId: randomUUID(), taskId: f.taskId, runId: run.id, status: 'changes_required', summary: 'One finding', head, reviewResponsibility: 'author', reviewText: 'Address the retry guard.' }, 'token');
        await f.engine.wake();
        assert.equal(f.current().phase, 'changes_requested', 'the authenticated result advanced the task');
      }
    } finally { await f.close(); }
  });
}

test('checkpointed reviewer: a fresh restart supersedes the lease without a verdict', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-6', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    });
    const run = runSchema.parse({
      id: 'checkpoint-run-2', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
      profile: f.profiles.reviewer, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
      reviewCheckpoints: [{ ordinal: 1, checkpoint: { covered: ['a'], remaining: ['b'] }, head, at: new Date().toISOString(), runId: 'checkpoint-run-2', path: '/tmp/ignored' }],
    });
    f.store.putRun(run);
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id, reviewerAgentId: 'review-agent', reviewerProfile: f.profiles.reviewer } });

    const task = await f.control({ fresh: true });
    assert.equal(f.store.run(run.id)!.released, true, 'archived replacement releases ownership');
    assert.ok(f.store.run(run.id)!.replacedAt);
    assert.equal(f.store.run(run.id)!.status, 'superseded');
    assert.equal(task.phase, 'awaiting_review');
    assert.equal(task.resolution.currentRunId, null);
    assert.equal(ownerControlCount(f), 1);
    // The fresh reviewer's authenticated verdict advances the task.
    await advanceViaFreshReview(f);
  } finally { await f.close(); }
});

/** The #3569 shape around the reviewer checkpoint: a recovery run whose accepted
  * `recovered` report was recorded but never released, its episode still running. */
function unrecoveredRecovery(f: ReturnType<typeof fixture>, completion: Record<string, unknown> | null, attention = true) {
  const run = runSchema.parse({
    id: 'recovery-run', taskId: f.taskId, role: 'recovery', generation: 1, head, base, agentId: 'coord-agent',
    workspaceId: 'workspace', profile: null, status: 'running', createdAt: new Date().toISOString(),
    lastObservedAt: null, active: true, idleSince: null,
    completion: completion as never, released: false,
  });
  f.store.putRun(run);
  f.store.update(f.taskId, {
    coordinatorAgentId: 'coord-agent',
    resolution: {
      ...f.current().resolution, attention, recoveryActive: true,
      recovery: { id: 'rec-9', key: 'k9', generation: 1, runId: run.id, agentId: 'coord-agent', status: 'running', summary: 'Coordinator recovery running', idleSince: null, incidentId: null },
    },
  });
  return run;
}

const recoveredCompletion = { eventId: 'rec-9', taskId: '', runId: 'recovery-run', status: 'recovered', summary: 'Resume the reviewer thread', recoveryAction: 'resume_worker' };

/** A reviewing task with one authenticated reviewer checkpoint awaiting its continuation. */
function checkpointReviewTask(f: ReturnType<typeof fixture>, runId: string, eventId: string) {
  const run = f.store.run(runId)!;
  const ordinal = 1;
  const checkpoint = { covered: ['a'], remaining: ['b'] };
  const callback = { eventId, taskId: f.taskId, runId: run.id, status: 'review_in_progress', summary: 'Reading budget exhausted', head, checkpoint };
  const callbackDigest = digest(JSON.stringify(callback)), checkpointDigest = digest(JSON.stringify(checkpoint));
  const record = { ordinal, checkpoint, head, at: new Date().toISOString(), runId: run.id, path: reviewCheckpointPathFor(f.store, f.taskId, run.id, ordinal),
    eventId, callbackDigest, checkpointDigest };
  const response = { accepted: true, eventId, checkpoint: { ordinal, budget: REVIEW_CONTINUATION_LIMIT, continued: false, attention: REVIEW_AUTHORIZATION_REQUIRED, checkpointDigest } };
  f.store.setCredential(run.id, 'token');
  f.store.transaction(() => {
    writeReviewCheckpoint(f.store, f.taskId, record);
    f.store.putRun({ ...run, reviewCheckpoints: [record] });
    f.store.update(f.taskId, { reason: REVIEW_AUTHORIZATION_REQUIRED });
    f.store.event(f.taskId, 'review_checkpoint', `${ordinal}/${REVIEW_CONTINUATION_LIMIT} ${eventId} run ${run.id} at ${head}`);
    f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(eventId, f.taskId, run.id, callbackDigest, JSON.stringify(response));
  });
  f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id, reviewerAgentId: run.agentId, reviewerProfile: run.profile } });
  return run;
}

function reviewingTask(f: ReturnType<typeof fixture>, runId: string, eventId: string) {
  f.store.update(f.taskId, {
    phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
    prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-7', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
  });
  f.store.putRun(runSchema.parse({
    id: runId, taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
    profile: f.profiles.reviewer, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
  }));
  return checkpointReviewTask(f, runId, eventId);
}

test('a finished recovery run whose agent is idle no longer fences the reviewer continuation (#3569)', async () => {
  const f = fixture(); try {
    const run = reviewingTask(f, 'checkpoint-run-3', 'ckpt-3');
    unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId });

    const task = await f.control({ instruction: 'Finish the remaining reading and report' });
    // The finished recovery run settled through the reconciliation release path:
    // released, one event naming it, and its thread left to the normal archive.
    const settled = f.store.run('recovery-run')!;
    assert.equal(settled.released, true);
    assert.equal(settled.status, 'finished');
    assert.equal(f.events('run_released_from_recorded_completion').length, 1);
    assert.equal(f.events('run_released_from_recorded_completion')[0].detail, 'recovery recovery-run');
    // The accepted action is recorded as not applied, audibly; the stale retry
    // never executed and the episode no longer owns the task.
    assert.equal(task.resolution.recovery?.status, 'resolved');
    assert.equal(task.resolution.recovery?.action?.status, 'refused');
    assert.match(task.resolution.recovery?.summary ?? '', /Accepted recovery report was not applied/);
    assert.equal(task.resolution.recoveryActive, false);
    assert.equal(task.resolution.attention, false);
    assert.equal(f.events('owner_fence_settled').length, 1);
    assert.equal(ownerControlCount(f), 1);
    // The reviewer continuation itself delivered on the same run.
    await f.engine.complete({ eventId: randomUUID(), taskId: f.taskId, runId: run.id, status: 'changes_required', summary: 'One finding', head, reviewResponsibility: 'author', reviewText: 'Address the retry guard.' }, 'token');
    await f.engine.wake();
    assert.equal(f.current().phase, 'changes_requested', 'the authenticated result advanced the task');
  } finally { await f.close(); }
});

for (const shape of ['no completion', 'active agent'] as const) {
  test(`the reviewer restart settles the episode's own recovery run: ${shape}`, async () => {
    const f = fixture(); try {
      reviewingTask(f, 'checkpoint-run-4', 'ckpt-4');
      unrecoveredRecovery(f, shape === 'no completion' ? null : { ...recoveredCompletion, taskId: f.taskId });
      if (shape === 'active agent')
        f.observations.set('coord-agent', { id: 'coord-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });

      const before = f.current();
      // The transition owns the episode's own run: an idle one settles as
      // superseded, and a live matching turn is cancelled durably before it
      // settles. Either way the reviewer continuation is what the restart does.
      const restarted = await f.control({ instruction: 'Finish the remaining reading and report' });
      assert.notEqual(restarted.version, before.version, 'the restart applied');
      assert.equal(f.store.run('recovery-run')!.released, true, 'the episode run settled with the restart');
      assert.equal(f.events('owner_fence_settled').length, 1);
      assert.equal(ownerControlCount(f), 1);
      // An idle never-reporting run needs no cancellation, and a recorded report
      // is settled from its own result even while its authoring turn still runs.
      assert.equal(f.events('owner_stop_sent').length, 0, 'no coordinator turn needed cancelling');
    } finally { await f.close(); }
  });
}

test('same-reader restart settles a stale reviewer active flag and a stale external-merge record (#3569)', async () => {
  const f = fixture(); try {
    const run = reviewingTask(f, 'checkpoint-run-8', 'ckpt-8');
    unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId });
    // Both records are stale: the reviewer run's stored `active` flag and the
    // external-merge pre-attention snapshot. Observation and settlement decide.
    assert.equal(f.store.run(run.id)!.active, true, 'the fixture stores a stale reviewer active flag');
    f.store.update(f.taskId, { resolution: { ...f.current().resolution,
      externalMergePreAttention: { phase: 'reviewing', reason: 'Stale external-merge check snapshot' } } });

    const task = await f.control({ instruction: 'Finish the remaining reading and report' });
    assert.equal(task.resolution.externalMergePreAttention, null, 'the stale pre-attention record is settled');
    assert.equal(task.resolution.recovery?.status, 'resolved');
    assert.equal(f.store.run('recovery-run')!.released, true);
    assert.equal(ownerControlCount(f), 1);
    // The same-run continuation still delivers and its result advances the task.
    await f.engine.complete({ eventId: randomUUID(), taskId: f.taskId, runId: run.id, status: 'changes_required', summary: 'One finding', head, reviewResponsibility: 'author', reviewText: 'Address the retry guard.' }, 'token');
    await f.engine.wake();
    assert.equal(f.current().phase, 'changes_requested');
  } finally { await f.close(); }
});

test('coordinator restart settles an idle completed reviewer with a stale active flag', async () => {
  const f = fixture(); try {
    const { reviewer } = coordinatorWithReviewerFence(f);
    // The reviewer's stored `active` flag and the idle timestamp are stale; the
    // observation is what settles it.
    f.store.putRun({ ...f.store.run(reviewer.id)!, active: true, idleSince: null });
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });

    const task = await f.control({ role: 'coordinator' });
    assert.equal(task.phase, 'changes_requested');
    assert.equal(f.store.run(reviewer.id)!.released, true, 'the idle completed reviewer settled');
    assert.equal(f.store.run(reviewer.id)!.status, 'finished');
    assert.deepEqual(f.events('run_released_from_recorded_completion').map(event => event.detail), [`reviewer ${reviewer.id}`]);
    assert.equal(ownerControlCount(f), 1);
  } finally { await f.close(); }
});

test('a paused queue defers the authorization-held recovery settlement until the unpause', async () => {
  const f = fixture(); try {
    reviewingTask(f, 'checkpoint-run-6', 'ckpt-6');
    unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId }, false);
    Object.assign(f.adapter as unknown as Record<string, unknown>, { supportsCoordinatorRecovery: true });
    f.store.setMeta('paused', true);
    const versionBeforePass = f.current().version;

    // The pause holds the run: no settlement, no release, episode untouched.
    await f.engine.resolution.recovery.pass();
    const held = f.store.run('recovery-run')!;
    assert.equal(held.released, false);
    assert.equal(held.status, 'running');
    const during = f.current();
    assert.equal(during.resolution.recovery?.status, 'running');
    assert.equal(during.resolution.recovery?.action, undefined);
    assert.equal(f.events('run_released_from_recorded_completion').length, 0);
    assert.equal(during.version, versionBeforePass, 'the paused pass left the task untouched');

    // The unpause lets the next pass settle the same run.
    f.store.setMeta('paused', false);
    await f.engine.resolution.recovery.pass();
    const settled = f.store.run('recovery-run')!;
    assert.equal(settled.released, true);
    assert.equal(f.current().resolution.recovery?.action?.status, 'refused');
    assert.match(f.current().resolution.recovery?.summary ?? '', /Accepted recovery report was not applied/);
    // An awaiting reviewer checkpoint no longer fences coordinators (Tom, 2026-10-18), so the
    // ordinary pass settles the finished run; the outcome above is the same.
    assert.equal(f.store.run('recovery-run')!.status, 'finished');
  } finally { await f.close(); }
});

test('a pause that lands during the observation defers the authorization-held settlement too', async () => {
  const f = fixture(); try {
    reviewingTask(f, 'checkpoint-run-7', 'ckpt-7');
    unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId }, false);
    Object.assign(f.adapter as unknown as Record<string, unknown>, { supportsCoordinatorRecovery: true });
    const versionBeforePass = f.current().version;
    let pauseLanded = false;
    (f.adapter as unknown as { observe: (id: string) => Promise<unknown> }).observe = async (id: string) => {
      if (!pauseLanded) { pauseLanded = true; f.store.setMeta('paused', true); } // the pause lands during the observation
      return { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' };
    };

    await f.engine.resolution.recovery.pass();
    assert.equal(f.store.run('recovery-run')!.released, false);
    assert.equal(f.current().version, versionBeforePass, 'the mid-observation pause left the task untouched');

    f.store.setMeta('paused', false);
    await f.engine.resolution.recovery.pass();
    assert.equal(f.store.run('recovery-run')!.released, true);
    assert.equal(f.current().resolution.recovery?.action?.status, 'refused');
  } finally { await f.close(); }
});

for (const binding of ['coordinator generation', 'coordinator agent', 'coordinator workspace', 'run agent', 'run workspace', 'run generation', 'episode identity', 'episode generation', 'episode agent', 'completion'] as const) {
  test(`authorization-held settlement rejects an idle observation after changing the ${binding}`, async () => {
    const f = fixture(); try {
      reviewingTask(f, 'checkpoint-race', 'ckpt-race');
      const run = unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId }, false);
      const initial = f.current();
      let afterTask = initial, afterRun = run;
      let afterEvents = f.store.eventsAll(f.taskId);
      f.adapter.observe = async id => {
        const task = f.current(), recovery = task.resolution.recovery!;
        switch (binding) {
          case 'coordinator generation': f.store.update(f.taskId, { coordinatorGeneration: task.coordinatorGeneration + 1 }); break;
          case 'coordinator agent': f.store.update(f.taskId, { coordinatorAgentId: 'replacement-coordinator' }); break;
          case 'coordinator workspace': f.store.update(f.taskId, { resolution: { ...task.resolution, coordinatorWorkspaceId: 'replacement-workspace' } }); break;
          case 'run agent': f.store.putRun({ ...run, agentId: 'replacement-coordinator' }); break;
          case 'run workspace': f.store.putRun({ ...run, workspaceId: 'replacement-workspace' }); break;
          case 'run generation': f.store.putRun({ ...run, generation: run.generation + 1 }); break;
          case 'episode identity': f.store.update(f.taskId, { resolution: { ...task.resolution, recovery: { ...recovery, id: 'replacement-episode' } } }); break;
          case 'episode generation': f.store.update(f.taskId, { resolution: { ...task.resolution, recovery: { ...recovery, generation: recovery.generation + 1 } } }); break;
          case 'episode agent': f.store.update(f.taskId, { resolution: { ...task.resolution, recovery: { ...recovery, agentId: 'replacement-coordinator' } } }); break;
          case 'completion': f.store.putRun({ ...run, completion: { ...run.completion!, eventId: 'replacement-report' } }); break;
        }
        afterTask = f.current();
        afterRun = f.store.run(run.id)!;
        afterEvents = f.store.eventsAll(f.taskId);
        return { id, workspaceId: run.workspaceId, status: 'idle', active: false, permissions: false, error: '' };
      };

      assert.equal(await f.engine.resolution.recovery.settleAuthorizationFencedRun(initial), false);
      assert.deepEqual(f.current(), afterTask, 'settlement leaves the changed binding and episode untouched');
      assert.deepEqual(f.store.run(run.id), afterRun, 'the old observation cannot release the run');
      assert.deepEqual(f.store.eventsAll(f.taskId), afterEvents, 'no release or action refusal is recorded');
    } finally { await f.close(); }
  });
}

test('authorization-held settlement requires the assigned coordinator to match before observing', async () => {
  const f = fixture(); try {
    reviewingTask(f, 'checkpoint-binding', 'ckpt-binding');
    unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId }, false);
    f.store.update(f.taskId, { coordinatorAgentId: 'replacement-coordinator' });
    const before = f.current();
    let observations = 0;
    f.adapter.observe = async () => { observations++; throw new Error('mismatched binding must not be observed'); };
    assert.equal(await f.engine.resolution.recovery.settleAuthorizationFencedRun(before), false);
    assert.equal(observations, 0);
    assert.deepEqual(f.current(), before);
    assert.equal(f.store.run('recovery-run')!.released, false);
    assert.equal(f.events('run_released_from_recorded_completion').length, 0);
  } finally { await f.close(); }
});

test('recovery settles a finished accepted run while review authorization holds, then the restart delivers (#3569)', async () => {
  const f = fixture(); try {
    reviewingTask(f, 'checkpoint-run-5', 'ckpt-5');
    // attention stays with the checkpoint hold; the recovery run is the stale lease.
    unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId }, false);
    Object.assign(f.adapter as unknown as Record<string, unknown>, { supportsCoordinatorRecovery: true });

    // The recovery pass skips the authorization-held task except for this
    // settlement: the accepted report is marked not applied and only the
    // recovery run releases; the reviewer checkpoint stays fenced.
    await f.engine.resolution.recovery.pass();
    const settled = f.store.run('recovery-run')!;
    assert.equal(settled.released, true);
    assert.equal(settled.status, 'finished');
    const afterPass = f.current();
    assert.equal(afterPass.resolution.recovery?.status, 'resolved');
    assert.equal(afterPass.resolution.recovery?.action?.status, 'refused');
    assert.match(afterPass.resolution.recovery?.summary ?? '', /Accepted recovery report was not applied/);
    // An awaiting reviewer checkpoint no longer fences coordinators (Tom, 2026-10-18), so the
    // ordinary pass settles the finished run; the outcome above is the same.
    assert.equal(f.store.run('recovery-run')!.status, 'finished');
    assert.equal(afterPass.resolution.attention, false);

    // The owner's restart now delivers the reviewer continuation.
    const task = await f.control({ instruction: 'Finish the remaining reading and report' });
    assert.equal(task.resolution.attention, false);
    assert.equal(ownerControlCount(f), 1);
    const run = f.store.run('checkpoint-run-5')!;
    await f.engine.complete({ eventId: randomUUID(), taskId: f.taskId, runId: run.id, status: 'changes_required', summary: 'One finding', head, reviewResponsibility: 'author', reviewText: 'Address the retry guard.' }, 'token');
    await f.engine.wake();
    assert.equal(f.current().phase, 'changes_requested', 'the authenticated result advanced the task');
  } finally { await f.close(); }
});

test('an uncertain resolution restart settles a finished idle recovery run (#3569)', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'awaiting_review', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      profile: null,
      prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-9', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    });
    const run = runSchema.parse({
      id: 'uncertain-review', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: null, workspaceId: 'workspace',
      profile: f.profiles.reviewer, status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: null, idleSince: null, completion: null, released: false,
    });
    f.store.putRun(run);
    unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId }, false);
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id } });

    // The delegated creation ignores unreleased recovery runs, so the finished
    // one settles with the restart instead of riding along unreleased.
    const task = await f.control({ instruction: 'Create the reviewer once and continue' });
    assert.equal(f.store.run('uncertain-review')!.agentId, 'agent-uncertain-review', 'the restart recreated the reviewer');
    const settled = f.store.run('recovery-run')!;
    assert.equal(settled.released, true);
    assert.equal(settled.status, 'finished');
    assert.equal(task.resolution.recovery?.status, 'resolved');
    assert.equal(task.resolution.recovery?.action?.status, 'refused');
    assert.match(task.resolution.recovery?.summary ?? '', /Accepted recovery report was not applied/);
    assert.equal(f.events('run_released_from_recorded_completion').length, 1);
    assert.equal(f.events('owner_fence_settled').length, 1);
    assert.equal(ownerControlCount(f), 1);
  } finally { await f.close(); }
});

test('an ambiguous absent-run lookup refuses with nothing settled or changed', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'awaiting_review', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      profile: null,
      prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-10', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    });
    const run = runSchema.parse({
      id: 'uncertain-review-2', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: null, workspaceId: 'workspace',
      profile: f.profiles.reviewer, status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: null, idleSince: null, completion: null, released: false,
    });
    f.store.putRun(run);
    unrecoveredRecovery(f, { ...recoveredCompletion, taskId: f.taskId }, false);
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id } });
    (f.adapter as unknown as { findRunAgents: () => Promise<{ id: string; workspaceId: string | null }[]> }).findRunAgents =
      async () => [{ id: 'x', workspaceId: 'workspace' }, { id: 'y', workspaceId: 'workspace' }];

    const before = f.current();
    await assert.rejects(f.control({ instruction: 'Create the reviewer once and continue' }), /Run creation lookup is ambiguous \(2 matching agents\)/);
    // The lookup refuses before anything is written: no settlement, no version.
    assert.deepEqual(f.current(), before, 'the refused restart left the task unchanged');
    assert.equal(f.store.run('recovery-run')!.released, false);
    assert.equal(f.events('owner_fence_settled').length, 0);
    assert.equal(ownerControlCount(f), 0);
  } finally { await f.close(); }
});

test('coordinator: restart retries the stalled episode and the revision result advances the task', async () => {
  const f = fixture(); try {
    // A blocked retained worker whose recovery episode escalated: the
    // coordinator restart answers the escalation and returns the task to work.
    f.store.update(f.taskId, {
      phase: 'blocked', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
      profile: f.profiles.worker, workerModel: f.profiles.worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'blocked-coord', status: 'blocked', summary: 'Blocked', prNumber: 7 },
      resolution: {
        ...f.current().resolution, attention: true,
        recovery: { id: 'rec-2', key: 'k2', generation: 1, runId: null, agentId: null, status: 'escalated', summary: 'Could not continue', idleSince: null, incidentId: null },
      },
    });
    const before = f.current();
    await assert.rejects(f.control({ role: 'coordinator', fresh: true }), /Coordinator restart.*fresh is unsupported/);
    assert.deepEqual(f.current(), before, 'unsupported fresh coordinator restart leaves the episode intact');
    assert.equal(ownerControlCount(f), 0);
    const task = await f.control({ role: 'coordinator', fresh: false });
    assert.equal(task.phase, 'changes_requested');
    assert.equal(task.resolution.recovery, null, 'the answered escalation ends its recovery episode');
    assert.equal(task.resolution.attention, false);
    assert.equal(ownerControlCount(f), 1);
    // The continuation run's authenticated result advances the task.
    await advanceViaRevision(f, 7);
  } finally { await f.close(); }
});

function coordinatorWithReviewerFence(f: ReturnType<typeof fixture>, completion = true) {
  const at = new Date().toISOString();
  const recovery = runSchema.parse({
    id: 'coordinator-episode-run', taskId: f.taskId, role: 'recovery', generation: 1, head, base,
    agentId: 'coord-agent', workspaceId: 'workspace', profile: f.profiles.coord, status: 'finished',
    createdAt: at, lastObservedAt: at, active: false, idleSince: at, released: true,
    completion: { eventId: 'old-coordinator-retry', taskId: f.taskId, runId: 'coordinator-episode-run',
      status: 'recovered', summary: 'Old accepted retry', recoveryAction: 'retry' },
  });
  const reviewer = runSchema.parse({
    id: 'finished-reviewer-fence', taskId: f.taskId, role: 'reviewer', generation: 1, head, base,
    agentId: 'review-agent', workspaceId: 'workspace', profile: f.profiles.reviewer, status: 'running',
    createdAt: at, lastObservedAt: null, active: true, idleSince: null, released: false,
    completion: completion ? { eventId: 'finished-reviewer', taskId: f.taskId, runId: 'finished-reviewer-fence',
      status: 'blocked', summary: 'Reviewer finished without a verdict' } : null,
  });
  f.store.putRun(recovery);
  f.store.putRun(reviewer);
  f.store.update(f.taskId, {
    phase: 'blocked', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
    profile: f.profiles.worker, workerModel: f.profiles.worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'coordinator-worker-block', status: 'blocked', summary: 'Blocked', prNumber: 7 },
    resolution: { ...f.current().resolution, attention: true,
      incident: { id: 'coordinator-incident', role: 'worker', runId: 'worker-run', cause: 'missing_callback', action: '', attempt: 0,
        detail: 'Coordinator judgment required', status: 'escalated', fingerprint: 'coordinator-incident', turnId: null, createdAt: at, updatedAt: at },
      recovery: { id: 'coordinator-episode', key: 'coordinator-key', generation: 1, runId: recovery.id, agentId: 'coord-agent',
        status: 'escalated', summary: 'Coordinator judgment required', idleSince: null, incidentId: 'coordinator-incident',
        action: { eventId: 'old-coordinator-retry', runId: recovery.id, reportStatus: 'recovered', recoveryAction: 'retry',
          summary: 'Old accepted retry', status: 'pending' } },
    },
  });
  return { recovery, reviewer };
}

test('coordinator restart releases a finished idle reviewer in the retry transaction and preserves its own episode', async () => {
  const f = fixture(); try {
    const { recovery, reviewer } = coordinatorWithReviewerFence(f);
    const before = f.current();
    const persistedRecovery = f.store.run(recovery.id);
    const retry = f.engine.resolution.retry.bind(f.engine.resolution);
    let retries = 0;
    f.engine.resolution.retry = (...args) => {
      retries++;
      assert.equal(f.store.db.isTransaction, true);
      assert.equal(f.store.run(reviewer.id)!.released, true, 'the other role releases before the retry fence');
      assert.deepEqual(f.current().resolution.recovery, before.resolution.recovery, 'the retry owns the intact episode and old action');
      assert.deepEqual(f.current().resolution.incident, before.resolution.incident);
      assert.deepEqual(f.store.run(recovery.id), persistedRecovery, 'settlement never touches the target recovery run or callback');
      return retry(...args);
    };

    const task = await f.control({ role: 'coordinator' });
    assert.equal(retries, 1, 'only the explicit owner retry runs');
    assert.equal(task.phase, 'changes_requested');
    assert.equal(task.resolution.recovery, null, 'the successful retry answers its episode');
    assert.deepEqual(f.store.run(recovery.id), persistedRecovery);
    assert.equal(f.store.run(reviewer.id)!.status, 'finished');
    assert.deepEqual(f.events('run_released_from_recorded_completion').map(event => event.detail), [`reviewer ${reviewer.id}`]);
    assert.equal(f.events('owner_fence_settled').length, 0, 'the coordinator episode is not superseded by settlement');
    assert.equal(ownerControlCount(f), 1);
  } finally { await f.close(); }
});

test('coordinator restart refuses an unsettled reviewer without changing its episode: active agent', async () => {
  const f = fixture(); try {
    coordinatorWithReviewerFence(f);
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    const before = f.current(), runs = f.store.runs(f.taskId), events = f.store.eventsAll(f.taskId);
    await assert.rejects(f.control({ role: 'coordinator' }),
      /A reviewer run \(finished-reviewer-fence\) still owns this task: its agent is active/);
    assert.deepEqual(f.current(), before, 'incident, recovery and version remain unchanged');
    assert.deepEqual(f.store.runs(f.taskId), runs);
    assert.deepEqual(f.store.eventsAll(f.taskId), events);
  } finally { await f.close(); }
});

test('coordinator restart settles an idle never-reporting reviewer and answers its episode (#339)', async () => {
  const f = fixture(); try {
    // The reviewer never reported and its callback binding is stale, so the
    // superseded-idle rule settles it instead of fencing the retry.
    const { reviewer } = coordinatorWithReviewerFence(f, false);
    const task = await f.control({ role: 'coordinator' });
    const settled = f.store.run(reviewer.id)!;
    assert.equal(settled.released, true);
    assert.equal(settled.status, 'superseded');
    assert.equal(settled.completion, null, 'history is kept; no completion is invented');
    assert.deepEqual(f.events('run_released_from_observed_liveness').map(event => event.detail),
      [`reviewer ${reviewer.id}: restart coordinator: Owner restart`]);
    assert.equal(task.resolution.recovery, null, 'the successful retry answers its episode');
    assert.equal(ownerControlCount(f), 1);
  } finally { await f.close(); }
});

test('a refused coordinator retry rolls back the other role release and its event', async () => {
  const f = fixture(); try {
    coordinatorWithReviewerFence(f);
    f.store.update(f.taskId, { phase: 'needs_attention', resolution: { ...f.current().resolution, attention: false } });
    const before = f.current(), runs = f.store.runs(f.taskId), events = f.store.eventsAll(f.taskId);
    await assert.rejects(f.control({ role: 'coordinator' }), /No resolution action needs retry/);
    assert.deepEqual(f.current(), before, 'the delegated refusal preserves incident, recovery and version');
    assert.deepEqual(f.store.runs(f.taskId), runs, 'the reviewer release rolled back with the retry');
    assert.deepEqual(f.store.eventsAll(f.taskId), events, 'the release event rolled back too');
  } finally { await f.close(); }
});

test('stalled worker mid-turn: restart stops the turn and continues once it releases', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'working', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
      profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      resolution: {
        ...f.current().resolution, attention: true,
        incident: { id: 'stall-inc', role: 'worker', runId: 'worker-run', turnId: 'turn-1', fingerprint: 'stall-inc', attempt: 0, cause: 'stalled_turn', detail: 'looks stalled', action: '', status: 'reconciling', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      },
    });
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '', activeTurnId: 'turn-1' });

    const stopped = await f.control({ instruction: 'Continue after the frozen turn' });
    assert.equal(stopped.resolution.stalledTurnStop?.status, 'sent');
    assert.equal(stopped.resolution.stalledTurnStop?.runId, 'worker-run');
    assert.equal(stopped.resolution.stalledTurnStop?.restartInstruction, 'Continue after the frozen turn');
    assert.equal(f.observations.get('worker-agent')!.active, false);

    // Inactivity observed: reconciliation releases the run and starts the continuation.
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    f.engine.resolution.reconcileStalledTurnStop(f.current(), null, f.observations.get('worker-agent') as never);
    const continued = f.current();
    assert.equal(continued.phase, 'changes_requested', 'the restart continues after the stop releases');
    assert.equal(continued.resolution.stalledTurnStop?.status, 'completed', 'the reconciled stop frees the lane for the continuation');
    assert.equal(continued.resolution.attention, false);
    assert.equal(continued.resolution.pendingWorkerInstruction, 'Continue after the frozen turn');
    assert.equal(ownerControlCount(f), 1);
    // A second restart is no longer refused as "already stopped": the run is
    // released and the task is a plain retained-worker continuation.
    const second = await f.control({ instruction: 'Continue once more' });
    assert.equal(second.phase, 'changes_requested');
    assert.equal(second.resolution.pendingWorkerInstruction, 'Continue once more');
    assert.equal(ownerControlCount(f), 2);
    // The continuation launches on wake: the reconciled stop no longer parks
    // the task behind the stall gate. Its authenticated result advances the task.
    await advanceViaRevision(f, 7);
    assert.equal(ownerControlCount(f), 2, 'the launch and callback write no further owner controls');
  } finally { await f.close(); }
});

test('stalled worker: fresh restart continues the same worker on its route (Spec 058 task 577)', async () => {
  const f = fixture(); try {
    const alternative = profile('alternative', 'test/alternative', ['worker']);
    f.engine.profiles = [...f.engine.profiles, alternative];
    f.store.setMeta('pool', [...f.store.pool(), { profileId: alternative.id, enabled: true, group: alternative.id, roles: ['worker'], weight: 1, scopes: ['general'] }]);
    f.store.update(f.taskId, {
      phase: 'working', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
      profile: f.profiles.worker, workerModel: f.profiles.worker.model, preferredProfileId: alternative.id,
      resolution: {
        ...f.current().resolution, attention: true,
        incident: { id: 'stall-fresh', role: 'worker', runId: 'worker-run', turnId: 'turn-fresh', fingerprint: 'stall-fresh', attempt: 0, cause: 'stalled_turn', detail: 'looks stalled', action: '', status: 'reconciling', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      },
    });
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '', activeTurnId: 'turn-fresh' });
    const stopped = await f.control({ fresh: true, instruction: 'Resume on the current route' });
    assert.equal(stopped.resolution.stalledTurnStop?.restartFresh, true);
    f.engine.resolution.reconcileStalledTurnStop(f.current(), null, f.observations.get('worker-agent') as never);
    // Spec 058 task 577: a stalled turn is an unfinished continuation, not a
    // failure, so the fresh restart continues the same worker on its route.
    assert.equal(f.current().replacementProfile, null);
    assert.match(f.events('worker_replacement_refused').at(-1)!.detail, /^fresh_without_cause_or_relay:/);
    assert.equal(f.current().resolution.pendingWorkerInstruction, 'Resume on the current route');
    await advanceViaWorkerRestart(f, false);
  } finally { await f.close(); }
});

for (const fresh of [false, true]) {
  test(`stalled reviewer: restart honours fresh after its turn releases (fresh=${fresh})`, async () => {
    const f = fixture(); try {
      f.store.update(f.taskId, {
        phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
        agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
        prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
        completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-stall', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
      });
      const run = runSchema.parse({
        id: 'stalled-review-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
        profile: f.profiles.reviewer, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
      });
      f.store.putRun(run);
      f.store.update(f.taskId, { resolution: {
        ...f.current().resolution, currentRunId: run.id, reviewerAgentId: run.agentId, reviewerProfile: run.profile, attention: true,
        incident: { id: 'review-stall', role: 'reviewer', runId: run.id, turnId: 'review-turn', fingerprint: 'review-stall', attempt: 0, cause: 'stalled_turn', detail: 'looks stalled', action: '', status: 'reconciling', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      } });
      f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '', provider: 'codex', model: f.profiles.reviewer.model, activeTurnId: 'review-turn' });
      const stopped = await f.control({ role: 'reviewer', fresh, instruction: 'Finish the review' });
      assert.equal(stopped.resolution.stalledTurnStop?.restartFresh, fresh);
      assert.equal(f.observations.get('review-agent')!.activeTurnId, undefined, 'the confirmed ended turn has no live turn ID');
      f.engine.resolution.reconcileStalledTurnStop(f.current(), f.store.run(run.id)!, f.observations.get('review-agent') as never);
      assert.equal(f.store.run(run.id)!.released, true);
      assert.equal(f.store.run(run.id)!.completion, null);
      assert.equal(f.current().resolution.reviewerAgentId, fresh ? null : run.agentId);
      assert.equal(f.current().resolution.pendingReviewReason, 'Finish the review');
      await advanceViaFreshReview(f);
      const next = f.createdRuns.find(item => item.role === 'reviewer')!;
      assert.notEqual(next.id, run.id);
      assert.equal(fresh ? next.agentId !== run.agentId : next.agentId === run.agentId, true);
      assert.equal(next.workspaceId, run.workspaceId);
      assert.equal(next.head, head);
      assert.equal(ownerControlCount(f), 1);
    } finally { await f.close(); }
  });
}

test('a live healthy reviewer run is not a restart target and is never released', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-live', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    });
    const run = runSchema.parse({
      id: 'live-review-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
      profile: f.profiles.reviewer, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
    });
    f.store.putRun(run);
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id, reviewerAgentId: 'review-agent', reviewerProfile: f.profiles.reviewer } });
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });

    assert.equal(f.next().verbs.find(verb => verb.verb === 'restart')!.available, false, 'a live healthy reviewer is not listed');
    await assert.rejects(f.control({ role: 'reviewer', fresh: true }), /needs a restart/);
    assert.equal(f.store.run(run.id)!.released, false, 'the live run was not released');
    assert.equal(f.observations.get('review-agent')!.active, true);

    // Even a stale run row claiming inactivity refuses while the agent is live.
    f.store.putRun({ ...f.store.run(run.id)!, active: false });
    await assert.rejects(f.control({ role: 'reviewer', fresh: true }), /still live/);
    assert.equal(f.store.run(run.id)!.released, false, 'the live agent still owns its lease');
  } finally { await f.close(); }
});

test('top-tier author with no higher route: restart continues it on role=worker', async () => {
  const f = fixture(); try {
    // A top-tier retained worker in error with no higher profile available: the
    // restart continues the worker rather than parking an escalation.
    f.store.update(f.taskId, {
      phase: 'error', agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
      profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'error-1', status: 'error', summary: 'Crashed' },
    });
    const task = await f.control({ role: 'worker', instruction: 'Continue where you left off' });
    assert.equal(task.phase, 'changes_requested');
    assert.equal(task.resolution.prePrResumeInstruction, 'Continue where you left off');
    assert.equal(ownerControlCount(f), 1);
  } finally { await f.close(); }
});

test('stalled admission: a pre-dispatch park returns to queued whatever the attention flag says', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, { phase: 'needs_attention', reason: 'Admission check parked this task', resolution: { ...f.current().resolution, attention: false } });
    const task = await f.control();
    assert.equal(task.phase, 'queued');
    assert.equal(task.resolution.attention, false);
    assert.equal(ownerControlCount(f), 1);
  } finally { await f.close(); }
});

test('a settled pre-dispatch task parked blocked or error, with released recovery history, replays validation through restart', async () => {
  for (const phase of ['blocked', 'error'] as const) {
    const f = fixture(); try {
      f.store.putRun({ id: `recovery-${phase}`, taskId: f.taskId, role: 'recovery', generation: 0, head: null, base: null, agentId: 'old-coordinator',
        workspaceId: null, profile: null, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: false,
        idleSince: null, completion: null, released: true } as never);
      f.store.update(f.taskId, { phase, reason: 'Admission refused before any worker' });
      const view = f.next().verbs.find(verb => verb.verb === 'restart' && verb.available);
      assert.ok(view, `${phase}: next lists restart`);
      const task = await f.control();
      assert.equal(task.phase, 'queued', phase);
    } finally { await f.close(); }
  }
});

async function originBusyAdmissionScenario(): Promise<void> {
  const proof = exactProofFixture();
  const dir = proof.root;
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const reviewer = profile('reviewer', 'test/reviewer', ['reviewer']);
  store.setMeta('pool', [{ profileId: 'reviewer', enabled: true, group: 'reviewers', roles: ['reviewer'], weight: 1, scopes: ['general'] }]);
  const busy = { reason: 'Origin author thread origin still has an active or uncertain turn', transient: true };
  const adapter = {
    ...proof.adapter,
    inspectReviewEntry: async () => ({ directory: proof.workspace, originWorkspaceId: 'origin-workspace', busyReason: busy.reason, busyTransient: busy.transient }),
  };
  const engine = new Engine(store, adapter as unknown as Adapter, 0); engine.profiles = [reviewer];
  try {
    const input = proof.reviewInput;
    const submitted = store.insert(submissionSchema.parse(input.submission), 'host', 'fixture handoff', proof.planningCommit, {
      entrypoint: 'review',
      reviewEntry: reviewEntryRecordSchema.parse({ operationId: 'c'.repeat(64), prNumber: input.prNumber, repository: 'example/repo', branch: input.expectedBranch, workspaceId: input.workspaceId,
        verifiedHead: input.expectedHead, verifiedBase: input.expectedBaseCommit, planningCommit: input.submission.planningCommit, authority: input.authority,
        authorDeclaration: input.authorDeclaration,
        checkedAt: new Date().toISOString(), preserveWorkspace: true }),
      workspaceIntent: true, workspaceId: input.workspaceId, directory: proof.workspace, branch: input.expectedBranch,
      prHead: input.expectedHead, prUrl: 'https://github.com/example/repo/pull/41', resumePrNumber: input.prNumber,
    });
    await (engine as unknown as { dispatchReviewEntry(task: Task): Promise<void> }).dispatchReviewEntry(submitted);
    const waited = store.task(submitted.id);
    assert.equal(waited.phase, 'queued', 'a transient origin-busy check waits in queued');
    assert.match(waited.reason, /active or uncertain turn/);
    assert.equal(waited.resolution.attention, false);
    assert.equal(waited.resolution.stop?.reason, 'origin_busy');
    assert.deepEqual(waited.resolution.stop?.suggestedVerbs, []);
    busy.reason = '';
    await (engine as unknown as { dispatchReviewEntry(task: Task): Promise<void> }).dispatchReviewEntry(store.task(submitted.id));
    const admitted = store.task(submitted.id);
    assert.equal(admitted.phase, 'awaiting_review', 'the same task admits after the transient condition clears');
    assert.equal(admitted.resolution.stop, null, 'the wait clears on admission');
  } finally { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
}

async function releasedVerdictWithOpenEpisodeScenario(): Promise<void> {
  const f = fixture(); try {
    const task = f.store.update(f.taskId, {
      phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-for-review', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    });
    const reviewer = runSchema.parse({ id: 'review-verdict-run', taskId: task.id, role: 'reviewer', generation: task.coordinatorGeneration,
      head, base, agentId: 'review-agent', workspaceId: 'workspace', profile: f.profiles.reviewer, status: 'running',
      createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false });
    const recovery = runSchema.parse({ id: 'open-episode-run', taskId: task.id, role: 'recovery', generation: task.coordinatorGeneration,
      head, base, agentId: 'coord-agent', workspaceId: 'workspace', profile: f.profiles.coord, status: 'running',
      createdAt: new Date().toISOString(), lastObservedAt: null, active: false,
      idleSince: new Date(Date.now() + 86_400_000).toISOString(), completion: null, released: false });
    f.store.putRun(reviewer); f.store.setCredential(reviewer.id, 'review-token');
    f.store.putRun(recovery);
    const stopped = f.engine.resolution.recordStop(f.current(), 'operator_needed', 'Reviewer result is ready to reconcile', ['restart']);
    const stop = stopped.resolution.stop!;
    f.store.update(task.id, { coordinatorAgentId: 'coord-agent', resolution: { ...stopped.resolution, currentRunId: reviewer.id,
      recoveryActive: true, recovery: { id: 'open-episode', key: digest(`stop:${stop.reason}:${stop.since}`),
        generation: stopped.coordinatorGeneration, runId: recovery.id, agentId: recovery.agentId, status: 'running',
        summary: 'Open coordinator episode', idleSince: null, incidentId: null } } });

    await f.engine.complete({ eventId: 'released-review-verdict', taskId: task.id, runId: reviewer.id, status: 'ready_to_merge',
      summary: 'Approval at the current head', head, reviewText: 'The exact head is ready to merge.', reviewCommentId: 7 }, 'review-token');
    await f.engine.wake();
    const applied = f.current();
    assert.equal(applied.resolution.review?.status, 'ready_to_merge', 'the accepted verdict was applied while recovery stayed open');
    assert.equal(applied.resolution.review?.head, head);
    assert.equal(f.store.run(reviewer.id)?.released, true);
    assert.equal(applied.resolution.currentRunId === reviewer.id, false);
    assert.equal(applied.resolution.recovery?.status, 'running', 'the unrelated open episode did not get to decide the verdict');
  } finally { await f.close(); }
}

async function stalledRunScenario(): Promise<void> {
  const f = fixture(); try {
    f.store.setMeta('stallThresholdMinutes', 0);
    f.store.update(f.taskId, { phase: 'working', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace',
      directory: '/worktree', agentId: 'worker-agent', runId: 'stalled-worker', profile: f.profiles.worker,
      workerModel: f.profiles.worker.model, completion: null });
    f.observations.set('worker-agent', { ...f.observations.get('worker-agent')!, status: 'running', active: true,
      updatedAt: new Date(Date.now() - 60_000).toISOString(), activeTurnId: 'stalled-turn' });
    await f.engine.wake();
    assert.equal(f.current().resolution.stop?.reason, 'run_stalled');
    assert.deepEqual(f.current().resolution.stop?.suggestedVerbs, ['restart']);
  } finally { await f.close(); }
}

async function coordinatorRestartScenario(): Promise<void> {
  const f = fixture(); try {
    Object.assign(f.adapter as unknown as Record<string, unknown>, { supportsCoordinatorRecovery: true });
    f.store.update(f.taskId, { phase: 'blocked', agentId: 'worker-agent', runId: 'blocked-worker', workspaceId: 'workspace',
      directory: '/worktree', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      completion: { taskId: f.taskId, runId: 'blocked-worker', eventId: 'blocked-worker-result', status: 'blocked', summary: 'Worker is blocked' } });
    const stopped = f.engine.resolution.recordStop(f.current(), 'operator_needed', 'Worker needs a restart', ['restart']);
    const stop = stopped.resolution.stop!;
    const coordinator = runSchema.parse({ id: 'coordinator-report-run', taskId: f.taskId, role: 'recovery', generation: stopped.coordinatorGeneration,
      head, base, agentId: 'coord-agent', workspaceId: 'workspace', profile: f.profiles.coord, status: 'running',
      createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false });
    f.store.putRun(coordinator); f.store.setCredential(coordinator.id, 'coordinator-token');
    f.store.update(f.taskId, { coordinatorAgentId: coordinator.agentId!, resolution: { ...stopped.resolution, recoveryActive: true,
      recovery: { id: 'restart-episode', key: digest(`stop:${stop.reason}:${stop.since}`), generation: stopped.coordinatorGeneration, progress: taskProgressDigest(stopped),
        runId: coordinator.id, agentId: coordinator.agentId!, status: 'running', summary: 'Coordinator running', idleSince: null, incidentId: null } } });

    await f.engine.complete({ eventId: 'coordinator-restart-report', taskId: f.taskId, runId: coordinator.id, status: 'recovered',
      summary: 'The worker can continue in its retained workspace', coordinatorGeneration: coordinator.generation,
      coordinatorAction: { verb: 'restart', role: 'worker', instruction: 'Continue from the recorded blocker', reason: 'The worker thread is idle and can resume' } }, 'coordinator-token');
    await f.engine.wake();
    assert.equal(f.current().phase, 'changes_requested');
    assert.equal(f.current().resolution.stop, null);
    assert.ok(f.events('coordinator_action_applied').some(event => event.detail === 'coordinator-restart-report'));
    assert.equal(f.store.run(coordinator.id)?.released, true);
  } finally { await f.close(); }
}

async function coordinatorRouteCostScenario(): Promise<void> {
  for (const [target, usage] of [['sol-worker', 'normal'], ['alt-worker', 'normal'], ['sol-worker', 'maximum']] as const) {
    const f = fixture(); try {
      Object.assign(f.adapter as unknown as Record<string, unknown>, { supportsCoordinatorRecovery: true });
      // Spec 052: the operator's usage level bounds what a coordinator may route to.
      f.store.setMeta('usageLevel', { level: usage, until: null, setAt: new Date().toISOString() });
      // Sol-class is very_high cost; the alternative costs the same as the current worker.
      const sol = profile('sol-worker', 'test/sol', ['worker']), alt = profile('alt-worker', 'test/alt', ['worker']);
      f.engine.profiles = [...f.engine.profiles, sol, alt];
      f.store.setMeta('pool', [...f.store.pool(),
        { profileId: sol.id, enabled: true, group: sol.id, roles: ['worker'], weight: 1, scopes: ['general'], cost: 'very_high' },
        { profileId: alt.id, enabled: true, group: alt.id, roles: ['worker'], weight: 1, scopes: ['general'], cost: 'low' }]);
      f.store.update(f.taskId, { phase: 'blocked', agentId: 'worker-agent', runId: 'blocked-worker', workspaceId: 'workspace',
        directory: '/worktree', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
        completion: { taskId: f.taskId, runId: 'blocked-worker', eventId: 'blocked-worker-result', status: 'error', summary: 'Provider returned HTTP 503 twice' } });
      const stopped = f.engine.resolution.recordStop(f.current(), 'operator_needed', 'Worker provider is failing', ['restart', 'route', 'move']);
      const stop = stopped.resolution.stop!;
      const coordinator = runSchema.parse({ id: 'coordinator-route-run', taskId: f.taskId, role: 'recovery', generation: stopped.coordinatorGeneration,
        head, base, agentId: 'coord-agent', workspaceId: 'workspace', profile: f.profiles.coord, status: 'running',
        createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false });
      f.store.putRun(coordinator); f.store.setCredential(coordinator.id, 'coordinator-token');
      f.store.update(f.taskId, { coordinatorAgentId: coordinator.agentId!, resolution: { ...stopped.resolution, recoveryActive: true,
        recovery: { id: 'route-episode', key: digest(`stop:${stop.reason}:${stop.since}`), generation: stopped.coordinatorGeneration, progress: taskProgressDigest(stopped),
          runId: coordinator.id, agentId: coordinator.agentId!, status: 'running', summary: 'Coordinator running', idleSince: null, incidentId: null } } });
      await f.engine.complete({ eventId: `route-${target}`, taskId: f.taskId, runId: coordinator.id, status: 'recovered',
        summary: 'Route the worker past the provider outage', coordinatorGeneration: coordinator.generation,
        coordinatorAction: { verb: 'route', role: 'worker', profileId: target, reason: 'The provider keeps returning 503' } }, 'coordinator-token');
      await f.engine.wake();
      if (target === 'sol-worker' && usage === 'normal') {
        const refused = f.events('coordinator_action_refused').find(event => event.detail === `route-${target}`);
        assert.ok(refused, 'a coordinator route to a very_high-cost profile is refused');
        const outcome = f.store.verbOutcomes('1970-01-01T00:00:00.000Z').find(row => row.action === 'route' && row.outcome === 'refused');
        assert.match(String(outcome?.detail.reason), /very_high cost is above the operator's normal usage level/);
        assert.notEqual(f.current().profileRequests?.worker?.profileId, 'sol-worker', 'nothing routes to Sol');
      } else {
        assert.ok(f.events('coordinator_action_applied').some(event => event.detail === `route-${target}`), `${target} at ${usage}: the route applies`);
        assert.equal(f.current().profileRequests?.worker?.profileId, target);
      }
    } finally { await f.close(); }
  }
}

/** Each row records the observed world and the next step or stop the reconciler must produce. */
const reconcilerScenarios = [
  { observed: '#151 accepted reviewer verdict plus an open recovery episode', expected: 'apply and release the verdict', run: releasedVerdictWithOpenEpisodeScenario },
  { observed: '#325 origin author has an active turn, then becomes idle', expected: 'wait as origin_busy, then admit the same task', run: originBusyAdmissionScenario },
  { observed: 'worker run is still running but has no activity past the threshold', expected: 'record a run_stalled stop with restart', run: stalledRunScenario },
  { observed: 'idle coordinator reports restart for a blocked worker stop', expected: 'apply restart through the verb registry', run: coordinatorRestartScenario },
  { observed: 'coordinator routes a worker to a very_high-cost profile, or to an equivalent one', expected: 'refuse the Sol-class route (last resort is the owner\'s), apply the equivalent one', run: coordinatorRouteCostScenario },
] as const;
for (const scenario of reconcilerScenarios) {
  test(`reconciler: observed ${scenario.observed} → ${scenario.expected}`, scenario.run);
}

// Review of PR #534 (Sol): regressions.
test('uncertain creation: a hold placed during the inventory lookup defers the restart and creates nothing (review #534)', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-held', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    });
    const run = runSchema.parse({
      id: 'absent-held-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: null, workspaceId: 'workspace',
      profile: f.profiles.reviewer, status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false,
    });
    f.store.putRun(run);
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id, reviewerAgentId: null, reviewerProfile: f.profiles.reviewer, attention: true } });
    (f.adapter as unknown as { findRunAgents: () => Promise<unknown[]> }).findRunAgents = async () => {
      f.store.update(f.taskId, { holds: { dispatch: { owner: 'operator', reason: 'Operator hold', at: new Date().toISOString(), generation: 1, until: null } }, held: true, holdGeneration: 1 });
      return [];
    };
    const task = await f.control();
    assert.equal(f.createdRuns.length, 0, 'no agent is created under the new hold');
    assert.equal(task.resolution.deferredVerb?.why, 'held');
    assert.equal(task.resolution.deferredVerb?.target?.runId, run.id);
  } finally { await f.close(); }
});

test('a pre-dispatch restart applies while Queue is paused (review #534)', async () => {
  const f = fixture(); try {
    // A retained workspace routes the restart through validation re-admission.
    f.store.update(f.taskId, { phase: 'blocked', reason: 'Admission refused before any worker', workspaceIntent: true, workspaceId: 'workspace', directory: '/worktree' });
    f.store.setMeta('paused', true);
    (f.adapter as unknown as { findWorkspaces: () => Promise<unknown[]> }).findWorkspaces = async () => [{ id: 'workspace', directory: '/worktree' }];
    const view = f.next().verbs.find(verb => verb.verb === 'restart' && verb.available);
    assert.ok(view, 'next lists restart while paused');
    const task = await f.control();
    assert.equal(task.phase, 'queued', 'the re-admission is recorded; dispatch waits for unpause');
  } finally { await f.close(); }
});

test('uncertain re-creation persists the new credential before the agent exists, so a crash after creation still authenticates (review #534)', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
      prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-crash', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    });
    const run = runSchema.parse({
      id: 'absent-crash-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: null, workspaceId: 'workspace',
      profile: f.profiles.reviewer, status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false,
    });
    f.store.putRun(run);
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id, reviewerAgentId: null, reviewerProfile: f.profiles.reviewer, attention: true } });
    let authenticatedDuringCreate = false;
    (f.adapter as unknown as { createRun: (t: unknown, r: Run, token: string) => Promise<unknown> }).createRun = async (_t, r, token) => {
      // The process could die right after this returns: the token must already be on record.
      try { f.store.authenticate(r.id, token); authenticatedDuringCreate = true; } catch { /* not yet persisted */ }
      throw new Error('simulated crash after creation');
    };
    await assert.rejects(f.control());
    assert.equal(authenticatedDuringCreate, true, 'the creation token authenticates before the binding commits');
  } finally { await f.close(); }
});

test('fresh worker restart pins the owner\'s required worker route, not the profile that last ran (consumer-b #658)', async () => {
  const f = fixture(); try {
    const sol = profile('sol-worker', 'test/sol', ['worker']);
    f.engine.profiles = [...f.engine.profiles, sol];
    f.store.setMeta('pool', [...f.store.pool(), { profileId: sol.id, enabled: true, group: sol.id, roles: ['worker'], weight: 1, scopes: ['general'] }]);
    retainedWorker(f, 'blocked_worker', false);
    const route = f.next().verbs.find(verb => verb.verb === 'route' && (verb.args as { role?: string } | undefined)?.role === 'worker')!;
    await f.control({ ...route.args, profileId: sol.id, reason: 'Owner: Sol authors this task' });
    assert.equal(f.current().profileRequests?.worker?.profileId, sol.id);
    assert.equal(f.current().profile?.id, f.profiles.worker.id, 'the last run used another profile');
    const routeAfter = f.next().verbs.find(verb => verb.verb === 'route' && (verb.args as { role?: string } | undefined)?.role === 'worker')!;
    assert.equal((routeAfter.args as { profileId?: string }).profileId, sol.id, 'the route view shows the recorded route');
    const restart = f.next().verbs.find(verb => verb.verb === 'restart')!;
    const result = await f.control({ ...restart.args, fresh: true, instruction: 'Continue the approved task' });
    assert.equal(result.replacementProfile?.profileId, sol.id, 'the restart pins the owner route');
    await f.engine.wake();
    assert.equal(f.current().profile?.id, sol.id, 'the fresh worker runs on the owner route');
    assert.equal(f.current().profileRequests?.worker?.reason, 'Owner: Sol authors this task', 'the owner request is kept, not rewritten');
  } finally { await f.close(); }
});

test('a soft worker request does not override the profile that last ran on a fresh restart', async () => {
  const f = fixture(); try {
    const alt = profile('alt-worker', 'test/alt', ['worker']);
    f.engine.profiles = [...f.engine.profiles, alt];
    f.store.setMeta('pool', [...f.store.pool(), { profileId: alt.id, enabled: true, group: alt.id, roles: ['worker'], weight: 1, scopes: ['general'] }]);
    retainedWorker(f, 'blocked_worker', false);
    f.store.update(f.taskId, { profileRequests: { ...f.current().profileRequests, worker: { profileId: alt.id, reason: 'Submission preference', required: false } } });
    const restart = f.next().verbs.find(verb => verb.verb === 'restart')!;
    const result = await f.control({ ...restart.args, fresh: true, instruction: 'Continue the approved task' });
    // Spec 058 task 577: a soft request is no approved model change, so the
    // fresh restart continues the retained worker.
    assert.equal(result.replacementProfile, null);
    assert.match(f.events('worker_replacement_refused').at(-1)!.detail, /^fresh_without_cause_or_relay:/);
  } finally { await f.close(); }
});

test('route with now runs as a durable operation; route without now stays local (consumer-b #658)', () => {
  assert.equal(controlHasExternalEffect({ action: 'route', now: true }), true);
  assert.equal(controlHasExternalEffect({ action: 'route' }), false);
  assert.equal(controlHasExternalEffect({ action: 'route', now: false }), false);
});

test('a resumed route-now operation never cancels a turn that started after its recorded stop (review #557)',async()=>{
 const f=fixture();try{
  retainedWorker(f,'retained_worker',true);
  f.store.update(f.taskId,{completion:null,phase:'working'});
  const task=f.current();
  const input=taskControlInputSchema.parse({taskId:task.id,version:task.version,action:'route',role:'worker',profileId:f.profiles.worker.id,now:true,reason:'Replace current author'});
  const accepted=await f.engine.startOperation({key:'review-crash-route',kind:'task_control',payload:{type:'task_control',control:input},deferSchedule:true});
  assert.ok('accepted' in accepted);
  if(!('accepted' in accepted))throw Error('backpressured');
  f.store.putOperation({...accepted.operation,state:'running',attempts:1,startedAt:new Date().toISOString()});
  let stops=0;
  f.adapter.stopAgentTurn=async id=>{stops++;const state=f.observations.get(id)!;state.active=false;state.status='idle';};
  f.observations.set('worker-agent',{...f.observations.get('worker-agent')!,active:true,status:'running',activeTurnId:'turn-A'});
  await (f.engine as unknown as {stopRouteRun(t:Task,role:string,run:null,operationId:string):Promise<void>}).stopRouteRun(task,'worker',null,accepted.operation.id);
  assert.equal(stops,1);
  assert.equal(f.current().version,input.version,'crash after cancellation and before route_changed leaves version unchanged');
  f.observations.set('worker-agent',{...f.observations.get('worker-agent')!,active:true,status:'running',activeTurnId:'turn-B'});
  f.engine.resumeOperations();
  await f.engine.awaitOperation(accepted.operation.id,2000);
  assert.equal(stops,1,'replay must not stop a different active turn');
 }finally{await f.close()}
});

test('an unknown turn identity never authorizes resending a route-now cancellation (review #557)',async()=>{
 const f=fixture();try{
  retainedWorker(f,'retained_worker',true);
  f.store.update(f.taskId,{completion:null,phase:'working'});
  const task=f.current();
  const input=taskControlInputSchema.parse({taskId:task.id,version:task.version,action:'route',role:'worker',profileId:f.profiles.worker.id,now:true,reason:'Replace current author'});
  const accepted=await f.engine.startOperation({key:'review-crash-route',kind:'task_control',payload:{type:'task_control',control:input},deferSchedule:true});
  assert.ok('accepted' in accepted);
  if(!('accepted' in accepted))throw Error('backpressured');
  f.store.putOperation({...accepted.operation,state:'running',attempts:1,startedAt:new Date().toISOString()});
  let stops=0;
  f.adapter.stopAgentTurn=async id=>{stops++;const state=f.observations.get(id)!;state.active=false;state.status='idle';};
  f.observations.set('worker-agent',{...f.observations.get('worker-agent')!,active:true,status:'running',activeTurnId:undefined});
  await (f.engine as unknown as {stopRouteRun(t:Task,role:string,run:null,operationId:string):Promise<void>}).stopRouteRun(task,'worker',null,accepted.operation.id);
  assert.equal(stops,1);
  // Simulate a crash after remote cancellation but before recording route_stop_sent.
  f.store.db.prepare("DELETE FROM events WHERE taskId=? AND kind='route_stop_sent'").run(task.id);
  assert.equal(f.current().version,input.version,'crash after cancellation and before route_changed leaves version unchanged');
  f.observations.set('worker-agent',{...f.observations.get('worker-agent')!,active:true,status:'running',activeTurnId:undefined});
  f.engine.resumeOperations();
  await f.engine.awaitOperation(accepted.operation.id,2000);
  assert.equal(stops,1,'unknown turn IDs cannot prove that the active turn is the original one');
  const settled=f.engine.operationStatus(accepted.operation.id);
  assert.equal(settled.state,'failed');
  assert.match(settled.diagnostic??'',/cannot prove the live worker turn/);
 }finally{await f.close()}
});

test('a restart before the first profile catalog load waits, then continues on the retained profile once it loads (Consumer #660)', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'blocked_worker', false);
    const all = f.engine.profiles;
    // A freshly rolled service: no catalog observation yet.
    f.engine.profiles = [];
    const restart = f.next().verbs.find(verb => verb.verb === 'restart')!;
    await f.control({ ...restart.args, instruction: 'Continue the approved task' });
    await f.engine.wake();
    assert.notEqual(f.current().phase, 'needs_attention', 'an unobserved profile is never parked as unavailable');
    assert.equal(f.current().reason, PROFILE_CATALOG_PENDING_REASON);
    assert.equal(f.createdRuns.filter(run => run.role === 'revision').length, 0, 'nothing launches before the catalog is known');
    assert.ok(!f.events('needs_attention').some(event => /unavailable/.test(event.detail)));
    // The first refresh observes the catalog; the same retained worker continues.
    f.store.setProfiles(all.map(({ available, problem, supportedThinking, ...p }) => p));
    await f.engine.refresh();
    await f.engine.wake();
    const revision = f.createdRuns.findLast(run => run.role === 'revision');
    assert.ok(revision, 'the retained worker continues after the catalog loads');
    assert.equal(revision!.agentId, 'worker-agent');
    assert.equal(f.current().profile?.id, f.profiles.worker.id);
  } finally { await f.close(); }
});

test('a failed first catalog refresh keeps the visible wait, and a later refresh releases it', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'blocked_worker', false);
    const all = f.engine.profiles;
    f.engine.profiles = [];
    const catalog = f.adapter.catalog!;
    f.adapter.catalog = async () => { throw new Error('daemon catalog unavailable'); };
    const restart = f.next().verbs.find(verb => verb.verb === 'restart')!;
    await f.control({ ...restart.args, instruction: 'Continue the approved task' });
    await assert.rejects(f.engine.refresh(), /daemon catalog unavailable/);
    await f.engine.wake();
    assert.equal(f.current().reason, PROFILE_CATALOG_PENDING_REASON, 'still a visible wait, not an alternate route');
    assert.equal(f.createdRuns.filter(run => run.role === 'revision').length, 0);
    f.adapter.catalog = catalog;
    await f.engine.refresh();
    await f.engine.wake();
    assert.ok(f.createdRuns.some(run => run.role === 'revision'));
  } finally { await f.close(); }
});

test('after the catalog loads, real profile decisions run unchanged and a missing retained profile is still unavailable', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'blocked_worker', false);
    const others = f.engine.profiles.filter(profile => profile.id !== f.profiles.worker.id);
    f.store.setProfiles(others.map(({ available, problem, supportedThinking, ...p }) => p));
    await f.engine.refresh();
    assert.equal(f.engine.profileCatalogKnown(), true, 'a loaded catalog is known even when it lacks the profile');
    assert.match(f.engine.resolution.retainedWorkerProfileIssue(f.current()) ?? '', /is unavailable/, 'the real refusal is preserved');
    const restart = f.next().verbs.find(verb => verb.verb === 'restart')!;
    await f.control({ ...restart.args, instruction: 'Continue the approved task' });
    await f.engine.wake();
    assert.notEqual(f.current().reason, PROFILE_CATALOG_PENDING_REASON, 'a loaded catalog never reads as pending');
  } finally { await f.close(); }
});

test('a named-profile route before the catalog loads refuses as retryable, not as an unknown profile', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'blocked_worker', false);
    f.engine.profiles = [];
    const route = f.next().verbs.find(verb => verb.verb === 'route' && (verb.args as { role?: string } | undefined)?.role === 'worker')!;
    await assert.rejects(f.control({ ...route.args, profileId: f.profiles.worker.id, reason: 'Owner route' }), new RegExp(PROFILE_CATALOG_LOADING_REFUSAL.slice(0, 40)));
  } finally { await f.close(); }
});

test('an unloaded catalog never supersedes an idle reviewer as unavailable (review #565)', async () => {
  const f = fixture(); try {
    const run = reviewingTask(f, 'review-catalog', 'event-catalog');
    f.store.putRun({ ...f.store.run(run.id)!, reviewCheckpoints: [] });
    f.store.update(f.taskId, { reason: 'Review running' });
    f.engine.profiles = [];
    assert.equal(f.engine.profileCatalogKnown(), false);
    await f.engine.resolution.observe();
    assert.equal(f.store.run(run.id)!.released, false, 'the reviewer run is kept');
    assert.notEqual(f.store.run(run.id)!.status, 'superseded');
    assert.equal(f.current().resolution.roleReplacements, 0, 'no replacement is consumed');
    assert.doesNotMatch(f.current().reason, /Replacing unavailable reviewer/);
  } finally { await f.close(); }
});

test('the independence preflight before the catalog loads refuses as retryable, never "absent from the live catalog" (review #565)', async () => {
  const f = fixture(); try {
    f.engine.profiles = [];
    const routing = { scope: 'general' as const, preferredProfileId: f.profiles.worker.id, requirePreferred: true };
    assert.equal(f.engine.independentReviewRoutingRefusal(routing), PROFILE_CATALOG_LOADING_REFUSAL);
    await f.engine.refresh();
    assert.equal(f.engine.independentReviewRoutingRefusal(routing), null);
  } finally { await f.close(); }
});

test('repeating an identical wait longer than the stop detail cap writes nothing, and a changed wait still writes (Consumer #658)', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'blocked_worker', false);
    const long = `Blocked: ${'the worker reported a long blocked summary. '.repeat(250)}`;
    assert.ok(long.length > 4000);
    f.engine.resolution.waiting(f.current(), long, 'operator_needed');
    const settled = f.current();
    assert.equal(settled.reason, long.trim(), 'the task keeps the full reason, trimmed as every stop writer records it');
    assert.ok(settled.resolution.stop!.detail.length <= 4000, 'the stop detail stays capped');
    const waitEvents = () => f.events('task_waiting').length;
    const before = waitEvents();
    for (let pass = 0; pass < 4; pass++) f.engine.resolution.waiting(f.current(), long, 'operator_needed');
    assert.equal(f.current().version, settled.version, 'an unchanged long wait never moves the version');
    assert.equal(waitEvents(), before, 'and records no repeated events');
    // An owner control at that version applies (it is no longer always stale).
    const restart = f.next().verbs.find(verb => verb.verb === 'restart')!;
    assert.equal((restart.args as { version: number }).version, settled.version);
    // A genuinely different wait still writes.
    f.engine.resolution.waiting(f.current(), `${long} Changed.`, 'operator_needed');
    assert.ok(f.current().version > settled.version);
  } finally { await f.close(); }
});

test('waiting and recordStop recording one long reason agree, so alternating them never rewrites the task (Consumer #660)', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'blocked_worker', false);
    const summary = `BLOCKED ${'by a long worker evidence summary. '.repeat(150)}`;
    assert.ok(summary.length > 5000);
    f.engine.resolution.waiting(f.current(), summary, 'operator_needed');
    f.engine.resolution.recordStop(f.current(), 'operator_needed', summary);
    const settled = f.current();
    assert.equal(settled.reason, summary.trim(), 'the task keeps the full text whichever writer ran last');
    assert.ok(settled.resolution.stop!.detail.length <= 4000);
    const writes = () => f.events('task_waiting').length + f.events('task_stopped').length;
    const before = writes();
    for (let pass = 0; pass < 5; pass++) {
      f.engine.resolution.waiting(f.current(), summary, 'operator_needed');
      f.engine.resolution.recordStop(f.current(), 'operator_needed', summary);
    }
    assert.equal(f.current().version, settled.version, 'no version churn between the two writers');
    assert.equal(writes(), before, 'and no repeated events');
  } finally { await f.close(); }
});

/**
 * Tom, 2026-10-23 ("Worker continues"): on a blocked or errored task with a PR,
 * an explicit `role: "worker"` restart continues the retained worker on its PR
 * (the move-to-work transition), even when a reviewer's run is what blocked.
 * A restart without a role keeps routing by the blocking run (Project-C #125: a
 * reviewer-blocked task resumed into review and dispatched a reviewer).
 */
function reviewerBlocked(f: ReturnType<typeof fixture>, phase: 'blocked' | 'error') {
  f.store.update(f.taskId, {
    phase, agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
    profile: f.profiles.worker, workerModel: f.profiles.worker.model, prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-1', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
  });
  f.store.putRun(runSchema.parse({ id: 'review-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base,
    agentId: 'review-agent', workspaceId: 'workspace', profile: f.profiles.reviewer, status: 'finished',
    createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, released: true,
    completion: { taskId: f.taskId, runId: 'review-run', eventId: 'review-blocked', status: phase === 'blocked' ? 'blocked' : 'error', summary: 'Reviewer could not proceed', head } }));
}

for (const phase of ['blocked', 'error'] as const) {
  test(`Tom 2026-10-23: an explicit worker restart on a reviewer-${phase} task with a PR continues the retained worker`, async () => {
    const f = fixture(); try {
      reviewerBlocked(f, phase);
      const reviewersBefore = f.store.runs(f.taskId).filter(run => run.role === 'reviewer').length;
      const task = await f.control({ role: 'worker', instruction: 'Fix the blocker the reviewer named' });
      assert.equal(task.phase, 'changes_requested', 'the retained worker takes the revision');
      assert.equal(task.resolution.pendingWorkerInstruction, 'Fix the blocker the reviewer named');
      assert.equal(task.agentId, 'worker-agent');
      assert.equal(task.prUrl, 'https://github.com/example/repo/pull/7', 'the same PR is kept');
      assert.equal(task.failoverReason ?? '', '', 'no fresh replacement without fresh');
      assert.equal(f.store.runs(f.taskId).filter(run => run.role === 'reviewer').length, reviewersBefore, 'no reviewer run');
      assert.equal(ownerControlCount(f), 1);
      assert.equal(JSON.parse(f.events('owner_control')[0]!.detail).verb, 'restart', 'the control is recorded as the restart it was');
    } finally { await f.close(); }
  });
}

test('Tom 2026-10-23: fresh with an explicit worker restart continues the retained worker without a model change (Spec 058 task 577)', async () => {
  const f = fixture(); try {
    reviewerBlocked(f, 'blocked');
    const task = await f.control({ role: 'worker', fresh: true });
    assert.equal(task.phase, 'changes_requested');
    assert.equal(task.failoverReason ?? '', '', 'no replacement is armed on the same model without a failure');
    assert.equal(task.replacementProfile, null);
    assert.match(f.events('worker_replacement_refused').at(-1)!.detail, /^fresh_without_cause_or_relay:/);
    assert.equal(task.agentId, 'worker-agent', 'the retained worker continues');
  } finally { await f.close(); }
});

test('unchanged (passes on main too): a restart without a role still routes a reviewer-blocked task by its blocking run', async () => {
  const f = fixture(); try {
    reviewerBlocked(f, 'blocked');
    const task = await f.control({});
    assert.equal(task.phase, 'awaiting_review');
  } finally { await f.close(); }
});

test('unchanged refusal (passes on main too): a refused explicit worker restart leaves the task, routing and failover untouched', async () => {
  const f = fixture(); try {
    reviewerBlocked(f, 'blocked');
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    const before = f.current();
    await assert.rejects(f.control({ role: 'worker', fresh: true }));
    const after = f.current();
    assert.equal(after.version, before.version);
    assert.equal(after.phase, 'blocked');
    assert.equal(after.failoverReason ?? '', before.failoverReason ?? '');
    assert.deepEqual(after.replacementProfile ?? null, before.replacementProfile ?? null);
  } finally { await f.close(); }
});

test('Tom 2026-10-23: next offers the default (no role) for a blocked task with a PR and names the worker option', async () => {
  const f = fixture(); try {
    reviewerBlocked(f, 'blocked');
    const restart = f.next().verbs.find(verb => verb.verb === 'restart' && verb.available)!;
    assert.equal((restart.args as Record<string, unknown>).role, undefined, 'the offered args keep the default outcome');
    assert.match(restart.note ?? '', /Add role: "worker"/);
  } finally { await f.close(); }
});


function busyEpisode(f: ReturnType<typeof fixture>) {
  unrecoveredRecovery(f, null);
  f.observations.set('coord-agent', { id: 'coord-agent', workspaceId: 'workspace', status: 'running', active: true, activeTurnId: 'coordinator-turn', permissions: false, error: '' });
}

function absentWorkerTask(f: ReturnType<typeof fixture>) {
  f.store.update(f.taskId, { phase: 'needs_attention', reason: ABSENT_WORKER_REASON,
    workspaceIntent: true, agentIntent: true, agentId: null, runId: 'absent-worker',
    workspaceId: 'workspace', directory: '/worktree', profile: f.profiles.worker });
  busyEpisode(f);
}

function absentReviewerTask(f: ReturnType<typeof fixture>) {
  reviewingTask(f, 'absent-review-admission', 'absent-review-checkpoint');
  const run = f.store.run('absent-review-admission')!;
  f.store.putRun({ ...run, agentId: null, status: 'uncertain', reviewCheckpoints: [] });
  busyEpisode(f);
}

// One family-level scenario exercises the actual delegated refusal boundaries.
// In every case the coordinator is genuinely busy, so a misplaced cancellation
// is visible in both the durable history and the adapter's next observation.
for (const family of ['absent worker', 'checkpoint reviewer', 'absent resolution'] as const) {
  test(`restart admission precedes episode cancellation: ${family}`, async () => {
    const cases = family === 'absent worker' ? ['workspace', 'inventory', 'local prerequisite']
      : family === 'checkpoint reviewer' ? ['PR', 'participant', 'turn', 'adapter']
      : ['workspace', 'PR', 'binding PR', 'inventory capability', 'creation capability'];
    for (const fault of cases) {
      const f = fixture(); try {
        if (family === 'absent worker') absentWorkerTask(f);
        else if (family === 'checkpoint reviewer') { reviewingTask(f, 'admission-review', 'admission-checkpoint'); busyEpisode(f); }
        else absentReviewerTask(f);
        const fail = async () => { throw Error(`admission refused: ${fault}`); };
        if (fault === 'workspace') {
          f.adapter.verifyWorkspace = fail;
          f.adapter.workspaceAvailable = async () => false;
        }
        if (fault === 'inventory') f.adapter.findAgents = fail;
        if (fault === 'local prerequisite') f.store.update(f.taskId, { completion: {
          taskId: f.taskId, runId: 'absent-worker', eventId: 'already-complete', status: 'blocked', summary: 'Already reported' } });
        if (fault === 'PR' || fault === 'binding PR') f.adapter.verifyPr = fail;
        if (fault === 'binding PR') f.adapter.findRunAgents = async () => [{ id: 'found-agent', workspaceId: 'workspace' }];
        if (fault === 'participant') f.observations.get('review-agent')!.id = 'another-agent';
        if (fault === 'turn') f.observations.get('review-agent')!.activeTurnId = 'still-live-turn';
        if (fault === 'adapter') f.adapter.continueReviewer = undefined;
        if (fault === 'inventory capability') delete (f.adapter as Partial<ResolutionAdapter>).findRunAgents;
        if (fault === 'creation capability') delete (f.adapter as Partial<ResolutionAdapter>).createRun;
        const before = f.current(), runs = f.store.runs(f.taskId);
        await assert.rejects(f.control({ instruction: 'Continue only after full admission' }), { name: /Error/ }, fault);
        assert.equal(f.events('owner_stop_intent').length, 0, `${fault}: no cancellation intent on first-read refusal`);
        assert.equal(f.events('owner_stop_sent').length, 0, `${fault}: no remote cancellation`);
        assert.equal(f.observations.get('coord-agent')!.activeTurnId, 'coordinator-turn');
        assert.deepEqual(f.current(), before, `${fault}: no task settlement`);
        assert.deepEqual(f.store.runs(f.taskId), runs, `${fault}: no run settlement or delivery`);
        assert.equal(f.createdRuns.length, 0);
      } finally { await f.close(); }
    }
  });
}

test('restart inspection of an existing checkpoint delivery never cancels its episode or sends again', async () => {
  const f = fixture(); try {
    const run = reviewingTask(f, 'inspection-review', 'inspection-checkpoint');
    const instruction = 'Continue remaining reading';
    await f.control({ instruction });
    assert.equal(f.store.run(run.id)!.reviewDeliveries?.at(-1)?.status, 'delivered');
    busyEpisode(f);
    // Inspection short-circuits first-delivery admission even if a new delivery
    // could not pass it; existing evidence may still be recorded by reconciliation.
    f.adapter.verifyPr = async () => { throw Error('No new PR admission'); };
    f.adapter.continueReviewer = async () => { throw Error('No resend'); };
    await f.control({ instruction });
    assert.equal(f.events('owner_stop_intent').length, 0);
    assert.equal(f.observations.get('coord-agent')!.activeTurnId, 'coordinator-turn');
    assert.equal(f.store.run('recovery-run')!.released, false);
    assert.equal(f.store.run(run.id)!.reviewDeliveries!.length, 1);
  } finally { await f.close(); }
});


for (const stopped of [false, true]) {
  test(`restart admission checks the delegated worker transition before displacement (stopped revision=${stopped})`, async () => {
    const f = fixture(); try {
      f.store.update(f.taskId, { phase: 'changes_requested', agentId: 'worker-agent', runId: 'worker-run',
        workspaceId: 'workspace', directory: '/worktree', profile: f.profiles.worker, prHead: head,
        prUrl: 'https://github.com/example/repo/pull/7' });
      if (stopped) {
        const revision = runSchema.parse({ id: 'stopped-admission', taskId: f.taskId, role: 'revision', generation: 1,
          head, base, agentId: 'worker-agent', workspaceId: 'workspace', profile: f.profiles.worker, status: 'running',
          createdAt: new Date().toISOString(), lastObservedAt: null, idleSince: null, active: false, completion: null, released: false });
        f.store.putRun(revision);
        f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: revision.id } });
      }
      busyEpisode(f);
      const before = f.current(), runs = f.store.runs(f.taskId);
      await assert.rejects(f.control({ role: 'worker' }), /unmerged task PR/);
      assert.equal(f.events('owner_stop_intent').length, 0);
      assert.deepEqual(f.current(), before);
      assert.deepEqual(f.store.runs(f.taskId), runs);
    } finally { await f.close(); }
  });
}

for (const state of ['identity', 'active turn', 'permission', 'closed'] as const) {
  test(`retained reviewer admission protects a ${state} observation before displacement`, async () => {
    const f = fixture(); try {
      reviewingTask(f, 'stopped-observation', 'stopped-observation-checkpoint');
      const run = f.store.run('stopped-observation')!;
      f.store.putRun({ ...run, reviewCheckpoints: [], status: 'superseded', released: true, active: false });
      f.store.update(f.taskId, { phase: 'awaiting_review', resolution: { ...f.current().resolution, currentRunId: null } });
      busyEpisode(f);
      const observed = f.observations.get('review-agent')!;
      if (state === 'identity') observed.id = 'other';
      if (state === 'active turn') observed.activeTurnId = 'still-live';
      if (state === 'permission') observed.permissions = true;
      if (state === 'closed') observed.status = 'closed';
      await assert.rejects(f.control({ role: 'reviewer' }), /still live/);
      assert.equal(f.events('owner_stop_intent').length, 0);
      assert.equal(f.store.run('recovery-run')!.released, false);
    } finally { await f.close(); }
  });
}

test('fully admitted restart families cancel their busy episode and apply once', async () => {
  for (const family of ['absent worker', 'checkpoint', 'absent resolution', 'exact binding']) {
    const f = fixture(); try {
      if (family === 'absent worker') absentWorkerTask(f);
      else if (family === 'checkpoint') { reviewingTask(f, 'success-review', 'success-checkpoint'); busyEpisode(f); }
      else { absentReviewerTask(f); if (family === 'exact binding') f.adapter.findRunAgents = async () => [{ id: 'found-agent', workspaceId: 'workspace' }]; }
      await f.control({ instruction: 'Continue the admitted work' });
      assert.equal(f.events('owner_stop_intent').length, 1, family);
      assert.equal(f.events('owner_stop_sent').length, 1, family);
      assert.equal(f.store.run('recovery-run')!.released, true, family);
      assert.equal(f.observations.get('coord-agent')!.activeTurnId, undefined);
      assert.equal(ownerControlCount(f), 1);
      if (family === 'checkpoint') assert.equal(f.store.run('success-review')!.reviewDeliveries?.length, 1);
      if (family === 'exact binding') assert.equal(f.createdRuns.length, 0);
    } finally { await f.close(); }
  }
});

test('restart keeps remote cancellation uncertainty and refuses drift without applying the transition', async () => {
  for (const boundary of ['binding drift', 'unknown cancellation'] as const) {
    const f = fixture(); try {
      absentWorkerTask(f);
      f.adapter.stopAgentTurn = async () => {
        if (boundary === 'unknown cancellation') throw Error('transport outcome unknown');
        f.store.update(f.taskId, { directory: '/different-workspace' });
      };
      await assert.rejects(f.control(), boundary === 'binding drift' ? /changed/ : /could not stop/);
      assert.equal(f.events('owner_stop_intent').length, 1);
      assert.equal(f.events('owner_stop_uncertain').length, boundary === 'unknown cancellation' ? 1 : 0);
      assert.equal(f.events('owner_fence_settled').length, 0);
      assert.equal(f.store.run('recovery-run')!.released, false);
      assert.equal(f.current().agentIntent, true);
      assert.equal(f.createdRuns.length, 0);
    } finally { await f.close(); }
  }
});

test('a worker restart re-creates a gone task workspace and continues on a fresh thread', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'blocked_worker', false);
    const recoveries: Array<{ task: Task; options: { target?: string } | undefined }> = [];
    Object.assign(f.adapter, {
      workspaceAvailable: async () => false,
      // The registration survives the lost volume: a dead folder is still inventoried.
      findWorkspaces: async () => [{ id: 'workspace', directory: join(f.dir, 'worktree') }],
      recoverTaskWorkspace: async (t: Task, options?: { target?: string }) => {
        recoveries.push({ task: t, options });
        return { id: 'recovered-workspace', directory: '/recovered-worktree' };
      },
    });
    const result = await f.control({ instruction: 'Continue from the re-created worktree' });
    // The source was re-created from the branch on origin; the task, its project
    // and its recorded identity stay, and the fresh thread owes the continuation.
    assert.equal(recoveries.length, 1, 'the lost workspace is recovered once, not rebound to its dead registration');
    assert.deepEqual(recoveries[0]!.options, { target: 'branch' }, 'a worker continuation recovers from the published branch');
    assert.equal(result.workspaceId, 'recovered-workspace');
    assert.equal(result.directory, '/recovered-worktree');
    assert.equal(result.agentId, null, 'the old thread belonged to the lost workspace');
    assert.equal(result.runId, null);
    assert.equal(result.retiredWorkers.length, 1);
    assert.equal(result.retiredWorkers[0]!.agentId, 'worker-agent');
    assert.match(result.retiredWorkers[0]!.reason, /workspace was gone; re-created the worktree from the branch on origin/);
    assert.equal(result.phase, 'changes_requested');
    assert.equal(result.resolution.pendingWorkerInstruction, 'Continue from the re-created worktree');
    assert.match(result.failoverReason ?? '', /remap|replacement/i, 'the gone author is replaced through the existing machinery');
    assert.equal(f.events('task_workspace_recreated').length, 1);
    assert.equal(f.events('owner_control').length, 1);
    assert.equal(f.createdRuns.length, 0, 'no run is started against the lost workspace');
  } finally { await f.close(); }
});

test('a move to work re-creates a gone task workspace and keeps the recorded PR', async () => {
  const f = fixture(); try {
    retainedWorker(f, 'blocked_with_pr', false);
    const recoveries: Array<{ target?: string } | undefined> = [];
    Object.assign(f.adapter, {
      workspaceAvailable: async () => false,
      findWorkspaces: async () => [{ id: 'workspace', directory: join(f.dir, 'worktree') }],
      recoverTaskWorkspace: async (_t: Task, options?: { target?: string }) => {
        recoveries.push(options);
        return { id: 'recovered-workspace', directory: '/recovered-worktree' };
      },
    });
    const before = f.current();
    const result = await f.engine.moveToWork({ taskId: f.taskId, version: before.version, reason: 'Continue after the volume was lost',
      instruction: 'Carry on from the published head', caller: CALLER });
    assert.deepEqual(recoveries, [{ target: 'branch' }], 'move to work recovers from the published branch, not a dead registration');
    assert.equal(result.workspaceId, 'recovered-workspace');
    assert.equal(result.agentId, null);
    assert.equal(result.prUrl, before.prUrl, 'the PR identity is kept');
    assert.equal(result.prHead, before.prHead, 'the recorded head is kept');
    assert.equal(result.resumePrNumber, before.resumePrNumber);
    assert.equal(result.phase, 'changes_requested');
    assert.equal(result.resolution.pendingWorkerInstruction, 'Carry on from the published head');
    assert.equal(f.events('task_workspace_recreated').length, 1);
  } finally { await f.close(); }
});
