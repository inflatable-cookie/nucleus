/**
 * A consumer task (2026-11-10): a reviewer run was superseded and never released
 * while the planner archived its agent's thread. Observation read the archive as
 * neither closed nor gone, so the run kept its claim; the task kept naming it,
 * and `restart`, a fresh restart and a fresh `move` each returned success while
 * starting no reader — the unreleased run fenced the launch behind
 * "Assigned thread is serving another request".
 *
 * These tests reproduce that exact shape: two reviewer runs on one retained
 * agent, the earlier superseded and unreleased, the later superseded and
 * released at the same head (so the retained thread is the eligible one), and
 * the agent archived on its host.
 *
 * - Observation releases the archived run under the same proof the ordinary
 *   archive path accepts, and the run is never chosen for relaunch again.
 * - The fresh `restart` and the fresh `move` release it and launch one reader;
 *   a superseded run is never a relaunch target, so the same-agent restart
 *   refuses and the view offers the fresh recovery instead.
 * - While the thread's archive cannot be proven, a verb whose launch is fenced
 *   says so in its reply, and `next` shows the same reason.
 * - An archive proof settles the thread's liveness, never an unsettled
 *   authenticated delivery: that run keeps its callback authority.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { runSchema, submissionSchema, taskControlInputSchema, taskNextSchema, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const CALLER = 'owner-thread';
const REVIEWER_AGENT = 'review-agent';

const profile = (id: string, model: string): Profile =>
  ({ id, name: id, provider: 'test', model, notes: '', available: true, problem: '', supportedThinking: [] });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-superseded-archived-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const worker = profile('worker', 'test/worker'), reviewer = profile('reviewer', 'test/reviewer');
  const all = [worker, reviewer];
  store.setMeta('pool', all.map(item => ({ profileId: item.id, enabled: true, group: item.id,
    roles: [item.id === 'reviewer' ? 'reviewer' : 'worker'], weight: 1, scopes: ['general'] })));
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Superseded reviewer', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const observations = new Map<string, AgentObservation>();
  const idle = (id: string, model?: string) =>
    observations.set(id, { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model });
  idle('worker-agent', worker.model);
  idle(REVIEWER_AGENT, reviewer.model);
  const archived = new Set<string>();
  const createdRuns: Run[] = [];
  const adapter = {
    profiles: async () => all, validate: async () => base, verifyWorkspace: async () => {},
    createWorkspace: async () => { throw new Error('fixtures do not create workspaces'); },
    findWorkspaces: async () => [], findAgents: async () => [],
    createAgent: async () => { throw new Error('fixtures do not create agents'); },
    // An archived Paseo thread stays readable; the archive is the host's own answer.
    observe: async (id: string) => {
      const state = observations.get(id);
      if (!state) throw new Error('Agent was not found');
      return state;
    },
    originAgent: async (id: string) => ({ id, workspaceId: 'workspace', title: id, archived: archived.has(id) }),
    archiveAgent: async (id: string) => { archived.add(id); },
    notify: async () => {}, findRunAgents: async () => [],
    verifyPr: async () => ({ head, url: 'https://github.com/example/repo/pull/7' }),
    verifyPrIdentity: async () => ({ head, url: 'https://github.com/example/repo/pull/7' }),
    verifyCleanQueueWorktree: async () => {}, verifyResume: async () => {}, verifyReview: async () => 12345, publishReview: async () => 12345,
    coveringEvidence: async () => ({ head, base, wait: '' }), authorCommentEvidence: async () => '',
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {},
    createRun: async (_t: Task, r: Run) => {
      createdRuns.push(r);
      idle(`agent-${r.id}`);
      observations.set(`agent-${r.id}`, { ...observations.get(`agent-${r.id}`)!, status: 'running', active: true, model: r.profile?.model });
      return { id: `agent-${r.id}`, workspaceId: r.workspaceId };
    },
    sendRun: async (_t: Task, r: Run) => {
      createdRuns.push(r);
      if (r.agentId) observations.set(r.agentId, { ...observations.get(r.agentId)!, active: true, status: 'running' });
    },
    continueReviewer: async () => ({ sent: false as const, reason: 'reviewer archived' }),
    stopAgentTurn: async (id: string) => { const state = observations.get(id); if (state) { state.active = false; state.status = 'idle'; } },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = all;
  const current = () => store.task(submitted.id);
  const control = (args: Record<string, unknown>) => engine.performTaskControl(taskControlInputSchema.parse({
    taskId: submitted.id, version: current().version, reason: 'Owner control', caller: CALLER, ...args,
  }));
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, current())));
  const reviewerRuns = () => store.runs(submitted.id).filter(run => run.role === 'reviewer');
  const settle = async () => { await engine.wake(); await engine.quiesce(); };
  return {
    dir, store, engine, adapter, taskId: submitted.id, profiles: { worker, reviewer },
    current, control, next, reviewerRuns, settle, observations, archived, createdRuns,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Run times stay relative to now: a hardcoded past timestamp becomes the task's wall-clock budget basis. */
const runTime = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const run = (taskId: string, id: string, createdAt: string, changes: Partial<Run>): Run => runSchema.parse({
  id, taskId, role: 'reviewer', generation: 1, head, base, agentId: REVIEWER_AGENT, workspaceId: 'workspace',
  profile: null, status: 'superseded', createdAt, lastObservedAt: null, active: false, idleSince: null,
  completion: null, released: false, ...changes,
});

/** One authenticated delivery still unsettled on a run: the fence an archive proof never settles. */
const pendingDelivery = (taskId: string, runId: string) => ({
  authorizationId: 'auth-1', operationId: 'op-1', deliveryId: `ns-review-${'f'.repeat(64)}`, taskId, runId, head,
  checkpointOrdinal: 1, taskVersion: 3, briefVersion: null, briefDigest: null,
  reason: 'Continue the review', instruction: 'Read the remaining items', createdAt: runTime(3),
  status: 'uncertain' as const, evidence: '', observedAt: null,
});

/**
 * The recorded incident shape: the earlier reviewer run is superseded and never
 * released, the later one on the same thread is superseded and released at the
 * same head, and the task still names that agent as its retained reviewer.
 */
function archivedSupersededReviewer(f: ReturnType<typeof fixture>) {
  f.store.update(f.taskId, {
    phase: 'awaiting_review', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
    prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-1', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    reason: 'Reviewer run stale-review stopped without a delivered dispatch (its timeline carries no dispatch message); the callback reminder is skipped and the run needs its ordinary relaunch',
  });
  f.store.putRun(run(f.taskId, 'stale-review', runTime(2), { profile: f.profiles.reviewer }));
  f.store.putRun(run(f.taskId, 'settled-review', runTime(1), { profile: f.profiles.reviewer, released: true }));
  f.store.update(f.taskId, { resolution: { ...f.current().resolution, reviewerAgentId: REVIEWER_AGENT, reviewerProfile: f.profiles.reviewer } });
  f.archived.add(REVIEWER_AGENT);
  return f.store.run('stale-review')!;
}

const newReviewers = (f: ReturnType<typeof fixture>) =>
  f.createdRuns.filter(candidate => candidate.role === 'reviewer' && candidate.id !== 'stale-review' && candidate.id !== 'settled-review');

/** The stale run is released as history and one new reviewer is launched. */
function assertReleasedAndRelaunched(f: ReturnType<typeof fixture>) {
  const stale = f.store.run('stale-review')!;
  assert.equal(stale.released, true, 'the archived superseded run is released');
  assert.equal(stale.status, 'superseded');
  assert.equal(stale.completion, null, 'the release invents no verdict');
  assert.ok(!newReviewers(f).some(candidate => candidate.id === 'stale-review'), 'the released run is never chosen for relaunch');
  const launched = newReviewers(f);
  assert.equal(launched.length, 1, `exactly one new reviewer launched: ${JSON.stringify(f.reviewerRuns().map(r => [r.id, r.status, r.released]))}`);
  assert.equal(launched[0]!.head, head, 'the new reviewer reads the same exact head');
  assert.notEqual(f.store.run(launched[0]!.id)!.agentId, REVIEWER_AGENT, 'the archived thread is never reused');
  assert.equal(f.current().phase, 'reviewing');
}

test('observation releases a superseded reviewer whose thread the host archived, and the same pass relaunches review', async () => {
  const f = fixture(); try {
    archivedSupersededReviewer(f);
    await f.settle();
    assertReleasedAndRelaunched(f);
    const release = f.store.eventsAll(f.taskId).find(event => event.kind === 'run_released_from_observed_liveness')!;
    assert.ok(release, 'the release is recorded as observed liveness');
    assert.match(release.detail, /stale-review: its thread is archived or gone on its host/);
  } finally { await f.close(); }
});

for (const [verb, args] of [
  ['restart', { action: 'restart' }],
  ['restart', { action: 'restart', role: 'reviewer' }],
  ['fresh restart', { action: 'restart', role: 'reviewer', fresh: true }],
  ['fresh move', { action: 'move', to: 'review', fresh: true }],
] as const) {
  test(`a ${verb} on the archived superseded reviewer releases it and launches one new reviewer`, async () => {
    const f = fixture(); try {
      archivedSupersededReviewer(f);
      const applied = await f.control(args);
      assert.equal(applied.phase, 'awaiting_review');
      assert.equal(newReviewers(f).length, 0, 'no reader starts inside the control itself');
      await f.settle();
      assertReleasedAndRelaunched(f);
    } finally { await f.close(); }
  });
}

test('plain restart releases the stale superseded reader and starts a new reviewer without selecting it', async () => {
  const f = fixture(); try {
    archivedSupersededReviewer(f);
    // The view offers the ordinary role restart, and that is what recovers the shape.
    const view = f.next().verbs.find(verb => verb.verb === 'restart')!;
    assert.equal(view.available, true, JSON.stringify(view));
    assert.equal((view.args as Record<string, unknown>).role, 'reviewer');
    assert.equal((view.args as Record<string, unknown>).fresh, undefined, 'the ordinary restart stays the offered path');
    const applied = await f.control({ action: 'restart', role: 'reviewer' });
    assert.equal(applied.phase, 'awaiting_review');
    assert.equal(applied.resolution.reviewerAgentId, null, 'the archived thread is never re-bound as the reader');
    assert.equal(applied.resolution.reviewerProfile?.id, 'reviewer', 'the retained reviewer route survives the dead thread');
    await f.settle();
    assertReleasedAndRelaunched(f);
    // The stale run was settled, never chosen: no reviewer run carries its id and
    // the archived agent is never the reader of the new run.
    assert.ok(!f.reviewerRuns().some(candidate => candidate.id === 'stale-review' && !candidate.released));
  } finally { await f.close(); }
});

test('a superseded reader is never a relaunch target: an ordinary restart keeps the live route, not the historical run', async () => {
  const f = fixture(); try {
    archivedSupersededReviewer(f);
    // A live thread: the retained route can carry a new reader, but the
    // superseded run itself stays history and is never re-bound or continued.
    f.archived.delete(REVIEWER_AGENT);
    const applied = await f.control({ action: 'restart', role: 'reviewer' });
    assert.equal(applied.phase, 'awaiting_review');
    assert.equal(applied.resolution.reviewerAgentId, REVIEWER_AGENT, 'the live retained route is kept');
    assert.equal(f.store.run('stale-review')!.released, true, 'the superseded lease settled as history');
    assert.equal(f.store.run('stale-review')!.completion, null);
    await f.settle();
    const launched = newReviewers(f);
    assert.equal(launched.length, 1, JSON.stringify(f.reviewerRuns().map(r => [r.id, r.status, r.released])));
    assert.equal(launched[0]!.agentId, REVIEWER_AGENT, 'the new reader runs on the retained route as its own run');
    assert.notEqual(launched[0]!.id, 'stale-review', 'the historical run is never selected for relaunch');
  } finally { await f.close(); }
});

for (const deliveryState of ['uncertain', 'reserved'] as const) {
  test(`a current superseded reviewer with a ${deliveryState} authenticated delivery is never released by any restart`, async () => {
    const f = fixture(); try {
      archivedSupersededReviewer(f);
      // The task still names the superseded run as its current reader, and that
      // run carries an unsettled authenticated delivery.
      f.store.putRun(run(f.taskId, 'stale-review', runTime(2), { profile: f.profiles.reviewer,
        reviewDeliveries: [{ ...pendingDelivery(f.taskId, 'stale-review'), status: deliveryState }] }));
      f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: 'stale-review' } });
      for (const args of [{ action: 'restart', role: 'reviewer' }, { action: 'restart', role: 'reviewer', fresh: true }]) {
        await assert.rejects(f.control(args as Record<string, unknown>), /durable side effect|authenticated delivery is pending/,
          `${String((args as Record<string, unknown>).fresh)} restart checks the current run's fence`);
        const held = f.store.run('stale-review')!;
        assert.equal(held.released, false, `the ${deliveryState} delivery keeps its callback authority`);
        assert.equal(held.reviewDeliveries?.length, 1);
        assert.equal(newReviewers(f).length, 0, 'no reviewer starts over an unsettled delivery');
        assert.equal(f.current().resolution.currentRunId, 'stale-review', 'the task keeps its current reader');
      }
      // With the delivery settled the same current run releases through the
      // restart, which starts a reader at the same head.
      f.store.putRun({ ...f.store.run('stale-review')!, reviewDeliveries: [] });
      await f.control({ action: 'restart', role: 'reviewer' });
      await f.settle();
      assert.equal(f.store.run('stale-review')!.released, true, 'the settled current run is released as history');
      assert.equal(f.store.run('stale-review')!.completion, null);
      assert.equal(newReviewers(f).length, 1, 'one reviewer starts after the delivery settles');
    } finally { await f.close(); }
  });
}

test('a fresh restart observes a current superseded reader before releasing it', async () => {
  const f = fixture(); try {
    archivedSupersededReviewer(f);
    // No archive proof here: the current superseded reader's thread is alive and
    // busy, so the fresh path must observe it before releasing anything.
    f.archived.delete(REVIEWER_AGENT);
    f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: 'stale-review' } });
    f.observations.set(REVIEWER_AGENT, { ...f.observations.get(REVIEWER_AGENT)!, status: 'running', active: true });
    await assert.rejects(f.control({ action: 'restart', role: 'reviewer', fresh: true }), /still live/);
    const held = f.store.run('stale-review')!;
    assert.equal(held.released, false, 'a busy current reader is never released by observation-free bookkeeping');
    assert.equal(held.reviewDeliveries, undefined);
    assert.equal(newReviewers(f).length, 0);
    assert.equal(f.current().resolution.currentRunId, 'stale-review');
  } finally { await f.close(); }
});

test('a verb whose launch is fenced by the retained run says so in its reply and next shows the same reason', async () => {
  const f = fixture(); try {
    archivedSupersededReviewer(f);
    // The reader holding the retained thread is live and never superseded, so no
    // settlement releases it; the settled later run keeps the thread eligible.
    f.store.putRun(run(f.taskId, 'stale-review', runTime(2), { profile: f.profiles.reviewer, status: 'running' }));
    f.archived.delete(REVIEWER_AGENT);
    const applied = await f.control({ action: 'restart', role: 'reviewer' });
    assert.equal(applied.phase, 'awaiting_review');
    assert.equal(newReviewers(f).length, 0, 'the fenced launch started no reader');
    assert.equal(f.store.run('stale-review')!.released, false, 'the retained reader keeps its lease');
    const fence = /reviewer run stale-review \(agent review-agent\) still owns the retained reviewer thread: replaced reviewer claim; observation releases it once its thread is proven archived, gone or closed/;
    assert.match(applied.reason, fence, 'the reply names the run, the rule and what releases it');
    const stop = f.next().stop;
    assert.equal(stop?.reason, 'lifecycle');
    assert.match(stop!.detail, fence, 'next shows the same reason');
    // The launch itself refuses on the same run instead of silently starting nothing.
    await f.engine.resolution.launch(f.current(), 'reviewer');
    assert.equal(newReviewers(f).length, 0, 'the launch started no reader over the run holding the thread');
    assert.match(f.next().stop!.detail, /Assigned thread is serving another request: reviewer run stale-review/);
    // The ordinary release of the retained reader settles the fence and the same
    // launch then starts the reader.
    f.store.putRun({ ...f.store.run('stale-review')!, status: 'superseded' });
    await f.settle();
    const stale = f.store.run('stale-review')!;
    assert.equal(stale.released, true, 'observation released the settled reader');
    assert.equal(newReviewers(f).length, 1, 'one reviewer launched after the fence cleared');
  } finally { await f.close(); }
});

for (const race of ['stop', 'lease change'] as const) {
  test(`an archive release is refused when a ${race} lands while the host answer is read`, async () => {
    const f = fixture(); try {
      archivedSupersededReviewer(f);
      // The mutated state lands after the host's archive answer is read but
      // before the release transaction: that stale answer must not be applied.
      const read = f.adapter.originAgent!;
      f.adapter.originAgent = async (id: string) => {
        const answer = await read(id);
        if (race === 'stop') f.store.update(f.taskId, { reason: 'Owner stop recorded while the archive read ran' });
        else f.store.putRun({ ...f.store.run('stale-review')!, status: 'running' });
        return answer;
      };
      await f.engine.resolution.observe();
      const held = f.store.run('stale-review')!;
      assert.equal(held.released, false, `the stale archive answer is not applied after a ${race}`);
      assert.ok(held.status === 'superseded' || held.status === 'running');
      assert.equal(f.store.eventsAll(f.taskId).filter(event => event.kind === 'run_released_from_observed_liveness').length, 0,
        'no release is recorded from the raced read');
      // With nothing racing the read, the same pass releases the run.
      f.adapter.originAgent = read;
      f.store.putRun({ ...f.store.run('stale-review')!, status: 'superseded' });
      await f.engine.resolution.observe();
      assert.equal(f.store.run('stale-review')!.released, true, 'the settled run releases on a clean pass');
    } finally { await f.close(); }
  });
}

test('an archive release is refused when the engine shuts down while the host answer is read', async () => {
  const f = fixture(); try {
    archivedSupersededReviewer(f);
    // The shutdown lands after the archive answer is read but before the release
    // transaction: the next pass and the next process re-observe instead.
    const read = f.adapter.originAgent!;
    f.adapter.originAgent = async (id: string) => {
      const answer = await read(id);
      f.engine.stopped = true;
      return answer;
    };
    await f.engine.resolution.observe();
    assert.equal(f.store.run('stale-review')!.released, false, 'a shutdown during the read is not permission to write');
    assert.equal(f.store.eventsAll(f.taskId).filter(event => event.kind === 'run_released_from_observed_liveness').length, 0);
    // A later pass in a live engine releases the same run.
    f.engine.stopped = false;
    f.adapter.originAgent = read;
    await f.engine.resolution.observe();
    assert.equal(f.store.run('stale-review')!.released, true, 'the settled run releases once the engine is live again');
  } finally { await f.close(); }
});

test('an archived replaced reviewer with an unsettled authenticated delivery keeps its callback authority', async () => {
  const f = fixture(); try {
    archivedSupersededReviewer(f);
    // A checkpoint keeps the ordinary replaced-idle release out of the way, so
    // only the archive release path can move this run.
    const checkpoint = { ordinal: 1, checkpoint: { covered: ['The diff'], remaining: ['The proofs'] },
      head, at: runTime(2), runId: 'stale-review', path: `${f.dir}/checkpoint.json` };
    f.store.putRun(run(f.taskId, 'stale-review', runTime(2), {
      profile: f.profiles.reviewer, replacedAt: new Date().toISOString(), reviewCheckpoints: [checkpoint],
      reviewDeliveries: [pendingDelivery(f.taskId, 'stale-review')],
    }));
    await f.settle();
    const held = f.store.run('stale-review')!;
    assert.equal(held.released, false, 'the archive proves the thread ended, not what its delivery did');
    assert.equal(held.status, 'superseded');
    assert.equal(held.reviewDeliveries?.length, 1, 'the callback authority keeps its durable delivery record');
    assert.equal(f.store.eventsAll(f.taskId).filter(event => event.kind === 'run_released_from_observed_liveness').length, 0);
    // With the delivery settled the same archived replaced run does release.
    f.store.putRun({ ...held, reviewDeliveries: [] });
    await f.settle();
    assert.equal(f.store.run('stale-review')!.released, true, 'a settled delivery leaves the archive proof to release it');
  } finally { await f.close(); }
});
