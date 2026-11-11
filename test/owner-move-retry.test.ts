import { profile, observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, realpath, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../core/store/store';
import { operationIdForKey, operationInputHash } from '../core/store/store';
import { taskControlOperation } from '../core/verbs/task-control-key';
import { Engine } from '../core/engine';
import type { ResolutionAdapter } from '../core/resolution';
import { reconcileFormalReviewPublication, reviewPublicationBody, reviewStateForStatus, type FormalReviewRuntime } from '../core/forge/index';
import { git, command } from '../core/git/index';
import {
  incidentSchema, reviewCheckpointRecordSchema, reviewEntryRecordSchema, authorDeclarationSchema, runSchema, submissionSchema,
  taskControlInputSchema, taskNextSchema, holdsOf,
  type Run, type Task,
} from '../shared/contracts';
import { hookRecordSchema } from '../shared/hooks';
import { ownerPendingEffects, collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { RuntimeRetirementService, type EffigyAttempt } from '../core/runtime/runtime-retirement';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';
import type { Adapter, AgentObservation } from '../core/host';
import { toolTimelinePage } from './support/tool-timeline';
import { queueOperationSchema } from '../shared/operations';

/**
 * Spec 050 `move` and `retry_effect`. `next` lists every move target that is
 * valid for the current state and every recorded failed or uncertain side
 * effect with its stable `effect` key; the applied controls derive every
 * identity from the task, settle the fences they supersede and write exactly
 * one `owner_control` event.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const CALLER = 'owner-thread';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');


const workerProfile = profile('worker', 'test/worker'), reviewerProfile = profile('reviewer', 'test/reviewer');

function fixture(retirement?: RuntimeRetirementService) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-owner-move-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Steer me', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  store.setMeta('pool', [
    { profileId: workerProfile.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewerProfile.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
  ]);
  const observations = new Map<string, AgentObservation>();
  const timelineEntries: Array<{ timestamp: string; item: { type: string; [key: string]: unknown } }> = [];
  // Round 4: verbs cancel a live turn through Paseo's active-turn cancellation.
  const stops: string[] = [];
  const remote = {
    pr: { url: 'https://github.com/example/repo/pull/7', head },
    merged: null as { head: string; commit: string } | null,
    workspaces: [] as Array<{ id: string; directory: string }>,
  };
  const adapter = {
    profiles: async () => [workerProfile, reviewerProfile],
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: null, status: 'idle', active: false, permissions: false, error: '' },
    agentTimelinePage: async () => toolTimelinePage(timelineEntries),
    originAgent: async (id: string) => ({ id, workspaceId: 'workspace', archived: true }),
    archiveAgent: async () => {}, notify: async () => {},
    findAgents: async () => [],
    findRunAgents: async () => [],
    verifyWorkspace: async () => {},
    findWorkspaces: async () => remote.workspaces,
    verifyPr: async () => remote.pr,
    externalMerge: async (_task: Task, accept: boolean) => (accept ? remote.merged : remote.merged ? remote.merged : null),
    createRun: async () => { throw new Error('no dispatch is expected in these fixtures'); },
    sendRun: async () => {},
    stopAgentTurn: async (id: string) => {
      stops.push(id);
      const observed = observations.get(id);
      if (observed) observations.set(id, { ...observed, status: 'idle', active: false, permissions: false, activeTurnId: undefined });
    },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0, () => true, retirement);
  engine.profiles = [workerProfile, reviewerProfile];
  const task = () => store.task(inserted.id);
  const facts = () => collectOwnerVerbFacts(store, task());
  const next = () => taskNextSchema.parse(ownerTaskNext(facts()));
  const views = (verb: string) => next().verbs.filter(entry => entry.verb === verb);
  const view = (verb: string) => views(verb)[0]!;
  const events = (kind: string) => store.eventsAll(inserted.id).filter(event => event.kind === kind);
  return {
    dir, store, engine, adapter, observations, timelineEntries, stops, remote, taskId: inserted.id, task, facts, next, views, view, events,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A dispatched task with a retained author and a PR. */
function dispatched(f: ReturnType<typeof fixture>, overrides: Partial<Task> = {}) {
  f.store.update(f.taskId, {
    phase: 'reviewing', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, workerModel: workerProfile.model,
    prHead: head, prUrl: 'https://github.com/example/repo/pull/7',
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    ...overrides,
  });
  return f.task();
}

function reviewerRun(f: ReturnType<typeof fixture>, shape: Partial<Run> = {}) {
  const run = runSchema.parse({
    id: 'review-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
    profile: reviewerProfile, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null,
    active: false, idleSince: null, completion: null, released: false,
    ...shape,
  });
  f.store.putRun(run);
  f.store.setCredential(run.id, 'token');
  f.store.update(f.taskId, { resolution: { ...f.task().resolution, currentRunId: run.id, reviewerAgentId: 'review-agent', reviewerProfile: reviewerProfile } });
  return run;
}

test('next exposes an owned-tool hold as a retryable effect until fresh evidence settles it', async () => {
  const f = fixture();
  try {
    f.store.event(f.taskId, 'owned_tool_hold', JSON.stringify({ runId: 'review-run', reason: 'descendant pid 102 remains' }));
    const retry = f.next().verbs.find(view => view.verb === 'retry_effect' && view.available);
    assert.equal(retry?.args?.effect, 'owned_tool.review-run');
    assert.match(retry?.args?.summary as string, /descendant pid 102/);
    f.store.event(f.taskId, 'owned_tool_settled', JSON.stringify({ runId: 'review-run', evidence: 'no descendants' }));
    assert.equal(f.next().verbs.some(view => view.verb === 'retry_effect' && view.available && view.args?.effect === 'owned_tool.review-run'), false);
  } finally { await f.close(); }
});

test('move declares its input and refuses unknown targets at the contract boundary', () => {
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'move', to: 'review', reason: 'r' }).success, true);
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'move', to: 'work', reason: 'r', instruction: 'continue' }).success, true);
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'move', to: 'merge', reason: 'r' }).success, true);
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'move', to: 'closeout', reason: 'r' }).success, true);
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'move', to: 'dismiss', reason: 'r' }).success, false, 'no other target exists');
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'move', to: 'review' }).success, false, 'move requires a reason');
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'retry_effect', reason: 'r' }).success, true);
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'retry_effect' }).success, false, 'retry_effect requires a reason');
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'restart', reason: 'r', effect: 'hook.x' }).success, false, 'an effect key is only valid for retry_effect');
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'retry_effect', reason: 'r', discard: true }).success, true);
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'retry_hook', hookEventId: 'e', discard: true }).success, false, 'the retired retry_hook action is refused; checkout discard rides retry_effect');
});

test('a fresh queued task lists move targets with their refusals and no pending effects', async () => {
  const f = fixture(); try {
    const next = f.next();
    const moveViews = next.verbs.filter(entry => entry.verb === 'move');
    assert.equal(moveViews.length, 4);
    assert.deepEqual(moveViews.map(entry => (entry.args as Record<string, unknown> | undefined)?.to ?? null), [null, null, null, null],
      'a queued task has no author, PR or review yet: every target names its refusal');
    const refusalOf = (index: number) => moveViews[index]!.refusal!;
    assert.match(refusalOf(0), /^move work: .*no retained or intended worker exists/);
    assert.match(refusalOf(1), /^move review: .*needs a task PR/);
    assert.match(refusalOf(2), /^move merge: .*accepted review at the current PR head/);
    assert.match(refusalOf(3), /^move closeout: .*dispatched task with a PR/);
    assert.equal(next.verbs.find(entry => entry.verb === 'retry_effect')!.refusal, 'No failed or uncertain side effect is recorded on this task');
  } finally { await f.close(); }
});

/** A recovery run whose accepted `recovered` report was recorded but never released (#3569). */
function unreleasedRecoveryRun(f: ReturnType<typeof fixture>, completion: Record<string, unknown> | null, active = false) {
  const run = runSchema.parse({
    id: 'stale-recovery', taskId: f.taskId, role: 'recovery', generation: 1, head, base, agentId: 'coord-agent',
    workspaceId: 'workspace', profile: null, status: 'running', createdAt: new Date().toISOString(),
    lastObservedAt: null, active: true, idleSince: null, completion: completion as never, released: false,
  });
  f.store.putRun(run);
  f.observations.set('coord-agent', { id: 'coord-agent', workspaceId: 'workspace', status: active ? 'running' : 'idle', active, permissions: false, error: '' });
  f.store.update(f.taskId, {
    resolution: {
      ...f.task().resolution, recoveryActive: true,
      recovery: { id: 'rec-9', key: 'k9', generation: 1, runId: run.id, agentId: 'coord-agent', status: 'running', summary: 'Coordinator recovery running', idleSince: null, incidentId: null },
    },
  });
  return run;
}

const recoveredCompletion = { eventId: 'rec-9', taskId: '', runId: 'stale-recovery', status: 'recovered', summary: 'Resume the reviewer thread', recoveryAction: 'resume_worker' };

const moveControl = (f: ReturnType<typeof fixture>, reason: string) =>
  f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'review', taskId: f.taskId, version: f.task().version, reason, caller: CALLER }));

async function retainedPr(f: ReturnType<typeof fixture>, status: 'blocked' | 'error' = 'blocked') {
  // Suppress scheduler advancement so refusal snapshots cover only this control.
  await f.engine.stop();
  dispatched(f, { phase: 'working', completion: null, resumePrNumber: 7 });
  f.store.setCredential('worker-run', 'worker-token');
  await f.engine.complete({ taskId: f.taskId, runId: 'worker-run', eventId: 'blocked-result', status, summary: 'Owner acceptance needed' }, 'worker-token');
  f.store.update(f.taskId, { phase: status, resolution: { ...f.task().resolution, attention: true } });
  f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
  f.adapter.verifyResume = async () => head;
  f.adapter.verifyInspectedRevisionHead = async (_task, number, expected) => { assert.equal(number, 7); assert.equal(expected, head); };
}

function moveSnapshot(f: ReturnType<typeof fixture>) {
  return { task: f.task(), runs: f.store.runs(f.taskId), notices: f.store.notices(f.taskId), events: f.store.eventsAll(f.taskId),
    credentials: f.store.db.prepare('SELECT * FROM credentials ORDER BY run').all(),
    receipts: f.store.db.prepare('SELECT * FROM receipts ORDER BY id').all() };
}

for (const status of ['blocked', 'error'] as const) test(`move review accepts retained PR after authentic ${status} with no ready callback`, async () => {
  const f = fixture(); try {
    await retainedPr(f, status);
    const before = f.task();
    assert.equal(f.views('move')[1].available, true);
    const moved = await moveControl(f, 'Accept the delivered scope for review');
    assert.equal(moved.phase, 'awaiting_review'); assert.equal(moved.prHead, head); assert.equal(moved.resumePrNumber, 7);
    assert.deepEqual(moved.completion, before.completion);
    assert.equal(moved.resolution.review, null);
    assert.equal(f.events('owner_control').length, 1);
  } finally { await f.close(); }
});

for (const fault of ['different PR', 'active worker', 'unobservable worker', 'active turn', 'permission', 'source', 'unknown delivery', 'stale version'] as const) {
  test(`retained PR move refuses ${fault} without partial binding or settlement`, async () => {
    const f = fixture(); try {
      await retainedPr(f);
      unreleasedRecoveryRun(f, { ...recoveredCompletion, taskId: f.taskId });
      const observation = f.observations.get('worker-agent')!;
      if (fault === 'active worker') f.observations.set('worker-agent', { ...observation, active: true });
      if (fault === 'unobservable worker') f.observations.delete('worker-agent');
      if (fault === 'active turn') f.observations.set('worker-agent', { ...observation, activeTurnId: 'turn' });
      if (fault === 'permission') f.observations.set('worker-agent', { ...observation, permissions: true });
      if (fault === 'source') f.adapter.verifyInspectedRevisionHead = async () => { throw Error('Source head is unpublished or differs from PR'); };
      if (fault === 'unknown delivery') {
        const run = f.store.run('stale-recovery')!;
        f.store.putRun({ ...run, status: 'uncertain' });
        assert.equal(f.views('move')[1].available, false);
      }
      const before = moveSnapshot(f);
      await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'review', taskId: f.taskId,
        version: f.task().version - (fault === 'stale version' ? 1 : 0), reason: 'Accept for review', caller: CALLER,
        ...(fault === 'different PR' ? { prNumber: 8 } : {}) })),
      /retained task PR|observably inactive|unpublished|uncertain|Task changed/);
      assert.deepEqual(moveSnapshot(f), before);
    } finally { await f.close(); }
  });
}

for (const race of ['task', 'run', 'worker'] as const) test(`retained PR move rechecks ${race} after source verification`, async () => {
  const f = fixture(); try {
    await retainedPr(f);
    const run = unreleasedRecoveryRun(f, { ...recoveredCompletion, taskId: f.taskId });
    let afterRace: ReturnType<typeof moveSnapshot>;
    f.adapter.verifyInspectedRevisionHead = async () => {
      if (race === 'task') f.store.update(f.taskId, { reason: 'Concurrent owner update' });
      if (race === 'run') f.store.putRun({ ...run, status: 'uncertain' });
      if (race === 'worker') f.observations.set('worker-agent', { ...f.observations.get('worker-agent')!, active: true });
      afterRace = moveSnapshot(f);
    };
    await assert.rejects(moveControl(f, 'Accept for review'), /Task changed|run changed|observably inactive/);
    assert.deepEqual(moveSnapshot(f), afterRace!);
  } finally { await f.close(); }
});

test('move review settles a finished recovery run whose agent is idle (#3569)', async () => {
  const f = fixture(); try {
    dispatched(f);
    unreleasedRecoveryRun(f, { ...recoveredCompletion, taskId: f.taskId });
    const moved = await moveControl(f, 'Fresh review of the current head');
    assert.equal(moved.phase, 'awaiting_review');
    // The finished recovery run settled through the reconciliation release path.
    const settled = f.store.run('stale-recovery')!;
    assert.equal(settled.released, true);
    assert.equal(settled.status, 'finished');
    assert.equal(f.events('run_released_from_recorded_completion').length, 1);
    assert.equal(f.events('run_released_from_recorded_completion')[0].detail, 'recovery stale-recovery');
    // The accepted action is recorded as not applied, audibly; the episode closed.
    assert.equal(moved.resolution.recovery?.status, 'resolved');
    assert.equal(moved.resolution.recovery?.action?.status, 'refused');
    assert.match(moved.resolution.recovery?.summary ?? '', /Accepted recovery report was not applied/);
    assert.equal(moved.resolution.recoveryActive, false);
  } finally { await f.close(); }
});

test('move review supersedes a stopped reviewer with a stale active flag and settles a stale external-merge record (#3569)', async () => {
  const f = fixture(); try {
    dispatched(f);
    // The stored `active` flag is stale: the agent is observed idle with no turn.
    const run = reviewerRun(f, { active: true });
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, attention: true,
      externalMergePreAttention: { phase: 'reviewing', reason: 'Stale external-merge check snapshot' } } });

    const moved = await moveControl(f, 'A fresh review at the current head');
    assert.equal(moved.phase, 'awaiting_review');
    const settled = f.store.run(run.id)!;
    // Replaced is not released (planner ruling, 2026-11-09): the move marks the
    // stopped reviewer replaced with its claim held, and still settles the stale
    // external-merge record.
    assert.equal(settled.released, false, 'the stopped reviewer is replaced, not released');
    assert.equal(settled.status, 'superseded');
    assert.notEqual(settled.replacedAt, undefined);
    assert.equal(moved.resolution.externalMergePreAttention, null, 'the stale pre-attention record is settled');
    assert.equal(moved.resolution.attention, false);
    assert.equal(f.events('owner_control').length, 1);
  } finally { await f.close(); }
});

test('move review preserves a live reviewer turn: the observation beats the stored idle flag (round 4)', async () => {
  const f = fixture(); try {
    dispatched(f);
    reviewerRun(f, { active: false });
    // The stored flag says idle; the agent is observed mid-turn, so the reader is
    // preserved instead of being replaced mid-read.
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    const moved = await moveControl(f, 'A fresh review at the current head');
    assert.deepEqual(f.stops, [], 'a reading reviewer turn is not cancelled');
    assert.equal(f.events('owner_stop_intent').length, 0);
    const kept = f.store.run('review-run')!;
    assert.equal(kept.released, false, 'the reading reviewer keeps its lease');
    assert.equal(kept.status, 'running');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM credentials WHERE run=?').get('review-run')!.n, 1, 'its credential stays');
    assert.equal(moved.resolution.currentRunId, 'review-run');
    assert.equal(f.events('owner_control').length, 1, 'one owner control is recorded');
    assert.equal(JSON.parse(f.events('owner_control')[0]!.detail).verb, 'move');
  } finally { await f.close(); }
});

for (const shape of ['no completion', 'active agent'] as const) {
  test(`move review displaces a recovery run the old rules fenced: ${shape} (round 4)`, async () => {
    const f = fixture(); try {
      dispatched(f);
      unreleasedRecoveryRun(f, shape === 'no completion' ? null : { ...recoveredCompletion, taskId: f.taskId }, shape === 'active agent');
      const moved = await moveControl(f, 'Fresh review of the current head');
      assert.deepEqual(f.stops, shape === 'active agent' ? ['coord-agent'] : [], 'only a busy turn is cancelled');
      const settled = f.store.run('stale-recovery')!;
      assert.equal(settled.released, true);
      assert.equal(settled.status, shape === 'no completion' ? 'superseded' : 'finished');
      assert.equal(moved.resolution.recoveryActive, false);
      assert.equal(moved.resolution.recovery?.status, 'resolved', 'the episode closes with its run');
      assert.equal(f.events('owner_control').length, 1);
    } finally { await f.close(); }
  });
}

test('move review still refuses a run whose delivery is unknown, with nothing changed (durable side effect)', async () => {
  const f = fixture(); try {
    dispatched(f);
    const run = unreleasedRecoveryRun(f, null);
    f.store.putRun({ ...run, status: 'uncertain' });
    const before = f.task();
    const refusal = f.views('move')[1]!;
    assert.equal(refusal.available, false);
    assert.match(refusal.refusal!, /durable side effect .*run-delivery stale-recovery is uncertain: run stale-recovery has an uncertain delivery.*restart re-creates it/);
    await assert.rejects(moveControl(f, 'Fresh review of the current head'), /durable side effect Queue will not act over blindly \(run-delivery stale-recovery is uncertain:/);
    assert.deepEqual(f.task(), before, 'a refused move changes nothing');
    assert.equal(f.store.run('stale-recovery')!.released, false);
    assert.deepEqual(f.stops, []);
    assert.equal(f.events('owner_control').length, 0);
  } finally { await f.close(); }
});

test('move work refuses a gone author with no route before settling anything', async () => {
  const f = fixture(); try {
    dispatched(f, { agentId: null, profile: null });
    const before = f.task();
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'work', taskId: f.taskId, version: before.version, reason: 'Back to work', caller: CALLER })),
      /Starting a fresh author requires the worker route or the retained profile/);
    assert.equal(f.task().version, before.version, 'the refused move left the version unchanged');
    assert.equal(f.events('owner_fence_settled').length, 0);
    assert.equal(f.events('owner_control').length, 0);
  } finally { await f.close(); }
});

test('move closeout refuses an unmerged PR with nothing settled', async () => {
  const f = fixture(); try {
    dispatched(f);
    f.observations.set('worker-agent', {id:'worker-agent',workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''});
    f.engine.resolution.recovery.escalate(f.task(), 'Coordinator recovery could not safely continue: the thread never reported');
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, attention: false } });
    const before = f.task();
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'closeout', taskId: f.taskId, version: before.version, reason: 'Merged externally', caller: CALLER })),
      /The task PR is not merged/);
    assert.equal(f.task().version, before.version, 'the refused move left the version unchanged');
    assert.equal(f.task().resolution.recovery?.status, 'escalated', 'the stale episode still stands');
    assert.equal(f.events('owner_fence_settled').length, 0);
    assert.equal(f.events('owner_control').length, 0);
  } finally { await f.close(); }
});

test('move closeout refuses missing task participant tool coverage before the forge read', async () => {
  const f = fixture(); try {
    dispatched(f);
    f.observations.set('worker-agent', {id:'worker-agent',workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''});
    f.adapter.agentTimelinePage = undefined;
    let reads=0;
    f.adapter.externalMerge=async()=>{reads++;return {head,commit:'c'.repeat(40)};};
    const before=f.task(), runs=f.store.runs(f.taskId);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({action:'move',to:'closeout',taskId:f.taskId,version:before.version,reason:'Merged externally',caller:CALLER})),/execution participants or effects are not settled/);
    assert.equal(reads,0);
    assert.notEqual(f.task().version,before.version,'the failed lease check records a visible wait');
    assert.match(f.task().reason,/Merge waits for participant worker-agent: owned tool evidence is unavailable: this adapter offers no tool timeline/);
    assert.deepEqual(f.store.runs(f.taskId),runs);
  } finally { await f.close(); }
});

test('move closeout releases a finished recovery run with its accepted action recorded not applied', async () => {
  const f = fixture(); try {
    dispatched(f);
    f.observations.set('worker-agent', {id:'worker-agent',workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''});
    f.remote.merged = { head, commit: 'c'.repeat(40) };
    unreleasedRecoveryRun(f, { ...recoveredCompletion, taskId: f.taskId });
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'closeout', taskId: f.taskId, version: f.task().version, reason: 'Merged externally', caller: CALLER }));
    assert.ok(['merging', 'syncing'].includes(moved.phase), `the merge is accepted: ${moved.phase}`);
    const settled = f.store.run('stale-recovery')!;
    assert.equal(settled.released, true);
    assert.equal(settled.status, 'finished');
    assert.equal(moved.resolution.recovery?.status, 'resolved');
    assert.equal(moved.resolution.recovery?.action?.status, 'refused');
    assert.match(moved.resolution.recovery?.summary ?? '', /Accepted recovery report was not applied/);
    assert.equal(f.events('run_released_from_recorded_completion').length, 1);
    assert.equal(f.events('owner_control').length, 1);
  } finally { await f.close(); }
});

test('move merge releases a finished recovery run whose agent is idle instead of refusing it', async () => {
  const f = fixture(); try {
    dispatched(f);
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-9', status: 'ready_to_merge', summary: 'Fine', head, reviewId: 19 } } });
    unreleasedRecoveryRun(f, { ...recoveredCompletion, taskId: f.taskId });
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'merge', taskId: f.taskId, version: f.task().version, reason: 'The review stands; take it to merge', caller: CALLER }));
    assert.equal(moved.phase, 'verifying');
    const settled = f.store.run('stale-recovery')!;
    assert.equal(settled.released, true);
    assert.equal(moved.resolution.recovery?.action?.status, 'refused');
    assert.equal(f.events('run_released_from_recorded_completion').length, 1);
    assert.equal(f.events('owner_control').length, 1);
  } finally { await f.close(); }
});

test('move merge displaces an unfinished recovery run instead of refusing it (round 4)', async () => {
  const f = fixture(); try {
    dispatched(f);
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-10', status: 'ready_to_merge', summary: 'Fine', head, reviewId: 20 } } });
    unreleasedRecoveryRun(f, null);
    const before = f.task();
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'merge', taskId: f.taskId, version: before.version, reason: 'Take it to merge', caller: CALLER }));
    assert.notEqual(moved.phase, before.phase, 'the move applied');
    assert.equal(f.store.run('stale-recovery')!.released, true);
    assert.equal(f.store.run('stale-recovery')!.status, 'superseded');
    assert.equal(moved.resolution.recoveryActive, false);
    assert.equal(f.events('owner_control').length, 1);
  } finally { await f.close(); }
});

test('move work settles a completed reviewer run whose agent is idle instead of refusing it', async () => {
  const f = fixture(); try {
    dispatched(f);
    // A reviewer verdict recorded but the run never released (transport outage); its agent sits idle.
    const run = runSchema.parse({
      id: 'stale-review', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
      profile: reviewerProfile, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null,
      completion: { eventId: 'review-11', taskId: f.taskId, runId: 'stale-review', status: 'changes_required', summary: 'Findings', head, reviewResponsibility: 'author', reviewText: 'Address the figures.' }, released: false,
    });
    f.store.putRun(run);
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'work', taskId: f.taskId, version: f.task().version, reason: 'Back to the author', caller: CALLER }));
    assert.equal(moved.phase, 'changes_requested');
    assert.equal(f.store.run('stale-review')!.released, true);
    assert.equal(f.store.run('stale-review')!.status, 'finished');
    assert.equal(f.events('run_released_from_recorded_completion').length, 1);
    assert.equal(f.events('owner_control').length, 1);
  } finally { await f.close(); }
});

test('move work cancels a busy completed reviewer and returns the task to its author (round 4)', async () => {
  const f = fixture(); try {
    dispatched(f);
    const run = runSchema.parse({
      id: 'stale-review', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
      profile: reviewerProfile, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null,
      completion: { eventId: 'review-12', taskId: f.taskId, runId: 'stale-review', status: 'changes_required', summary: 'Findings', head, reviewResponsibility: 'author', reviewText: 'Address the figures.' }, released: false,
    });
    f.store.putRun(run);
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'work', taskId: f.taskId, version: f.task().version, reason: 'Back to the author', caller: CALLER }));
    assert.deepEqual(f.stops, ['review-agent']);
    assert.equal(moved.phase, 'changes_requested');
    assert.equal(f.store.run('stale-review')!.released, true);
    assert.equal(f.store.run('stale-review')!.status, 'finished', 'its recorded verdict stays as history');
    assert.equal(f.events('owner_control').length, 1);
  } finally { await f.close(); }
});

test('a refused revision retry rolls the move-work settlement back', async () => {
  const f = fixture(); try {
    dispatched(f);
    unreleasedRecoveryRun(f, { ...recoveredCompletion, taskId: f.taskId });
    // The revision dispatch refuses after the settlement ran: the whole move,
    // settlement included, must roll back.
    (f.engine.resolution as unknown as { retry: unknown }).retry = () => {
      throw Error('No eligible worker profile is available for the revision');
    };
    const before = f.task();
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'work', taskId: f.taskId, version: before.version, reason: 'Back to the author', caller: CALLER })),
      /No eligible worker profile is available for the revision/);
    assert.equal(f.task().version, before.version, 'the refused move left the version unchanged');
    assert.equal(f.store.run('stale-recovery')!.released, false);
    assert.equal(f.events('owner_fence_settled').length, 0);
    assert.equal(f.events('owner_control').length, 0);
  } finally { await f.close(); }
});

test('move review settles an answered escalation episode: one owner_control event, history kept', async () => {
  const f = fixture(); try {
    dispatched(f);
    // Accepted review credit at the current head, then a parked escalated episode.
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-1', status: 'ready_to_merge', summary: 'Fine', head, reviewId: 11 } } });
    f.store.update(f.taskId, { phase: 'needs_attention', reason: 'Stuck after review' });
    f.engine.resolution.recovery.escalate(f.task(), 'Coordinator recovery could not safely continue: the thread never reported');
    f.store.putNotice({ id: 'attention', taskId: f.taskId, agentId: 'origin', recipientAgentId: 'origin', workspaceId: null, sources: [], originEntry: true, kind: 'attention', status: 'pending', error: '', text: 'Needs attention' });

    const view = f.views('move')[1]!;
    assert.equal(view.available, true, JSON.stringify(view));
    assert.deepEqual(view.args, { action: 'move', to: 'review', taskId: f.taskId, version: f.task().version });
    assert.deepEqual(view.fill, ['reason']);
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...view.args, reason: 'Fresh review of the current head', caller: CALLER }));
    assert.equal(moved.phase, 'awaiting_review');
    assert.equal(moved.resolution.review, null, 'the accepted credit is superseded');
    assert.equal(moved.resolution.reviewSupersessions.length, 1, 'supersession kept as history');
    assert.equal(moved.resolution.incident?.status, 'resolved');
    assert.match(moved.resolution.incident!.detail, /original: Coordinator recovery could not safely continue/);
    assert.equal(moved.resolution.recovery?.status, 'resolved');
    assert.equal(moved.resolution.attention, false);
    assert.equal(f.store.notices(f.taskId).find(notice => notice.id === 'attention')?.status, 'superseded');
    assert.equal(f.events('owner_control').length, 1, 'exactly one audit event');
    const audit = JSON.parse(f.events('owner_control')[0].detail);
    assert.equal(audit.verb, 'move');
    assert.deepEqual(audit.identities.move, { to: 'review' });
    assert.equal(audit.caller, CALLER);
    assert.equal(audit.phaseBefore, 'needs_attention');
    assert.equal(audit.phaseAfter, 'awaiting_review');
    assert.equal(f.events('move_review_requested').length, 1, 'the move records its operation line beside the audit event');
  } finally { await f.close(); }
});

test('move review preserves a checkpointed reviewer instead of replacing it', async () => {
  const f = fixture(); try {
    dispatched(f);
    reviewerRun(f, {
      reviewCheckpoints: [reviewCheckpointRecordSchema.parse({
        ordinal: 1, checkpoint: { covered: ['harness one'], remaining: ['harness two'] }, head, at: new Date().toISOString(), runId: 'review-run', path: `/tmp/${f.taskId}/cp-1.json`,
      })],
    });
    // Observed liveness: the checkpointed reviewer's agent is idle in the task workspace.
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    f.store.update(f.taskId, {
      checkpoints: { records: [], intent: { id: 'intent-1', ordinal: 1, summary: 'Reading', head, runId: 'review-run', eventId: 'cp-1', status: 'pending', createdAt: new Date().toISOString(), deliveredAt: null, attempts: 0, error: '' } },
    });
    const view = f.views('move')[1]!;
    assert.equal(view.available, true, 'the move preserves the valid reader at this head');
    assert.match(view.note!, /preserves the valid reader/, 'the view names what the move does with the reader');

    // An idle reader with an awaiting checkpoint delegates the ordinary
    // retained-restart continuation. This saved checkpoint has no authentic
    // receipt or file, so full admission refuses before anything is replaced,
    // settled or sent.
    await assert.rejects(moveControl(f, 'Continue the retained review'), /checkpoint/i);
    const run = f.store.run('review-run')!;
    assert.equal(run.released, false, 'the retained reader keeps its lease');
    assert.equal(run.status, 'running');
    assert.equal(f.task().resolution.currentRunId, 'review-run', 'no fresh reviewer was started');
    assert.equal(run.reviewCheckpoints?.length, 1, 'the saved checkpoint is preserved');
    assert.equal(f.task().checkpoints.intent?.id, 'intent-1', 'a refused move settles nothing');
    assert.equal(f.events('owner_control').length, 0);
    assert.deepEqual(f.stops, [], 'nothing was stopped');
  } finally { await f.close(); }
});

test('move review preserves a reading reviewer: no stop, no replacement, and its own verdict still lands', async () => {
  const f = fixture(); try {
    dispatched(f, { lastAgentStatus: 'idle', agentActive: false });
    f.store.setMeta('paused', true); // Keep reconciliation deferred while the owner moves to review.
    const run = reviewerRun(f);
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    const moved = await moveControl(f, 'Preserve the reader for everyone');
    assert.deepEqual(f.stops, [], 'a reading reviewer turn is never stopped by the move');
    assert.equal(f.events('move_review_retained').length, 1, 'the move records the preserved reader');
    const audit = JSON.parse(f.events('move_review_retained')[0]!.detail);
    assert.equal(audit.preserved, run.id);
    assert.equal(moved.phase, 'reviewing');
    assert.equal(moved.resolution.currentRunId, run.id, 'the reader is still the task reader');
    assert.equal(f.store.run(run.id)!.released, false);
    f.store.setMeta('paused', false);
    // Its authenticated verdict at the same head still lands: nothing was superseded.
    const verdict = await f.engine.resolution.complete({ taskId: f.taskId, runId: run.id, eventId: 'verdict-after-preserving-move', status: 'changes_required', head, summary: 'Old verdict', reviewText: 'Fix it', reviewResponsibility: 'author' } as never, 'token');
    assert.equal(verdict.accepted, true, 'the preserved reader\'s own verdict is still accepted');
  } finally { await f.close(); }
});

test('a live reviewer turn no longer blocks move; move work stops it and returns the task to its retained author', async () => {
  const f = fixture(); try {
    dispatched(f);
    reviewerRun(f, { active: true });
    const to = (target: string) => {
      const index = ['work', 'review', 'merge', 'closeout'].indexOf(target);
      return f.views('move')[index]!;
    };
    // Round 4: a live reviewer no longer blocks the move; the move stops it.
    assert.equal(to('review').available, true, JSON.stringify(to('review')));
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    const work = to('work');
    assert.equal(work.available, true, JSON.stringify(work));
    assert.deepEqual(work.args, { action: 'move', to: 'work', taskId: f.taskId, version: f.task().version });
    assert.deepEqual(work.fill, ['reason', 'instruction']);
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({
      ...work.args, reason: 'The review stopped without findings; send it back to the author', instruction: 'Address the reviewer thread and push', caller: CALLER }));
    assert.equal(moved.phase, 'changes_requested');
    assert.equal(moved.resolution.pendingWorkerInstruction, 'Address the reviewer thread and push');
    assert.deepEqual(f.stops, ['review-agent'], 'the live reviewer turn was cancelled');
    assert.equal(f.store.run('review-run')!.status, 'superseded');
    assert.equal(f.store.run('review-run')!.released, true);
    assert.equal(f.events('owner_control').length, 1);
    const audit = JSON.parse(f.events('owner_control')[0].detail);
    assert.deepEqual(audit.identities.move, { to: 'work' });
    assert.equal(audit.phaseAfter, 'changes_requested');
  } finally { await f.close(); }
});

for (const author of ['retained', 'gone'] as const) {
  test(`a blocked task whose draft PR Queue cannot see continues through move to work (${author} author; papercut f464154f)`, async () => {
    const f = fixture(); try {
      // consumer-b #552: the worker opened a draft PR on its branch and reported blocked; Queue records
      // no PR (draft PRs are not task PRs) and the worker's lease is released.
      dispatched(f, { phase: 'blocked', prUrl: null, prHead: null, resumePrNumber: null,
        ...(author === 'gone' ? { agentId: null, agentIntent: false } : {}),
        completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-blocked', status: 'blocked', summary: 'Draft PR #834 needs scope confirmation' } });
      if (author === 'retained') f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
      const work = f.views('move')[0]!;
      assert.equal(work.available, true, JSON.stringify(work));
      const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...work.args,
        reason: 'Scope confirmed; continue on the existing branch', instruction: 'Mark draft PR #834 ready, finish the scope and report ready_for_review with its PR number', caller: CALLER }));
      assert.equal(moved.phase, 'changes_requested', moved.reason);
      if (author === 'retained') assert.equal(moved.resolution.pendingWorkerInstruction, 'Mark draft PR #834 ready, finish the scope and report ready_for_review with its PR number');
      else assert.match(moved.failoverReason, /Mark draft PR #834 ready/, 'a fresh author on the worker route continues the same branch');
      assert.equal(moved.branch, f.task().branch);
      if (author === 'gone') {
        // The replacement machinery starts the fresh author in the same workspace: no old agent to observe or retire.
        const prompts: string[] = [];
        Object.assign(f.adapter, {
          // The gone author left uncommitted work: a fresh-worktree check refuses it, a continuation check keeps it.
          verifyResume: async () => head, verifyWorkspace: async () => { throw new Error('New worker worktree is not clean'); },
          createAgent: async (task: Task, _token: string, prompt: string) => { prompts.push(prompt); return { id: 'fresh-author', workspaceId: task.workspaceId }; },
        });
        await (f.engine as unknown as { recoverExhaustedWorkers(): Promise<void> }).recoverExhaustedWorkers();
        const after = f.task();
        assert.equal(after.retiredWorkers.length, 0, 'there was no agent to retire');
        assert.equal(after.workspaceId, 'workspace', 'the same workspace and branch continue');
        assert.equal(prompts.length, 1, `a fresh author was created (${after.phase}: ${after.reason})`);
        assert.equal(after.agentId, 'fresh-author');
        assert.match(prompts[0]!, /Mark draft PR #834 ready/, 'its prompt carries the instruction');
        assert.equal(after.continuesWorkspace, true, 'later dispatches keep verifying it as a continuation');
      }
    } finally { await f.close(); }
  });
}

test('move to work treats a recorded PR URL or head as a PR, never as a pre-PR resume', async () => {
  const f = fixture(); try {
    // A PR URL and head are recorded but no completion or resume number: the move is not a pre-PR resume.
    dispatched(f, { phase: 'blocked', resumePrNumber: null,
      completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-blocked', status: 'blocked', summary: 'Blocked on review feedback' } });
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    const work = f.views('move')[0]!;
    assert.equal(work.available, true, JSON.stringify(work));
    // With PR evidence the move is not a pre-PR resume: the revision path's own PR
    // refusal applies (it names restart), and nothing changes.
    const before = f.task();
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ ...work.args, reason: 'Continue on the PR', instruction: 'Address the feedback on PR #7', caller: CALLER })),
      /requires an unmerged task PR; use restart/);
    assert.equal(f.task().version, before.version, 'a refused move changes nothing');
    assert.equal(f.task().resolution.prePrResumeInstruction ?? null, null);
  } finally { await f.close(); }
});

test('move merge is refused without an accepted head review and enters verification with one', async () => {
  const f = fixture(); try {
    dispatched(f, { resolution: { ...f.task().resolution, review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-1', status: 'changes_required', summary: 'Fix the figures', head } } });
    const to = (target: string) => {
      const index = ['work', 'review', 'merge', 'closeout'].indexOf(target);
      return f.views('move')[index]!;
    };
    // A changes_required verdict with no published evidence is missing evidence,
    // not review credit: `next` offers the explicit operator source acceptance,
    // while the move without a qualification still refuses.
    assert.equal(to('merge').available, true, JSON.stringify(to('merge')));
    assert.match(to('merge').note!, /no published evidence to verify at the forge/);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: f.taskId, version: f.task().version, action: 'move', to: 'merge', reason: 'r', caller: CALLER })), /accepted review at the current PR head/);
    assert.equal(f.events('owner_acceptance')?.length ?? 0, 0);
    assert.equal(f.events('owner_control').length, 0);

    // The reviewer accepts the exact current head: the move enters the ordinary
    // verification turn (pre-merge hooks and merge gates) with the review kept.
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-2', status: 'ready_to_merge', summary: 'Fine', head, reviewId: 12 } } });
    const merge = to('merge');
    assert.equal(merge.available, true, JSON.stringify(merge));
    assert.deepEqual(merge.args, { action: 'move', to: 'merge', taskId: f.taskId, version: f.task().version });
    assert.deepEqual(merge.fill, ['reason']);
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...merge.args, reason: 'The review is accepted; take it to merge', caller: CALLER }));
    assert.equal(moved.phase, 'verifying');
    assert.equal(moved.resolution.review?.status, 'ready_to_merge', 'the accepted review is the merge evidence');
    assert.ok(moved.resolution.integrationTurn?.sequence, 'the integration turn is recorded');
    assert.equal(moved.resolution.currentRunId, null);
    assert.equal(f.remote.pr.head, head, 'the move verified the canonical head at the forge');
    assert.equal(f.events('owner_control').length, 1);
    const audit = JSON.parse(f.events('owner_control')[0].detail);
    assert.deepEqual(audit.identities.move, { to: 'merge' });
    assert.equal(audit.phaseAfter, 'verifying');
  } finally { await f.close(); }
});

test('move closeout records the observed external merge and never mints a review', async () => {
  const f = fixture(); try {
    dispatched(f);
    f.observations.set('worker-agent', {id:'worker-agent',workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''});
    const mergeHead = 'c'.repeat(40), mergeCommit = 'd'.repeat(40);
    f.remote.merged = { head: mergeHead, commit: mergeCommit };
    const view = f.views('move')[3]!;
    assert.equal(view.available, true, JSON.stringify(view));
    assert.deepEqual(view.args, { action: 'move', to: 'closeout', taskId: f.taskId, version: f.task().version });
    assert.deepEqual(view.fill, ['reason']);
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...view.args, reason: 'The PR merged outside Queue', caller: CALLER }));
    assert.ok(['syncing', 'merging'].includes(moved.phase), moved.phase);
    assert.equal(moved.resolution.externalMerge, true);
    assert.equal(moved.resolution.mergedCommit, mergeCommit);
    assert.equal(moved.resolution.mergeHead, mergeHead);
    assert.equal(moved.resolution.review, null, 'closeout never mints a review');
    assert.equal(f.events('external_merge_observed').length, 1);
    assert.equal(f.events('owner_control').length, 1);
    const audit = JSON.parse(f.events('owner_control')[0].detail);
    assert.deepEqual(audit.identities.move, { to: 'closeout' });
  } finally { await f.close(); }
});

test('move work and move merge apply on the first next-derived call to a fenced task (#325 shape)', async () => {
  const f = fixture(); try {
    dispatched(f);
    // The #325 shape: phase and flags disagree — a stale escalated recovery over
    // attention:false. The move settles it as part of the same control, so the
    // settlement's own version bump must never bounce the first call.
    const fence = () => {
      f.store.update(f.taskId, { phase: 'needs_attention', reason: 'Stale recovery owns nothing' });
      f.engine.resolution.recovery.escalate(f.task(), 'Coordinator recovery could not safely continue: the thread never reported');
      f.store.update(f.taskId, { resolution: { ...f.task().resolution, attention: false } });
    };
    fence();
    const work = f.views('move')[0]!;
    assert.equal(work.available, true, JSON.stringify(work));
    const movedAt = f.task().version;
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({
      ...work.args, reason: 'The recovery is stale; the author takes a revision', instruction: 'Continue with the figures', caller: CALLER }));
    assert.equal(moved.phase, 'changes_requested');
    assert.equal(moved.resolution.pendingWorkerInstruction, 'Continue with the figures');
    assert.notEqual(moved.resolution.recovery?.status, 'escalated', 'the stale episode no longer owns the task');
    assert.equal(moved.resolution.recoveryActive, false);
    assert.equal(f.events('owner_control').length, 1);
    assert.ok(f.task().version > movedAt, 'the applied move moved the version past the settled fences');

    // Finish the first move's lifecycle wake before constructing the second
    // scenario. Otherwise it can project a stop onto the new synthetic fence
    // after next has read it, which is a real concurrent change.
    await f.engine.quiesce();
    // Same shape for merge: a ready_to_merge review at the head and a stale fence.
    fence();
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-3', status: 'ready_to_merge', summary: 'Fine', head, reviewId: 13 } } });
    const merge = f.views('move')[2]!;
    assert.equal(merge.available, true, JSON.stringify(merge));
    const merged = await f.engine.performTaskControl(taskControlInputSchema.parse({
      ...merge.args, reason: 'The review stands; take it to merge', caller: CALLER }));
    assert.equal(merged.phase, 'verifying');
    assert.equal(merged.resolution.recovery?.status, 'resolved');
    assert.equal(f.events('owner_control').length, 2);
    assert.deepEqual(JSON.parse(f.events('owner_control')[1].detail).identities.move, { to: 'merge' });
  } finally { await f.close(); }
});

test('retry_effect lists each pending effect with a stable key and retries a blocked hook once', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ns-owner-effect-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await command('git', ['init', '--bare', '--initial-branch=main', join(root, 'origin.git')], root);
  await command('git', ['clone', join(root, 'origin.git'), join(root, 'repo')], root);
  const repo = join(root, 'repo');
  await git(repo, 'config', 'user.name', 'Queue test');
  await git(repo, 'config', 'user.email', 'queue@example.invalid');
  const ledgerPath = join(root, 'ledger.jsonl');
  const hookScript = `#!/usr/bin/env node
const fs=require('fs');
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  const event=JSON.parse(raw);
  fs.appendFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify(event)+'\\n');
  const first=event.attempt===1;
  process.stdout.write(JSON.stringify({schema:'paseo.queue.hook-result.v1',eventId:event.eventId,outcome:first?'blocked':'ok',summary:first?'hold once':'retried',metadata:{},changedPaths:[],commitSubjectSuffix:null}));
});
`;
  const manifest = JSON.stringify({ schema: 'paseo.queue.control.v1', hooks: [{ id: 'ledger', events: ['task.pre_dispatch'], mode: 'read_only', delivery: 'required', executable: '.paseo/hooks/ledger', argv: [], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null }] }, null, 2);
  for (const [path, spec] of [['.paseo/queue.json', manifest], ['.paseo/hooks/ledger', hookScript]] as const) {
    const full = join(repo, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, spec);
    if (path.endsWith('ledger')) await chmod(full, 0o755);
  }
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'base');
  const repoHead = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'push', 'origin', 'main');

  const dir = mkdtempSync(join(tmpdir(), 'ns-owner-effect-store-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Hooked', repoPath: repo, planningCommit: repoHead,
    handoffPath: 'docs/plan.json', originAgentId: 'origin',
  }), 'host', 'handoff', repoHead);
  const adapter = {
    profiles: async () => [], observe: observeIdle(null),
    archiveAgent: async () => {}, notify: async () => {}, findAgents: async () => [], findRunAgents: async () => [],
    verifyWorkspace: async () => {}, findWorkspaces: async () => [], verifyPr: async () => ({ url: 'u', head: repoHead }), sendRun: async () => {},
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  const delivery = { prUrl: 'https://example.invalid/pull/9', prNumber: 9, head: '1'.repeat(40), review: 'reviewed head', mergeCommit: '2'.repeat(40), integrationCommit: '3'.repeat(40), summary: 'first delivery' };
  const first = await engine.hooks.emit('task.pre_dispatch', store.task(inserted.id), { event: 'task.pre_dispatch', baseCommit: repoHead, delivery });
  assert.equal(first.hold, true, first.records[0].error);
  assert.equal(first.records[0].state, 'blocked');

  const facts = () => collectOwnerVerbFacts(store, store.task(inserted.id));
  const next = () => taskNextSchema.parse(ownerTaskNext(facts()));
  const effectViews = next().verbs.filter(entry => entry.verb === 'retry_effect');
  assert.equal(effectViews.length, 1);
  const view = effectViews[0]!;
  assert.equal(view.available, true, JSON.stringify(view));
  assert.deepEqual(view.args, {
    action: 'retry_effect', effect: `hook.${first.records[0].eventId}`, taskId: inserted.id, version: store.task(inserted.id).version,
    summary: `task.pre_dispatch hook ledger occurrence is blocked`,
  });
  assert.deepEqual(view.fill, ['reason']);

  const retried = await engine.performTaskControl(taskControlInputSchema.parse({
    ...view.args, reason: 'The hook policy settled; retry the recorded occurrence', caller: CALLER }));
  const stored = store.hookEvent(first.records[0].id)!;
  assert.equal(stored.state, 'result');
  assert.equal(stored.attempt, 2, 'exactly one confirmed attempt was added');
  assert.equal(stored.eventId, first.records[0].eventId, 'the occurrence identity is kept');
  const lines = (await readFile(ledgerPath, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1]).delivery, delivery, 'the retry reproduced the immutable delivery');
  assert.equal(store.eventsAll(inserted.id).filter(event => event.kind === 'owner_control').length, 1);
  const audit = JSON.parse(store.eventsAll(inserted.id).find(event => event.kind === 'owner_control')!.detail);
  assert.equal(audit.verb, 'retry_effect');
  assert.equal(audit.identities.effect, `hook.${first.records[0].eventId}`);
  assert.equal(retried.phase, 'queued', 'the task keeps waiting to dispatch');
  await engine.stop();
  store.close();
});

test('retry_effect binds a workspace creation found present and replays one proven absent', async () => {
  const f = fixture(); try {
    // Uncertain creation: the workspace intent is recorded, no worker ever arrived.
    f.store.update(f.taskId, {
      phase: 'needs_attention', workspaceIntent: true, workspaceId: 'workspace', directory: '/worktree', branch: `ns-${f.taskId}`,
      reason: 'Workspace creation is unproven', profile: workerProfile, profileGroup: 'author',
    });
    const present = f.view('retry_effect');
    assert.equal(present.available, true, JSON.stringify(present));
    assert.equal((present.args as Record<string, unknown>).effect, 'workspace_creation');
    assert.match((present.args as Record<string, unknown>).summary as string, /Workspace creation is unproven/);

    f.remote.workspaces = [{ id: 'workspace', directory: '/worktree' }];
    const bound = await f.engine.performTaskControl(taskControlInputSchema.parse({ ...present.args, reason: 'The workspace is there; bind and dispatch', caller: CALLER }));
    assert.equal(bound.phase, 'queued', 'the found workspace is bound and dispatch resumes');
    assert.equal(f.events('owner_control').length, 1);
    assert.equal(JSON.parse(f.events('owner_control')[0].detail).identities.effect, 'workspace_creation');

    // The refused-at-the-send-boundary shape (PR #439): definitely not sent, so
    // the replay mints a valid identity and creates once.
    const f2 = fixture(); try {
      f2.store.update(f2.taskId, {
        phase: 'needs_attention', workspaceIntent: true, branch: `ns-${f2.taskId}`,
        reason: 'The installed client refused the malformed create before sending', profile: workerProfile, profileGroup: 'author',
      });
      f2.remote.workspaces = [];
      const replay = f2.view('retry_effect');
      assert.equal(replay.available, true, JSON.stringify(replay));
      const replayed = await f2.engine.performTaskControl(taskControlInputSchema.parse({ ...replay.args, reason: 'Never sent; create it now', caller: CALLER }));
      assert.equal(replayed.phase, 'queued');
      assert.match(replayed.reason, /provably absent/);
      assert.equal(f2.events('owner_control').length, 1);
    } finally { await f2.close(); }
  } finally { await f.close(); }
});

test('retry_effect observes first: a named effect no longer pending refuses with what was observed', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, {
      phase: 'needs_attention', workspaceIntent: true, workspaceId: 'workspace', directory: '/worktree', branch: `ns-${f.taskId}`,
      reason: 'Workspace creation is unproven', profile: workerProfile, profileGroup: 'author',
    });
    f.remote.workspaces = [{ id: 'workspace', directory: '/worktree' }];
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: f.taskId, version: f.task().version, action: 'retry_effect', effect: 'runtime_retirement.workspace',
      reason: 'stale key', caller: CALLER })), /No recorded side effect runtime_retirement\.workspace is pending/);
    assert.equal(f.events('owner_control').length, 0, 'a refused retry records no audit event');
  } finally { await f.close(); }
});

test('retry_effect retries a failed runtime retirement through its recorded scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-owner-retire-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Retire me', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const calls: string[][] = [];
  const invoke = async (args: string[]): Promise<EffigyAttempt> => {
    calls.push(args);
    return { code: 0, timedOut: false, spawnError: '', output: 'retired scope' };
  };
  const engine = new Engine(store, { profiles: async () => [], observe: observeIdle(null),
    archiveAgent: async () => {}, notify: async () => {}, findAgents: async () => [], findRunAgents: async () => [], verifyWorkspace: async () => {},
    findWorkspaces: async () => [], verifyPr: async () => ({ url: 'u', head }), sendRun: async () => {} } as unknown as Adapter, 0, () => true,
    new RuntimeRetirementService(store, invoke));
  try {
    store.update(inserted.id, {
      phase: 'done', directory: '/worktree', workspaceId: 'workspace', prHead: head, prUrl: 'https://github.com/example/repo/pull/7',
      // Filesystem archive completed; only its captured runtime scope still needs proof.
      resolution: { ...store.task(inserted.id).resolution, mergedCommit: 'e'.repeat(40), archivedWorkspaceIds: ['workspace'],
        runtimeRetirements: [{ workspaceId: 'workspace', directory: '/worktree', scope: { kind: 'worktree' as const, token: 'a'.repeat(32) },
          state: 'failed' as const, capturedAt: new Date().toISOString(), provedAt: null, attempts: 1,
          error: 'runtime retirement failed: runtime retire exited 1', outputTail: '', nextAttemptAt: new Date(Date.now() - 60_000).toISOString() }] },
    });
    // The reviewer's probe shape: a stale escalated episode and its attention
    // flag sit beside the pending effect. The applied retry settles them with
    // history kept instead of leaving a fence behind (Spec 050).
    engine.resolution.ensureIncident(store.task(inserted.id), null, 'Stuck after the archive');
    store.update(inserted.id, { resolution: { ...store.task(inserted.id).resolution, attention: true,
      incident: { ...store.task(inserted.id).resolution.incident!, status: 'escalated' } } });
    const escalatedAt = store.eventsAll(inserted.id).filter(event => event.kind === 'incident').length;
    const view = taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, store.task(inserted.id)))).verbs
      .find(entry => entry.verb === 'retry_effect')!;
    assert.equal(view.available, true, JSON.stringify(view));
    assert.equal((view.args as Record<string, unknown>).effect, 'runtime_retirement.workspace');
    assert.match((view.args as Record<string, unknown>).summary as string, /runtime retirement failed/);

    await engine.performTaskControl(taskControlInputSchema.parse({ ...view.args, reason: 'The Effigy CLI is back; prove it now', caller: CALLER }));
    const settled = store.task(inserted.id);
    const record = settled.resolution.runtimeRetirements[0]!;
    assert.equal(record.state, 'retired');
    assert.ok(record.provedAt);
    assert.deepEqual(calls, [['container', 'retire', '--scope', 'a'.repeat(32), '--yes']]);
    assert.equal(settled.resolution.incident?.status, 'resolved', 'the obsolete fence is settled with the retry');
    assert.match(settled.resolution.incident!.detail, /Superseded by an owner control: retry_effect runtime_retirement\.workspace/);
    assert.equal(settled.resolution.attention, false);
    assert.ok(store.eventsAll(inserted.id).some(event => event.kind === 'owner_fence_settled'));
    assert.equal(store.eventsAll(inserted.id).filter(event => event.kind === 'incident').length, escalatedAt + 1,
      'the settlement event is added beside the retained escalation history');
    const audits = store.eventsAll(inserted.id).filter(event => event.kind === 'owner_control');
    assert.equal(audits.length, 1);
    assert.equal(JSON.parse(audits[0].detail).identities.effect, 'runtime_retirement.workspace');
  } finally { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('move to review still binds a named replacement PR through the strict replacement route', async () => {
  const f = fixture(); try {
    const calls: number[] = [];
    (f.engine.resolution as unknown as { adoptReplacementPr: (task: Task, pr: number) => Promise<Task> }).adoptReplacementPr = async (task, pr) => { calls.push(pr); return task; };
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: f.task().version, action: 'move', to: 'review', prNumber: 12, reason: 'The accepted result named the wrong PR', caller: CALLER }));
    assert.deepEqual(calls, [12], 'move to=review with prNumber reaches the strict replacement-PR binding');
    assert.equal(taskControlInputSchema.safeParse({ taskId: f.taskId, version: 1, action: 'move', to: 'merge', prNumber: 12, reason: 'r' }).success, false, 'prNumber is only for move to review');
  } finally { await f.close(); }
});

test('the latest failed advisory hook occurrence is a pending effect; an older or succeeded one is not', async () => {
  const f = fixture(); try {
    const facts = f.facts();
    const record = (eventId: string, state: string) => ({ eventId, event: 'task.finished', hookId: 'runtime-stop', delivery: 'advisory', state }) as unknown as typeof facts.hookRecords[number];
    const keys = (records: typeof facts.hookRecords) => ownerPendingEffects({ ...facts, hookRecords: records }).map(effect => effect.effect);
    assert.deepEqual(keys([record('old', 'failed'), record('new', 'failed')]), ['hook.new'], 'only the latest failed advisory occurrence');
    assert.deepEqual(keys([record('old', 'failed'), record('new', 'result')]), [], 'a later successful occurrence clears it');
  } finally { await f.close(); }
});

test('retry_effect requires an effect key when multiple terminal workspace archives are pending', async () => {
  const f = fixture();
  try {
    const retry = (workspaceId: string) => ({ workspaceId, attempts: 1, error: 'history unavailable', nextAttemptAt: new Date().toISOString() });
    dispatched(f, { phase: 'done', resolution: { ...f.task().resolution, mergedCommit: head, syncedCommit: head,
      closeoutWorkspaceId: 'closeout', closeoutDirectory: '/closeout', closeoutWorkspaceHead: head,
      workspaceArchiveRetries: [retry('workspace'), retry('closeout')] } });
    const before = f.task();
    assert.equal(f.views('retry_effect').filter(view => String(view.args?.effect).startsWith('workspace_archive.')).length, 2);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: before.version,
      action: 'retry_effect', reason: 'Retry cleanup', caller: CALLER })), /Name one pending effect: workspace_archive.workspace, workspace_archive.closeout/);
    assert.deepEqual(f.task(), before, 'an ambiguous request changes nothing and cannot fall through to unused-workspace cleanup');
  } finally { await f.close(); }
});


for (const status of ['changes_required', 'ready_to_merge'] as const) for (const mismatch of [false, true]) for (const phase of ['reviewing', 'blocked'] as const) {
  test(`owner retry_effect reaches real forge reconciliation: ${status}, mismatch=${mismatch}, phase=${phase}`, async () => {
    const f = fixture(); try {
      await git(f.dir, 'init', '--initial-branch=main');
      await git(f.dir, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
      dispatched(f, { repoPath: f.dir });
      f.store.putRepository({ path: f.dir, origin: null }, null, '', null, {login:'reviewer'});
      const r = reviewerRun(f, {status:'finished', released:true, completion:{eventId:'unpublished',taskId:f.taskId,
        runId:'review-run',status,head,summary:'Original verdict',reviewText:'Exact findings \\u0085'}});
      f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(r.completion!.eventId,f.taskId,r.id,sha(JSON.stringify(r.completion)),JSON.stringify({accepted:true}));
      const body = reviewPublicationBody(f.task(),r,status,r.completion!.reviewText!);
      f.store.setMeta(`reviewPublication:${r.id}`,{hash:sha(body)});
      f.observations.set('worker-agent',{id:'worker-agent',workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''});
      f.observations.set('review-agent',{id:'review-agent',workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''});
      f.engine.resolution.attention(f.task(),'Review publication is uncertain; marked findings mismatch');
      const runtime: FormalReviewRuntime = {readToken:async()=> 'fixture',verifyPr:async()=> f.remote.pr,
        runGh:async(_task,_endpoint,args)=> {
          assert.equal(args.includes('-X'),false,'existing marker never posts again');
          return [[{id:42,user:{login:'reviewer'},state:reviewStateForStatus(status),commit_id:head,body:mismatch?body.replace('Exact','Altered'):body}]];
        }};
      f.adapter.reconcileReviewPublication=(store,task,run,reviewer,reason,allowed)=>reconcileFormalReviewPublication(store,task,run,reviewer,reason,allowed,runtime);
      if(!mismatch){
        const reconcile=f.adapter.reconcileReviewPublication;
        f.adapter.reconcileReviewPublication=async(...args)=>{
          const id=await reconcile!(...args);
          f.store.deleteMeta(`reviewPublication:${r.id}`);
          return id;
        };
      }
      if (phase === 'blocked') f.store.update(f.taskId, {phase, resolution: {...f.task().resolution, currentRunId:null}});
      const effect = f.views('retry_effect').find(view => view.args?.effect===`review_publication.${r.id}`)!;
      assert.ok(effect?.available);
      assert.equal(effect.forceArgs, undefined, 'next names ordinary publication retry as the real exit');
      assert.match(effect.note!, /without force/);
      await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({action:'retry_effect',taskId:f.taskId,version:f.task().version,effect:`review_publication.${r.id}`,force:true,reason:'Retry the observed absent marker',caller:'operator (board)'})), /Force cannot discard.*without force/);
      assert.equal(f.task().resolution.ownerSettlements.length,0,'forcing cannot settle an unpublished verdict');
      assert.match(String(effect.args!.summary),new RegExp(status));
      assert.doesNotMatch(String(effect.args!.summary),/accepted the head/);
      const before=f.task();
      const invoke=()=>f.engine.performTaskControl(taskControlInputSchema.parse({action:'retry_effect',taskId:f.taskId,version:before.version,effect:`review_publication.${r.id}`,reason:'Reconcile original verdict',caller:CALLER}));
      if(mismatch){
        await assert.rejects(invoke(),/persisted findings/);
        assert.deepEqual(f.task(),before,'refusal preserves the stop and recovery evidence');
        assert.equal(f.store.run(r.id)!.completion!.reviewId,undefined);
      }else{
        await invoke();
        assert.equal(f.store.run(r.id)!.completion!.reviewId,42);
        assert.equal(f.store.run(r.id)!.completion!.status,status,'no changes_required becomes approval');
        assert.equal(f.store.getMeta<{hash:string;reviewId:number}>(`reviewPublication:${r.id}`)?.reviewId,42,
          'the retry boundary retains a durable receipt even if the adapter only returns the remote ID');
      }
    } finally { await f.close(); }
  });
}

test('a review publication retry while paused is recorded and applied once Queue is unpaused (round 4)', async () => {
  const f = fixture(); try {
    await git(f.dir, 'init', '--initial-branch=main');
    await git(f.dir, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
    dispatched(f, { repoPath: f.dir });
    f.store.putRepository({ path: f.dir, origin: null }, null, '', null, {login:'reviewer'});
    const r = reviewerRun(f, {status:'finished', released:true, completion:{eventId:'unpublished',taskId:f.taskId,
      runId:'review-run',status:'changes_required',head,summary:'Original verdict',reviewText:'Exact findings'}});
    f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(r.completion!.eventId,f.taskId,r.id,sha(JSON.stringify(r.completion)),JSON.stringify({accepted:true}));
    const body = reviewPublicationBody(f.task(),r,'changes_required',r.completion!.reviewText!);
    f.store.setMeta(`reviewPublication:${r.id}`,{hash:sha(body)});
    f.observations.set('worker-agent',{id:'worker-agent',workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''});
    f.observations.set('review-agent',{id:'review-agent',workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''});
    f.engine.resolution.attention(f.task(),'Review publication is uncertain; marked findings mismatch');
    let forgeCalls = 0;
    const runtime: FormalReviewRuntime = {readToken:async()=> 'fixture',verifyPr:async()=> f.remote.pr,
      runGh:async()=> { forgeCalls++; return [[{id:42,user:{login:'reviewer'},state:reviewStateForStatus('changes_required'),commit_id:head,body}]]; }};
    f.adapter.reconcileReviewPublication=(store,task,run,reviewer,reason,allowed)=>reconcileFormalReviewPublication(store,task,run,reviewer,reason,allowed,runtime);
    f.store.setMeta('paused', true);
    assert.ok(f.views('retry_effect').find(view=>view.args?.effect===`review_publication.${r.id}`)?.available, 'next offers the retry while paused');
    const recorded = await f.engine.performTaskControl(taskControlInputSchema.parse({action:'retry_effect',taskId:f.taskId,version:f.task().version,effect:`review_publication.${r.id}`,reason:'Reconcile original verdict',caller:CALLER}));
    assert.equal(recorded.resolution.deferredVerb?.why, 'paused');
    assert.equal(forgeCalls, 0, 'nothing reaches the forge while paused');
    f.store.setMeta('paused', false);
    for (let pass = 0; pass < 3 && f.store.run(r.id)!.completion!.reviewId === undefined; pass++) await f.engine.wake();
    assert.equal(f.store.run(r.id)!.completion!.reviewId, 42, 'the recorded retry reconciled after unpause');
    assert.equal(f.task().resolution.deferredVerb, null);
  } finally { await f.close(); }
});

for (const shape of ['idle', 'idle-findings', 'active', 'unknown', 'unobservable', 'permission', 'version-race', 'run-race'] as const) {
  test(`held author return after publication mismatch: ${shape}`, async () => {
    const f=fixture(); try {
      dispatched(f);
      const review=reviewerRun(f,{status:'finished',released:true,completion:{eventId:'review-fault',taskId:f.taskId,runId:'review-run',status:'changes_required',head,summary:'Fix source',reviewText:'Exact unpublished findings'}});
      const publication={hash:sha(reviewPublicationBody(f.task(),review,'changes_required',review.completion!.reviewText!))};
      f.store.setMeta(`reviewPublication:${review.id}`,publication);
      const recovery=unreleasedRecoveryRun(f,{eventId:'cannot',taskId:f.taskId,runId:'stale-recovery',status:'blocked',summary:'Mismatch needs owner revision',coordinatorGeneration:1,coordinatorAction:{verb:'cannot',reason:'Body mismatch'}});
      if(shape==='unknown')f.store.putRun({...recovery,status:'uncertain'});
      if(shape==='unobservable')f.observations.delete('coord-agent');
      if(shape==='active')f.observations.set('coord-agent',{...f.observations.get('coord-agent')!,status:'running',active:true});
      if(shape==='permission')f.observations.set('coord-agent',{...f.observations.get('coord-agent')!,permissions:true});
      f.store.update(f.taskId,{holds:{dispatch:{owner:CALLER,reason:'Retain hold',at:new Date().toISOString(),generation:1,until:null}}});
      const before=f.task(), runBefore=f.store.run(recovery.id);
      // Round 4 (review #544): a dispatch hold no longer refuses the publication retry (it is recorded); the retained run still does.
      assert.ok(f.views('retry_effect').some(view=>!view.available&&view.refusal?.includes('changes_required')&&view.refusal.includes('retained run')));
      // A matching busy or permission-waiting coordinator is displaced; missing
      // observations, unknown delivery and races still refuse.
      const displaces=shape.startsWith('idle')||['active','permission'].includes(shape);
      if(displaces)assert.ok(f.views('move').some(view=>view.available&&view.args?.to==='work'),'next permits the move');
      const observe=f.adapter.observe.bind(f.adapter);
      f.adapter.observe=async id=>{
        const state=await observe(id);
        if(shape==='version-race')f.store.update(f.taskId,{reason:'Concurrent owner update'});
        if(shape==='run-race')f.store.putRun({...recovery,completion:{...recovery.completion!,summary:'Concurrent callback change'}});
        return state;
      };
      let sends=0;f.adapter.sendRun=async()=>{sends++};
      const invoke=()=>f.engine.moveToWork({taskId:f.taskId,version:before.version,reason:'Owner chooses revision',instruction:shape==='idle-findings'?undefined:'Fix source and integrate main',caller:CALLER});
      if(displaces){
        const result=await invoke();
        assert.deepEqual(f.stops,['active','permission'].includes(shape)?['coord-agent']:[],'only a busy coordinator turn is cancelled');
        assert.equal(result.phase,'changes_requested');
        assert.equal(result.resolution.pendingWorkerInstruction,shape==='idle-findings'?'Exact unpublished findings':'Fix source and integrate main');
        assert.deepEqual(result.holds,before.holds);
        assert.equal(f.store.run(recovery.id)!.released,true);
        assert.deepEqual(f.store.run(review.id)!.completion,review.completion);
        assert.deepEqual(f.store.getMeta(`reviewPublication:${review.id}`),publication,'uncertain publication remains evidence, without credit');
        assert.ok(f.events('recovery_episode_superseded').some(event=>event.detail.includes('Mismatch needs owner revision')));
        await f.engine.wake();assert.equal(sends,0,'held revision records intent without a native send');
      }else{
        await assert.rejects(invoke());
        assert.deepEqual(f.stops, [], 'a refused observation or intent cancels nothing');
        assert.equal(f.events('owner_stop_intent').length, 0);
        assert.equal(f.store.run(recovery.id)!.released,false);
        if(!shape.endsWith('race')){assert.deepEqual(f.task(),before);assert.deepEqual(f.store.run(recovery.id),runBefore);}
      }
    }finally{await f.close()}
  });
}

// Round 4 (Tom, 2026-10-19): `stop` halts live work and parks the task; verbs
// refuse only for a durable side effect, and every refusal is recorded outside
// the task's history.
const stopControl = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) =>
  f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'stop', taskId: f.taskId, version: f.task().version, reason: 'Owner wants to redirect', caller: CALLER, ...extra }));

test('stop cancels a live reviewer turn and parks the task under an owner dispatch hold; move then carries on', async () => {
  const f = fixture(); try {
    dispatched(f);
    for (const id of ['worker-agent', 'review-agent'])
      f.observations.set(id, { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    reviewerRun(f, { active: true });
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    const view = f.view('stop');
    assert.equal(view.available, true, view.refusal);
    assert.deepEqual(view.fill, ['reason']);
    const stopped = await stopControl(f);
    assert.deepEqual(f.stops, ['review-agent']);
    assert.ok(stopped.holds?.dispatch, 'an owner dispatch hold parks the task');
    assert.match(stopped.holds!.dispatch!.reason, /^Owner stop: Owner wants to redirect/);
    assert.equal(f.store.run('review-run')!.released, false, 'run state is left for restart or move');
    assert.equal(f.events('owner_stopped').length, 1);
    assert.equal(f.events('owner_control').length, 1);
    assert.ok(f.next().verbs.some(entry => entry.verb === 'release' || entry.action === 'release') || f.next().stop?.kind === 'hold');
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'work', taskId: f.taskId, version: f.task().version, reason: 'Back to the author', caller: CALLER }));
    assert.equal(moved.phase, 'changes_requested');
    assert.equal(f.store.run('review-run')!.released, true);
    assert.deepEqual(f.stops, ['review-agent'], 'the idle reviewer needed no second cancellation');
  } finally { await f.close(); }
});

test('owner stop restart of a revision is deferred under the hold and released through the retained worker', async () => {
  const f = fixture(); try {
    dispatched(f, { phase: 'changes_requested', completion: null, prUrl: null, prHead: null });
    const revision = runSchema.parse({ id: 'revision-run', taskId: f.taskId, role: 'revision', generation: 1, head, base,
      agentId: 'worker-agent', workspaceId: 'workspace', profile: workerProfile, status: 'running',
      createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null,
      completion: null, released: false });
    f.store.putRun(revision);
    f.store.setCredential(revision.id, 'revision-token');
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, currentRunId: revision.id } });
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    await stopControl(f, { role: 'worker' });
    const restarted = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'restart', taskId: f.taskId,
      version: f.task().version, role: 'worker', reason: 'Continue the revision', instruction: 'Keep the current revision work', caller: CALLER }));
    assert.ok(restarted.holds?.dispatch);
    assert.equal(restarted.resolution.deferredVerb?.target?.runId, revision.id);
    assert.equal(f.store.run(revision.id)?.released, false);
    await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'release', taskId: f.taskId,
      version: f.task().version, kind: 'dispatch', caller: CALLER }));
    assert.equal(f.store.run(revision.id)?.released, true, 'restart settles the stopped revision through the existing path');
    assert.equal(f.task().agentId, 'worker-agent', 'the continuation keeps the retained worker');
    assert.equal(f.task().resolution.deferredVerb, null);
    assert.equal(f.events('owner_verb_applied').length, 1, JSON.stringify(f.events('deferred_verb_refused').map(event => event.detail)));
  } finally { await f.close(); }
});

test('owner stop restart of a reviewer waits for release before applying the retained reviewer path', async () => {
  const f = fixture(); try {
    dispatched(f);
    reviewerRun(f, { active: false });
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    await stopControl(f, { role: 'reviewer' });
    const restarted = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'restart', taskId: f.taskId,
      version: f.task().version, role: 'reviewer', reason: 'Continue the review', instruction: 'Finish the current review', caller: CALLER }));
    assert.ok(restarted.holds?.dispatch);
    assert.equal(restarted.resolution.deferredVerb?.target?.runId, 'review-run');
    assert.equal(f.store.run('review-run')?.released, false);
    await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'release', taskId: f.taskId,
      version: f.task().version, kind: 'dispatch', caller: CALLER }));
    assert.equal(f.task().resolution.deferredVerb, null);
    assert.equal(f.events('owner_verb_applied').length, 1);
    assert.deepEqual(f.stops, [], 'the idle reviewer was not cancelled a second time');
  } finally { await f.close(); }
});

test('stop cancels the initial worker, which has no run row', async () => {
  const f = fixture(); try {
    dispatched(f, { phase: 'working', completion: null, prUrl: null, prHead: null });
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    const stopped = await stopControl(f, { role: 'worker' });
    assert.deepEqual(f.stops, ['worker-agent']);
    assert.ok(stopped.holds?.dispatch);
    assert.equal(stopped.agentId, 'worker-agent', 'the worker identity is kept for restart');
    // Parked: reconciliation starts nothing on the held task — no coordinator, reminder or send.
    let sends = 0; f.adapter.sendRun = async () => { sends++; };
    for (let pass = 0; pass < 3; pass++) await f.engine.wake();
    assert.equal(sends, 0);
    assert.equal(f.store.runs(f.taskId).length, 0, 'no run was started');
    assert.ok(f.task().holds?.dispatch, 'the hold stands');
    assert.equal(f.task().resolution.recoveryActive, false);
  } finally { await f.close(); }
});

test('stop applies while Queue is paused, keeps an existing dispatch hold and cancels nothing that is idle', async () => {
  const f = fixture(); try {
    dispatched(f);
    for (const id of ['worker-agent', 'review-agent'])
      f.observations.set(id, { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    reviewerRun(f, { active: false });
    f.store.setMeta('paused', true);
    f.store.update(f.taskId, { holds: { dispatch: { owner: 'operator', reason: 'Earlier hold', at: new Date().toISOString(), generation: 1, until: null } }, held: true, holdGeneration: 1 });
    const stopped = await stopControl(f);
    assert.deepEqual(f.stops, [], 'an idle reviewer has no turn to cancel');
    assert.equal(stopped.holds!.dispatch!.reason, 'Earlier hold', 'the existing hold stands');
    assert.equal(f.events('owner_stopped').length, 1);
  } finally { await f.close(); }
});

test('stop refuses a run with unknown delivery, changing nothing; the refusal is recorded outside task history', async () => {
  const f = fixture(); try {
    dispatched(f);
    const run = unreleasedRecoveryRun(f, null, true);
    f.store.putRun({ ...run, status: 'uncertain' });
    const before = f.task();
    const eventsBefore = f.store.eventsAll(f.taskId).length;
    assert.equal(f.view('stop').available, false);
    await assert.rejects(stopControl(f), /holds a durable side effect Queue will not act over blindly \(run-delivery stale-recovery is uncertain:/);
    assert.deepEqual(f.task(), before);
    assert.deepEqual(f.stops, []);
    assert.equal(f.store.eventsAll(f.taskId).length, eventsBefore, 'a refusal writes no task event');
    const refusals = f.store.verbOutcomes('1970-01-01T00:00:00.000Z');
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0]!.outcome, 'refused');
    assert.equal(refusals[0]!.source, 'owner');
    assert.equal(refusals[0]!.action, 'stop');
    assert.equal(refusals[0]!.taskId, f.taskId);
    assert.equal(refusals[0]!.detail.caller, CALLER);
    assert.match(String(refusals[0]!.detail.reason), /run-delivery stale-recovery is uncertain/);
  } finally { await f.close(); }
});

test('stop is refused for finished work and a cancellation that cannot be confirmed refuses the verb for a retry', async () => {
  const f = fixture(); try {
    dispatched(f);
    for (const id of ['worker-agent', 'review-agent'])
      f.observations.set(id, { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    reviewerRun(f, { active: true });
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    (f.adapter as unknown as { stopAgentTurn: (id: string) => Promise<void> }).stopAgentTurn = async () => { throw new Error('daemon unreachable'); };
    await assert.rejects(stopControl(f), /could not stop the live reviewer run \(review-run\): daemon unreachable; retry the same verb/);
    assert.equal(f.events('owner_stop_uncertain').length, 1);
    assert.equal(f.task().holds?.dispatch, undefined, 'nothing was parked');
    f.store.update(f.taskId, { phase: 'done' });
    assert.equal(f.view('stop').available, false);
    assert.match(f.view('stop').refusal!, /stop applies to unfinished work/);
  } finally { await f.close(); }
});

// Independent review of PR #533 (Sol): regressions.
for (const to of ['work', 'review'] as const) test(`move ${to} fences a reviewer whose delivery is unknown, cancelling nothing (review #533)`, async () => {
  const f = fixture(); try {
    dispatched(f);
    reviewerRun(f, { status: 'uncertain' });
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    assert.equal(f.views('move')[to === 'work' ? 0 : 1].available, false);
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to, taskId: f.taskId, version: f.task().version, reason: 'Redirect', caller: CALLER })), /durable side effect .*run-delivery review-run is uncertain/);
    assert.deepEqual(f.stops, []);
  } finally { await f.close(); }
});

test('a move whose task changed during its checks cancels nothing (review #533)', async () => {
  const f = fixture(); try {
    dispatched(f);
    reviewerRun(f);
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    f.adapter.verifyPr = async () => {
      f.store.update(f.taskId, { reason: 'Concurrent owner update' });
      return f.remote.pr;
    };
    await assert.rejects(moveControl(f, 'Redirect'), /Task changed/);
    assert.deepEqual(f.stops, [], 'a refused move stops no live work');
  } finally { await f.close(); }
});

test('a stopped reviewer replaced by the move is replaced, not released (review #533; planner ruling 2026-11-09)', async () => {
  const f = fixture(); try {
    dispatched(f);
    const run = reviewerRun(f);
    // Idle with no saved coverage: the move is the explicit fresh review and the
    // old lease is marked replaced. Under the 2026-11-09 ruling the replaced run
    // keeps its credential until the review settles, so a late verdict whose
    // first-verdict claim holds is readopted rather than refused.
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    const moved = await moveControl(f, 'Fresh review');
    assert.deepEqual(f.stops, []);
    assert.equal(f.store.run(run.id)!.released, false);
    assert.equal(f.store.run(run.id)!.status, 'superseded');
    assert.notEqual(f.store.run(run.id)!.replacedAt, undefined);
    assert.equal(moved.resolution.currentRunId, null);
    assert.equal(f.events('owner_control').length, 1);
  } finally { await f.close(); }
});

// Independent review of PR #533, second pass (Sol): a callback landing while the
// cancellation RPC is in flight must not leave a refused move that stopped work.
// Only `work` cancels a live reviewer turn now: `review` preserves a reading
// reviewer (Tom, 2026-10-27), so it has no cancellation to race.
for (const to of ['work'] as const) test(`a callback during move ${to} cancellation re-plans the move instead of refusing it (review #533)`, async () => {
  const f = fixture(); try {
    dispatched(f);
    const run = reviewerRun(f);
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    const originalStop = f.adapter.stopAgentTurn!;
    f.adapter.stopAgentTurn = async (agentId: string) => {
      await f.engine.complete({ taskId: f.taskId, runId: run.id, eventId: 'during-stop', status: 'changes_required', head, summary: 'Findings', reviewText: 'Fix it', reviewResponsibility: 'author' } as never, 'token');
      await originalStop.call(f.adapter, agentId);
    };
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to, taskId: f.taskId, version: f.task().version, reason: 'Redirect', caller: CALLER }));
    assert.equal(moved.phase, to === 'work' ? 'changes_requested' : 'awaiting_review', 'the move applied after re-planning');
    assert.deepEqual(f.stops, ['review-agent'], 'one cancellation, no second');
    assert.equal(f.store.run(run.id)!.released, true);
  } finally { await f.close(); }
});

// Independent review, third pass.
for (const to of ['work'] as const) test(`review #533 (third pass): move ${to} replan fences new uncertain delivery`, async () => {
  const f = fixture(); try {
    dispatched(f);
    const run = reviewerRun(f);
    f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    const stop = f.adapter.stopAgentTurn!;
    f.adapter.stopAgentTurn = async id => {
      f.store.putRun({ ...run, status: 'uncertain' });
      f.store.update(f.taskId, { reason: 'New uncertain delivery during cancellation' });
      await stop.call(f.adapter, id);
    };
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to, taskId: f.taskId, version: f.task().version, reason: 'Redirect', caller: CALLER })), /durable side effect.*run-delivery review-run is uncertain/);
    assert.deepEqual(f.stops, ['review-agent']);
    assert.equal(f.store.run(run.id)!.released, false);
    assert.equal(f.events('owner_move_replanned').length, 1);
  } finally { await f.close(); }
});

// Round 4, PR 2: the owner's next move or restart supersedes their own stop;
// any other dispatch hold stands.
test('the owner stop hold is released by the owner next move, but an ordinary hold stays', async () => {
  for (const kind of ['owner stop', 'ordinary hold'] as const) {
    const f = fixture(); try {
      dispatched(f);
      for (const id of ['worker-agent', 'review-agent'])
        f.observations.set(id, { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
      reviewerRun(f, { active: false });
      if (kind === 'owner stop') await stopControl(f);
      else await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'hold', kind: 'dispatch', taskId: f.taskId, version: f.task().version, reason: 'Operator hold' }));
      assert.ok(holdsOf(f.task()).dispatch, kind);
      // Let the hold control's scheduled reconciliation settle before reading the version.
      await new Promise(resolve => setImmediate(resolve));
      const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'work', taskId: f.taskId, version: f.task().version, reason: 'Back to the author', caller: CALLER }));
      assert.equal(moved.phase, 'changes_requested', kind);
      if (kind === 'owner stop') assert.equal(holdsOf(f.task()).dispatch, undefined, 'the stop hold is released by the next verb');
      else assert.equal(holdsOf(f.task()).dispatch?.reason, 'Operator hold', 'an ordinary hold stands; dispatch waits for its release');
    } finally { await f.close(); }
  }
});

test('a merge hold does not keep the owner stop hold from releasing on the owner next move (review #534)', async () => {
  const f = fixture(); try {
    dispatched(f);
    for (const id of ['worker-agent', 'review-agent'])
      f.observations.set(id, { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    reviewerRun(f, { active: false });
    await stopControl(f);
    await new Promise(resolve => setImmediate(resolve));
    await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'hold', kind: 'merge', taskId: f.taskId, version: f.task().version, reason: 'Owner reads the merge first' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(holdsOf(f.task()).dispatch && holdsOf(f.task()).merge);
    await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'work', taskId: f.taskId, version: f.task().version, reason: 'Back to the author', caller: CALLER }));
    assert.equal(holdsOf(f.task()).dispatch, undefined, 'the stop hold is released');
    assert.equal(holdsOf(f.task()).merge?.reason, 'Owner reads the merge first', 'the merge hold stands');
  } finally { await f.close(); }
});

test('replay context does not leak: a direct owner call during another task replay is still an owner call (review #534)', async () => {
  const f = fixture(); try {
    const engine = f.engine as unknown as { isOwnerCall(): boolean; replayingDeferredVerb: { run<T>(value: true, fn: () => T): T } };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let insideReplay: boolean | null = null;
    const replay = engine.replayingDeferredVerb.run(true, async () => { await gate; insideReplay = engine.isOwnerCall(); });
    assert.equal(engine.isOwnerCall(), true, 'a call outside the suspended replay is an owner call');
    release();
    await replay;
    assert.equal(insideReplay, false, 'inside the replay it is not');
  } finally { await f.close(); }
});

test('next lists an uncertain retry_effect task-control operation as a retryable effect', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, { phase: 'needs_attention', workspaceIntent: true,
      reason: 'Workspace creation is uncertain; host process listing could not prove completion' });
    const control = taskControlInputSchema.parse({ action: 'retry_effect', taskId: f.taskId,
      version: f.task().version, effect: 'workspace_creation', reason: 'Retry workspace creation', caller: CALLER });
    const { key, payload } = taskControlOperation(control), id = operationIdForKey(key);
    f.store.putOperation(queueOperationSchema.parse({ id, key, kind: 'task_control', inputHash: operationInputHash(payload),
      state: 'needs_attention', taskId: f.taskId, expectedVersion: control.version, repoPath: null, submissionId: null,
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), settledAt: new Date().toISOString(), attempts: 1,
      diagnostic: 'Workspace creation is uncertain; host process listing could not prove completion', result: null,
      effect: { kind: 'task_control', target: 'retry_effect', intentAt: new Date().toISOString(), status: 'uncertain', result: null, resultAt: null } }), payload);
    const retry = f.next().verbs.filter(item => item.verb === 'retry_effect' && item.available);
    assert.ok(retry.some(item => JSON.stringify(item.args).includes(`task_control_operation.${id}`)));
  } finally { await f.close(); }
});

test('next lists and retry_effect reconciles an exact reviewer delivery message', async () => {
  const f=fixture(); try {
    dispatched(f);
    const deliveryId=`ns-review-${'c'.repeat(64)}`;
    const run=reviewerRun(f,{reviewDeliveries:[{deliveryId,authorizationId:'auth-1',operationId:'op-1',taskId:f.taskId,runId:'review-run',head,
      checkpointOrdinal:1,taskVersion:f.task().version,briefVersion:null,briefDigest:null,reason:'continue',instruction:'go',createdAt:new Date().toISOString(),
      status:'uncertain',evidence:'delivery response was lost',observedAt:null}]});
    const offered=f.next().verbs.find(item=>item.verb==='retry_effect'&&item.available&&JSON.stringify(item.args).includes(`review-delivery.${deliveryId}`));
    assert.ok(offered,'the shared blocking-effect identity appears in next');
    f.timelineEntries.push({timestamp:new Date().toISOString(),item:{type:'user_message',messageId:deliveryId}});
    await f.engine.performTaskControl(taskControlInputSchema.parse({action:'retry_effect',taskId:f.taskId,version:f.task().version,
      effect:`review-delivery.${deliveryId}`,reason:'Observe the original reviewer delivery',caller:CALLER}));
    assert.equal(f.store.run(run.id)?.reviewDeliveries?.[0]?.status,'delivered');
  } finally { await f.close(); }
});

test('next lists and retry_effect reconciles an exact uncertain run creation', async () => {
  const f=fixture(); try {
    dispatched(f);
    const run=reviewerRun(f,{status:'uncertain'});
    const offered=f.next().verbs.find(item=>item.verb==='retry_effect'&&item.available&&JSON.stringify(item.args).includes(`run-delivery.${run.id}`));
    assert.ok(offered,'the shared blocking-effect identity appears in next');
    f.timelineEntries.push({timestamp:new Date().toISOString(),item:{type:'user_message',messageId:`ns-run-${run.id}`}});
    await f.engine.performTaskControl(taskControlInputSchema.parse({action:'retry_effect',taskId:f.taskId,version:f.task().version,
      effect:`run-delivery.${run.id}`,reason:'Observe the original run creation',caller:CALLER}));
    assert.equal(f.store.run(run.id)?.status,'running');
  } finally { await f.close(); }
});

test('next lists and retry_effect reconciles an exact attention notice message', async () => {
  const f=fixture(); try {
    const id='attention-notice-1';
    f.store.putNotice({id,taskId:f.taskId,agentId:'origin',recipientAgentId:'origin',workspaceId:null,sources:[],originEntry:true,
      kind:'attention',status:'uncertain',error:'reply was lost',text:'Queue needs attention'});
    const offered=f.next().verbs.find(item=>item.verb==='retry_effect'&&item.available&&JSON.stringify(item.args).includes(`attention-notice.${id}`));
    assert.ok(offered,'the shared blocking-effect identity appears in next');
    f.timelineEntries.push({timestamp:new Date().toISOString(),item:{type:'user_message',messageId:id}});
    await f.engine.performTaskControl(taskControlInputSchema.parse({action:'retry_effect',taskId:f.taskId,version:f.task().version,
      effect:`attention-notice.${id}`,reason:'Observe the original notice delivery',caller:CALLER}));
    assert.equal(f.store.notices(f.taskId).find(item=>item.id===id)?.status,'delivered');
  } finally { await f.close(); }
});

test('next lists and retry_effect re-observes an uncertain merge response', async () => {
  const f=fixture(); try {
    dispatched(f,{phase:'merging',resolution:{...f.task().resolution,mergeIntent:true,mergeHead:head,mergeBase:'main',mergeResponseOutcome:'uncertain'}});
    f.adapter.merged=async()=>({merged:true,head,base:'main',commit:'c'.repeat(40)});
    const offered=f.next().verbs.find(item=>item.verb==='retry_effect'&&item.available&&item.args?.effect==='merge-response.merge-response');
    assert.ok(offered,'the shared blocking-effect identity appears in next');
    await f.engine.performTaskControl(taskControlInputSchema.parse({action:'retry_effect',taskId:f.taskId,version:f.task().version,
      effect:'merge-response.merge-response',reason:'Observe the recorded merge response',caller:CALLER}));
    assert.equal(f.task().resolution.mergedCommit,'c'.repeat(40));
    assert.equal(f.task().resolution.mergeResponseOutcome,'uncertain','the exact observed merge commit settles the blocking projection');
  } finally { await f.close(); }
});

test('next lists and retry_effect resumes a held project validation', async () => {
  const f=fixture(); try {
    const held={argv:['effigy','check'],digest:'d'.repeat(64),exitCode:null,durationMs:0,outputTail:'Capacity wait expired',base,head,
      state:'hold' as const,queueBuild:'',settingsRevision:0,pid:null,capacityWait:null,capacityUnavailable:true,resubmissionRequired:true};
    dispatched(f,{phase:'needs_attention',reason:'Project validation was held',resolution:{...f.task().resolution,attention:true,projectValidation:held}});
    const offered=f.next().verbs.find(item=>item.verb==='retry_effect'&&item.available&&item.args?.effect==='project-validation.project-validation');
    assert.ok(offered,'the shared blocking-effect identity appears in next');
    await f.engine.performTaskControl(taskControlInputSchema.parse({action:'retry_effect',taskId:f.taskId,version:f.task().version,
      effect:'project-validation.project-validation',reason:'Resume the held validation',caller:CALLER}));
    assert.equal(f.task().resolution.projectValidation,null);
  } finally { await f.close(); }
});

test('a refused validation at the current PR head is retryable through next', async () => {
  const f=fixture(); try {
    const refused={argv:['effigy','check'],digest:'d'.repeat(64),exitCode:1,durationMs:10,outputTail:'failed',base,head,
      state:'refused' as const,queueBuild:'',settingsRevision:0,pid:null,capacityWait:null,capacityUnavailable:false};
    dispatched(f,{phase:'needs_attention',reason:'Project validation refused',resolution:{...f.task().resolution,attention:true,projectValidation:refused}});
    const offered=f.next().verbs.find(item=>item.verb==='retry_effect'&&item.available&&item.args?.effect==='project-validation.project-validation');
    assert.ok(offered,'the current refused result is an actionable retry');
    await f.engine.performTaskControl(taskControlInputSchema.parse({action:'retry_effect',taskId:f.taskId,version:f.task().version,
      effect:'project-validation.project-validation',reason:'Retry validation after fixing the failure',caller:CALLER}));
    assert.equal(f.task().resolution.projectValidation,null);
  } finally { await f.close(); }
});

test('a refused validation for an older PR head is settled and not offered for retry', async () => {
  const f=fixture(); try {
    const refused={argv:['effigy','check'],digest:'d'.repeat(64),exitCode:1,durationMs:10,outputTail:'failed',base,head,
      state:'refused' as const,queueBuild:'',settingsRevision:0,pid:null,capacityWait:null,capacityUnavailable:false};
    dispatched(f,{prHead:'c'.repeat(40),phase:'reviewing',resolution:{...f.task().resolution,projectValidation:refused}});
    assert.equal(f.next().verbs.some(item=>item.verb==='retry_effect'&&item.args?.effect==='project-validation.project-validation'),false);
    assert.equal(ownerPendingEffects(f.facts()).some(item=>item.effect==='project-validation.project-validation'),false);
  } finally { await f.close(); }
});

test('next does not offer a retry for a live current-head validation', async () => {
  const f=fixture(); try {
    const running={argv:['effigy','check'],digest:'d'.repeat(64),exitCode:null,durationMs:0,outputTail:'',base,head,
      state:'running' as const,queueBuild:'',settingsRevision:0,pid:process.pid,capacityWait:null,capacityUnavailable:false};
    dispatched(f,{phase:'reviewing',resolution:{...f.task().resolution,projectValidation:running}});
    assert.equal(f.next().verbs.some(item=>item.verb==='retry_effect'&&item.args?.effect==='project-validation.project-validation'),false);
  } finally { await f.close(); }
});

test('retry_effect does not report an invalid projected hook as settled', async () => {
  const f=fixture(); try {
    const eventId='invalid-hook-event', at=new Date().toISOString();
    f.store.putHookEvent(hookRecordSchema.parse({id:'invalid-hook-record',taskId:f.taskId,hookId:'policy',event:'task.pre_dispatch',eventId,
      occurrence:1,mode:'read_only',delivery:'required',state:'result',manifest:{path:'.paseo/queue.json',commit:base,digest:`sha256:${'a'.repeat(64)}`},
      program:{kind:'repository',executable:{path:'.paseo/hooks/policy',commit:base,digest:`sha256:${'b'.repeat(64)}`},argv:[]},instruction:null,
      baseBranch:'main',baseCommit:base,attempt:1,timeoutMs:30_000,maxOutputBytes:65_536,allowedPaths:[],commitSubject:null,eventDigest:'c'.repeat(64),
      eventPayload:null,workspace:null,processId:null,result:{schema:'paseo.queue.hook-result.v1',eventId,outcome:'blocked',summary:'contradictory terminal state',
        metadata:{},changedPaths:[],commitSubjectSuffix:null},commit:null,remote:null,summary:'',error:'',createdAt:at,updatedAt:at,reconciledAt:null}));
    const effect=`hook.${eventId}`;
    assert.ok(f.next().verbs.find(item=>item.verb==='retry_effect'&&item.available&&item.args?.effect===effect));
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({action:'retry_effect',taskId:f.taskId,version:f.task().version,
      effect,reason:'Reconcile the recorded hook result',caller:CALLER})),/hook invalid-hook-event remains invalid/);
    assert.ok(ownerPendingEffects(f.facts()).some(item=>item.effect===effect&&item.kind==='recovery_effect'),
      'an unresolved projection remains visible after the handler refuses to claim settlement');
  } finally { await f.close(); }
});

test('publication retry excludes its reporting run but fences other retained runs', async () => {
 const f=fixture(); try {
  dispatched(f);
  f.store.putRepository({path:'/repo',origin:null},null,'',null,{login:'reviewer'});
  const review=reviewerRun(f,{status:'finished',released:true,completion:{eventId:'unpublished-self',taskId:f.taskId,
   runId:'review-run',status:'ready_to_merge',head,summary:'Approved',reviewText:'Findings'}});
  f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(review.completion!.eventId,f.taskId,review.id,sha(JSON.stringify(review.completion)),JSON.stringify({accepted:true}));
  f.store.setMeta(`reviewPublication:${review.id}`,{hash:sha(reviewPublicationBody(f.task(),review,'ready_to_merge','Findings'))});
  const recovery=unreleasedRecoveryRun(f,null,true);
  f.observations.set('worker-agent',{id:'worker-agent',workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''});
  f.observations.set('review-agent',{id:'review-agent',workspaceId:'workspace',status:'idle',active:false,permissions:false,error:''});
  f.adapter.reconcileReviewPublication=async(_store,_task,_run,_reviewer,_reason,allowed)=>{assert.ok(allowed());return 42};
  const effect=`review_publication.${review.id}`;
  f.store.setCredential(recovery.id,'recovery-token');
  const view=()=>f.engine.recoveryTaskNextFromAgent({taskId:f.taskId,runId:recovery.id,token:'recovery-token'}).verbs.find(v=>v.verb==='retry_effect'&&v.args?.effect===effect);
  assert.ok(view()?.available);
  const extra=runSchema.parse({...recovery,id:'other-recovery',agentId:'other'});f.store.putRun(extra);
  assert.ok(f.engine.recoveryTaskNextFromAgent({taskId:f.taskId,runId:recovery.id,token:'recovery-token'}).verbs.some(v=>v.verb==='retry_effect'&&!v.available&&v.refusal?.includes(effect)));
  await assert.rejects(f.engine.resolution.reconcileReviewPublication(f.task(),review.id,'retry',recovery.id),/retained thread/);
  f.store.putRun({...extra,released:true});
  await f.engine.resolution.reconcileReviewPublication(f.task(),review.id,'retry',recovery.id);
  assert.equal(f.store.run(review.id)?.completion?.reviewId,42);
 } finally { await f.close() }
});

test('next refuses an unsupported publication record instead of offering a retry that cannot act', async () => {
  const f=fixture(); try {
    const run=reviewerRun(f,{status:'finished',released:true,completion:{eventId:'unpublished-record',taskId:f.taskId,runId:'review-run',
      status:'ready_to_merge',head,summary:'Approved',reviewText:'Exact approved findings'}});
    f.store.setMeta(`reviewPublication:${run.id}`,{hash:'d'.repeat(64)});
    f.store.update(f.taskId,{phase:'needs_attention',reason:'Publication intent needs inspection',
      resolution:{...f.task().resolution,attention:true}});
    const effect=`review_publication.${run.id}`;
    assert.ok(f.next().verbs.find(item=>item.verb==='retry_effect'&&!item.available&&item.refusal?.includes(effect)));
    const invoke=()=>f.engine.performTaskControl(taskControlInputSchema.parse({action:'retry_effect',taskId:f.taskId,version:f.task().version,
      effect,reason:'Observe the recorded publication',caller:CALLER}));
    await assert.rejects(invoke(),/Formal publication recovery is unavailable/);
    assert.ok(ownerPendingEffects(f.facts()).some(item=>item.effect===effect&&item.kind==='recovery_effect'),
      'the unsupported publication remains listed instead of being reported as settled');
  } finally { await f.close(); }
});

test('move to merge settles a stale uncertain retry_effect operation it supersedes', async () => {
  const f = fixture(); try {
    dispatched(f);
    f.store.update(f.taskId, { resolution: { ...f.task().resolution,
      review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-9', status: 'ready_to_merge', summary: 'Approved', head, reviewId: 19 } } });
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    const control = taskControlInputSchema.parse({ action: 'retry_effect', taskId: f.taskId,
      version: f.task().version, effect: 'workspace_creation', reason: 'Old retry', caller: CALLER });
    const { key, payload } = taskControlOperation(control), id = operationIdForKey(key), at = new Date().toISOString();
    f.store.putOperation(queueOperationSchema.parse({ id, key, kind: 'task_control', inputHash: operationInputHash(payload),
      state: 'needs_attention', taskId: f.taskId, expectedVersion: control.version, repoPath: null, submissionId: null,
      createdAt: at, startedAt: at, settledAt: at, attempts: 1, diagnostic: 'Old workspace creation uncertainty', result: null,
      effect: { kind: 'task_control', target: 'retry_effect', intentAt: at, status: 'uncertain', result: null, resultAt: null } }), payload);
    const moved = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'merge', taskId: f.taskId,
      version: f.task().version, reason: 'Approved head is ready to merge', caller: CALLER }));
    assert.equal(moved.phase, 'verifying');
    assert.equal(f.store.operation(id)?.state, 'succeeded');
    assert.match(f.store.operation(id)?.effect?.result ?? '', /Superseded by an owner control/);
  } finally { await f.close(); }
});

test('retry_effect settles an uncertain retry operation after its named effect is already absent', async () => {
  const f = fixture(); try {
    const control = taskControlInputSchema.parse({ action: 'retry_effect', taskId: f.taskId,
      version: f.task().version, effect: 'workspace_creation', reason: 'Old retry', caller: CALLER });
    const { key, payload } = taskControlOperation(control), id = operationIdForKey(key), at = new Date().toISOString();
    f.store.putOperation(queueOperationSchema.parse({ id, key, kind: 'task_control', inputHash: operationInputHash(payload),
      state: 'needs_attention', taskId: f.taskId, expectedVersion: control.version, repoPath: null, submissionId: null,
      createdAt: at, startedAt: at, settledAt: at, attempts: 1, diagnostic: 'Old workspace creation uncertainty', result: null,
      effect: { kind: 'task_control', target: 'retry_effect', intentAt: at, status: 'uncertain', result: null, resultAt: null } }), payload);
    const settled = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'retry_effect', taskId: f.taskId,
      version: f.task().version, effect: `task_control_operation.${id}`, reason: 'Recheck the old operation', caller: CALLER }));
    assert.equal(settled.id, f.taskId);
    assert.equal(f.store.operation(id)?.state, 'succeeded');
    assert.match(f.store.operation(id)?.effect?.result ?? '', /workspace_creation is no longer pending/);
  } finally { await f.close(); }
});

test('a merge lease records a wait naming the blocking retry operation and diagnostic', async () => {
  const f = fixture(); try {
    f.store.update(f.taskId, { phase: 'merging', reason: 'Waiting to merge' });
    const control = taskControlInputSchema.parse({ action: 'retry_effect', taskId: f.taskId,
      version: f.task().version, effect: 'workspace_creation', reason: 'Old retry', caller: CALLER });
    const { key, payload } = taskControlOperation(control), id = operationIdForKey(key), at = new Date().toISOString();
    f.store.putOperation(queueOperationSchema.parse({ id, key, kind: 'task_control', inputHash: operationInputHash(payload),
      state: 'needs_attention', taskId: f.taskId, expectedVersion: control.version, repoPath: null, submissionId: null,
      createdAt: at, startedAt: at, settledAt: at, attempts: 1, diagnostic: 'Workspace creation remains uncertain', result: null,
      effect: { kind: 'task_control', target: 'retry_effect', intentAt: at, status: 'uncertain', result: null, resultAt: null } }), payload);
    const execution = f.engine.resolution as unknown as { executionLease(task: Task): Promise<boolean> };
    assert.equal(await execution.executionLease(f.task()), false);
    assert.match(f.task().reason, new RegExp(id));
    assert.match(f.task().reason, /Workspace creation remains uncertain/);
  } finally { await f.close(); }
});
