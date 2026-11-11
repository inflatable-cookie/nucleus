import { fakeAdapter } from './support/fakes';
import { profile as sharedProfile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { holdPatch } from '../core/merge/merge-hold';
import {
  reviewCheckpointPathFor, writeReviewCheckpoint,
  REVIEW_AGENT_CLOSED, REVIEW_AUTHORIZATION_REQUIRED, REVIEW_BUDGET_EXHAUSTED,
} from '../core/review/review-continuation';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import {
  REVIEW_CONTINUATION_LIMIT, runSchema, submissionSchema, taskControlInputSchema, taskNextSchema,
  type Profile, type Run, type Task, type TaskNextVerb,
} from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';

/**
 * Spec 050 reconciliation of a checkpointed reviewer whose own agent is
 * positively observed closed. A closed Paseo session can never receive a
 * same-run continuation, so Queue records the terminal observation, keeps the
 * lease, checkpoints and head as evidence, tells the truth in `next`, and
 * offers the existing fresh-review recovery. Nothing is launched from the
 * observation or the read, and the owner's own verb settles the run.
 *
 * The applied verbs are the real `restart`/`move` paths and the reconciliation
 * is the real task quantum; only the adapter, the clock and the checkpoint
 * receipt are fixtures.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40), otherHead = 'c'.repeat(40);
const CALLER = 'owner-thread';

type Role = 'worker' | 'reviewer' | 'coordinator';
const profile = (id: string, model: string, roles: Role[]): Profile => sharedProfile(id, model);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-closed-reviewer-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const worker = profile('worker', 'test/worker', ['worker']);
  const reviewer = profile('reviewer', 'test/reviewer', ['reviewer']);
  const coord = profile('coord', 'test/coord', ['coordinator']);
  const all = [worker, reviewer, coord];
  store.setMeta('pool', all.map(item => ({ profileId: item.id, enabled: true, group: item.id,
    roles: [item.id === 'reviewer' ? 'reviewer' : item.id === 'coord' ? 'coordinator' : 'worker'], weight: 1, scopes: ['general'] })));
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Closed reviewer', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);

  const observations = new Map<string, AgentObservation>();
  const idle = (id: string, model?: string, workspaceId = 'workspace') =>
    observations.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '', provider: 'test', model });
  idle('worker-agent', worker.model);
  idle('review-agent', reviewer.model);
  idle('coord-agent', coord.model);
  const observeCalls: string[] = [];
  let observeHook: ((id: string) => void | Promise<void>) | null = null;
  const continuations: { runId: string; messageId: string }[] = [];
  const createdRuns: Run[] = [];
  const createdRunTokens = new Map<string, string>();
  const adapter = fakeAdapter({
    profiles: async () => all,
    validate: async () => base,
    verifyWorkspace: async () => {},
    createWorkspace: async () => { throw new Error('fixtures do not create workspaces'); },
    createAgent: async () => { throw new Error('fixtures do not create agents'); },
    observe: async (id: string) => {
      observeCalls.push(id);
      if (observeHook) await observeHook(id);
      return observations.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' };
    },
     notify: async () => {},
    findRunAgents: async () => [],
    verifyPr: async () => ({ head: store.task(submitted.id).prHead ?? head, url: store.task(submitted.id).prUrl ?? 'https://github.com/example/repo/pull/7' }),
    verifyPrIdentity: async () => ({ head: store.task(submitted.id).prHead ?? head, url: store.task(submitted.id).prUrl ?? 'https://github.com/example/repo/pull/7' }),
    verifyCleanQueueWorktree: async () => {}, verifyResume: async () => {}, verifyReview: async () => 12345, publishReview: async () => 12345,
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base, verifyCloseout: async () => {},
    createRun: async (_t: Task, r: Run, token: string) => {
      createdRuns.push(r); createdRunTokens.set(r.id, token);
      const id = `agent-${r.id}`;
      observations.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '', provider: r.profile?.provider, model: r.profile?.model });
      return { id, workspaceId: r.workspaceId };
    },
    sendRun: async (_t: Task, r: Run, token: string) => {
      createdRuns.push(r); createdRunTokens.set(r.id, token);
      if (r.agentId) observations.set(r.agentId, { ...observations.get(r.agentId)!, active: true, status: 'running' });
    },
    // A same-run reviewer continuation is exactly the delivery this fix must
    // never make to a closed reviewer: the fixture records every attempt.
    continueReviewer: async (_t: Task, r: Run, messageId: string) => {
      const state = observations.get(r.agentId!);
      if (!state || state.status !== 'idle' || state.active || state.permissions) return { sent: false as const, reason: `reviewer ${state?.status ?? 'unknown'}` };
      continuations.push({ runId: r.id, messageId });
      return { sent: true as const };
    },
    stopAgentTurn: async (id: string) => { const state = observations.get(id); if (state) { state.active = false; state.status = 'idle'; } },
  } as unknown as Adapter);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = all;
  const current = () => store.task(submitted.id);
  const control = (args: Record<string, unknown> = {}) => engine.performTaskControl(taskControlInputSchema.parse({
    taskId: submitted.id, version: current().version, action: 'restart', reason: 'Owner restart', caller: CALLER, ...args,
  }));
  const events = (kind: string) => store.eventsAll(submitted.id).filter(event => event.kind === kind);
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, current())));
  const restartView = (taskNext = next()): TaskNextVerb => taskNext.verbs.find(view => view.verb === 'restart')!;
  const close = async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); };
  return {
    dir, store, engine, adapter, profiles: { worker, reviewer, coord }, taskId: submitted.id,
    current, control, events, next, restartView, observations, observeCalls, createdRuns, createdRunTokens, continuations, close,
    setObserveHook: (hook: ((id: string) => void | Promise<void>) | null) => { observeHook = hook; },
  };
}

/** A reviewing task holding one authenticated reviewer checkpoint at the exact head. */
function checkpointedReview(f: ReturnType<typeof fixture>, runId = 'checkpoint-run', eventId = 'ckpt-1') {
  f.store.update(f.taskId, {
    phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
    prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'ready-1', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
  });
  f.store.putRun(runSchema.parse({
    id: runId, taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
    profile: f.profiles.reviewer, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
  }));
  const run = f.store.run(runId)!;
  const checkpoint = { covered: ['The diff'], remaining: ['The proofs'] };
  const callback = { eventId, taskId: f.taskId, runId: run.id, status: 'review_in_progress', summary: 'Reading budget exhausted', head, checkpoint };
  const callbackDigest = digest(JSON.stringify(callback)), checkpointDigest = digest(JSON.stringify(checkpoint));
  const record = { ordinal: 1, checkpoint, head, at: new Date().toISOString(), runId: run.id,
    path: reviewCheckpointPathFor(f.store, f.taskId, run.id, 1), eventId, callbackDigest, checkpointDigest };
  const response = { accepted: true, eventId, checkpoint: { ordinal: 1, budget: REVIEW_CONTINUATION_LIMIT, continued: false, attention: REVIEW_AUTHORIZATION_REQUIRED, checkpointDigest } };
  f.store.setCredential(run.id, 'token');
  f.store.transaction(() => {
    writeReviewCheckpoint(f.store, f.taskId, record);
    f.store.putRun({ ...run, reviewCheckpoints: [record] });
    f.store.update(f.taskId, { reason: REVIEW_AUTHORIZATION_REQUIRED });
    f.store.event(f.taskId, 'review_checkpoint', `1/${REVIEW_CONTINUATION_LIMIT} ${eventId} run ${run.id} at ${head}`);
    f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(eventId, f.taskId, run.id, callbackDigest, JSON.stringify(response));
  });
  f.store.update(f.taskId, { resolution: { ...f.current().resolution, currentRunId: run.id, reviewerAgentId: run.agentId, reviewerProfile: run.profile } });
  return f.store.run(runId)!;
}

const closeReviewer = (f: ReturnType<typeof fixture>) =>
  f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'closed', active: false, permissions: false, error: '', provider: 'test', model: f.profiles.reviewer.model });

const terminalEvents = (f: ReturnType<typeof fixture>) => f.events('reviewer_agent_closed');

test('a positively closed checkpointed reviewer is reconciled in place and next offers the fresh-review recovery', async () => {
  const f = fixture(); try {
    const run = checkpointedReview(f);
    const checkpoint = structuredClone(run.reviewCheckpoints![0]);
    const bytes = readFileSync(checkpoint.path, 'utf8');
    closeReviewer(f);
    // `next` is a read: it never observes, writes or launches.
    const versionBefore = f.current().version, runsBefore = JSON.stringify(f.store.runs(f.taskId));
    assert.deepEqual(f.next().verbs.find(view => view.verb === 'restart')!.args, { action: 'restart', taskId: f.taskId, version: versionBefore, role: 'reviewer' });
    assert.deepEqual(f.next(), f.next());
    assert.equal(f.current().version, versionBefore, 'reading next writes nothing');
    assert.equal(JSON.stringify(f.store.runs(f.taskId)), runsBefore);
    assert.equal(f.createdRuns.length, 0);
    assert.deepEqual(f.observeCalls, [], 'next performs no live read');

    await f.engine.wake();
    await f.engine.quiesce();

    // The terminal observation is durable and the run's lease, history and head are untouched.
    const reconciled = f.store.run(run.id)!;
    assert.ok(reconciled.retainedAgentClosedAt, 'the positive closed observation is recorded');
    assert.equal(reconciled.released, false, 'no lease was released and no verdict can be lost');
    assert.equal(reconciled.completion, null);
    assert.equal(reconciled.status, 'running', 'the durable run status is untouched');
    assert.equal(reconciled.agentId, 'review-agent');
    assert.equal(reconciled.workspaceId, 'workspace');
    assert.equal(reconciled.head, head);
    assert.deepEqual(reconciled.reviewCheckpoints, run.reviewCheckpoints, 'the checkpoint history is unchanged');
    assert.equal(readFileSync(checkpoint.path, 'utf8'), bytes, 'the checkpoint file is never rewritten');
    assert.equal(f.current().prHead, head);
    assert.equal(f.current().resolution.currentRunId, run.id);
    const credential = f.store.db.prepare('SELECT run FROM credentials WHERE run=?').get(run.id);
    assert.ok(credential, 'the reviewer keeps its authenticated callback identity');
    const [event] = terminalEvents(f);
    assert.equal(terminalEvents(f).length, 1);
    assert.deepEqual(JSON.parse(event.detail), {
      runId: run.id, agentId: 'review-agent', workspaceId: 'workspace', head, checkpointOrdinal: 1,
      observedAt: JSON.parse(event.detail).observedAt,
    });

    // No replacement reviewer and no same-run delivery was started by the observation.
    assert.equal(f.createdRuns.length, 0, 'the reconciliation launches nothing');
    assert.deepEqual(f.continuations, [], 'no continuation was sent to the closed reviewer');
    assert.equal(f.current().phase, 'reviewing');

    // `next` now tells the truth with the exact lease identity and offers the supported path.
    const next = f.next();
    assert.match(next.stop!.detail, /observed closed/);
    assert.match(next.stop!.detail, new RegExp(run.id));
    assert.match(next.stop!.detail, /checkpoint 1 at a{40}/);
    const restart = f.restartView(next);
    assert.equal(restart.available, true, JSON.stringify(restart));
    assert.deepEqual(restart.args, { action: 'restart', taskId: f.taskId, version: f.current().version, role: 'reviewer', fresh: true });
    assert.ok(restart.note && /fresh reviewer/.test(restart.note), 'the view explains the fresh recovery');
    // Tom, 2026-10-27: move to=review preserves the reader it can continue, so a
    // closed reader is replaced deliberately with the fresh restart the view
    // offers; the move names that exit instead of silently replacing the reader.
    const reviewMove = next.verbs.find(view => view.verb === 'move' && !view.available && /^move review: /.test(view.refusal ?? ''));
    assert.ok(reviewMove, JSON.stringify(next.verbs.filter(view => view.verb === 'move')));
    assert.match(reviewMove!.refusal!, /preserves a reader it can continue, and this one cannot:[\s\S]*restart role=reviewer fresh/);

    // The same-agent continuation is refused before any send, with the honest reason.
    await assert.rejects(f.control({ role: 'reviewer' }), /observed closed[\s\S]*restart role=reviewer fresh/);
    assert.deepEqual(f.continuations, []);
    assert.equal(f.store.run(run.id)!.released, false);
  } finally { await f.close(); }
});

test('a late authenticated verdict wins the terminal observation race and the reconciliation writes nothing', async () => {
  const f = fixture(); try {
    const run = checkpointedReview(f);
    closeReviewer(f);
    // The verdict lands while the reconciliation is still at its observation.
    // The audit pass also reads the reader for Queue's own continuation check
    // (it sees it closed and stands aside); that read is not the race under test.
    f.setObserveHook(async id => {
      if (id !== 'review-agent' || !new Error().stack?.includes('reconcileClosedRetainedReviewer')) return;
      f.setObserveHook(null);
      await f.engine.complete({ eventId: 'late-verdict', taskId: f.taskId, runId: run.id, status: 'changes_required',
        summary: 'One finding', head, reviewResponsibility: 'author', reviewText: 'Address the retry guard.' } as never, 'token');
    });
    await f.engine.wake();
    await f.engine.wake();
    await f.engine.quiesce();
    assert.equal(f.store.run(run.id)!.retainedAgentClosedAt, undefined, 'the superseded observation is not recorded');
    assert.deepEqual(terminalEvents(f), []);
    assert.equal(f.current().phase, 'changes_requested', 'the authenticated verdict still advanced the task');
    assert.equal(f.current().resolution.review?.summary, 'One finding');
    assert.equal(f.store.run(run.id)!.completion?.status, 'changes_required');
    assert.deepEqual(f.createdRuns.filter(run => run.role === 'reviewer'), [], 'no reviewer was launched over the verdict');
    assert.equal(f.createdRuns.at(-1)?.role, 'revision', 'the accepted finding returns to the author');
  } finally { await f.close(); }
});

for (const variant of ['unavailable', 'active', 'permission', 'idle', 'error', 'other workspace', 'other agent'] as const) {
  test(`a ${variant} observation leaves the continuation fence exactly as it was`, async () => {
    const f = fixture(); try {
      const run = checkpointedReview(f);
      if (variant === 'unavailable') f.setObserveHook(id => { if (id === 'review-agent') throw new Error('unknown native observation'); });
      else {
        const state = f.observations.get('review-agent')!;
        f.observations.set('review-agent', variant === 'other workspace' ? { ...state, status: 'closed', workspaceId: 'other-workspace' }
          : variant === 'other agent' ? { ...state, status: 'closed', id: 'someone-else' }
            : variant === 'active' ? { ...state, status: 'closed', active: true }
              : variant === 'permission' ? { ...state, status: 'closed', permissions: true }
                : { ...state, status: variant });
      }
      await f.engine.wake();
      await f.engine.quiesce();
      assert.equal(f.store.run(run.id)!.retainedAgentClosedAt, undefined, `${variant}: no terminal observation is recorded`);
      assert.deepEqual(terminalEvents(f), [], variant);
      if (variant === 'idle') {
        // An idle reader is the one Queue continues itself (Tom, 2026-10-31): one
        // same-run delivery, still no terminal observation and no launch.
        assert.deepEqual(f.continuations.map(item => item.runId), [run.id], 'idle: Queue continued the same reader once');
        assert.deepEqual(f.createdRuns, [], 'idle: nothing is launched');
        return;
      }
      assert.equal(f.current().reason, REVIEW_AUTHORIZATION_REQUIRED, `${variant}: the checkpoint stop stands`);
      assert.deepEqual(f.continuations, [], `${variant}: nothing is continued`);
      const restart = f.restartView();
      if (variant === 'unavailable' || variant === 'other workspace' || variant === 'other agent') {
        assert.equal(f.current().resolution.incident?.status, 'reconciling');
        assert.equal(f.current().resolution.incident?.runId, run.id);
        assert.equal(restart.available, false, JSON.stringify(restart));
        assert.match(restart.refusal!, /Automatic reconciliation still owns the task incident/);
        await assert.rejects(f.control({ role: 'reviewer' }), /Reviewer continuation refused before send: An unresolved task incident or recovery fence blocks reviewer continuation/);
        assert.equal(f.current().resolution.currentRunId, run.id);
        assert.equal(f.store.run(run.id)!.released, false);
        assert.doesNotThrow(() => f.store.authenticate(run.id, 'token'));
      } else {
        assert.equal(restart.available, true, JSON.stringify(restart));
        assert.equal((restart.args as Record<string, unknown>).fresh, undefined, `${variant}: the same-agent continuation stays offered`);
      }
      assert.deepEqual(f.createdRuns, [], `${variant}: nothing is launched`);
    } finally { await f.close(); }
  });
}

test('an exhausted checkpoint budget keeps its own stop and offers the fresh recovery', async () => {
  const f = fixture(); try {
    const run = checkpointedReview(f);
    f.store.putRun({ ...f.store.run(run.id)!, reviewBudgetExhaustedAt: new Date().toISOString() });
    f.engine.resolution.waiting(f.current(), REVIEW_BUDGET_EXHAUSTED, 'operator_needed');
    const stop = structuredClone(f.current().resolution.stop);
    closeReviewer(f);
    await f.engine.wake();
    await f.engine.quiesce();
    assert.equal(f.store.run(run.id)!.retainedAgentClosedAt, undefined, 'the owner stop already owns this reviewer');
    assert.deepEqual(terminalEvents(f), []);
    assert.deepEqual(f.current().resolution.stop, stop, 'the exhausted-budget stop is preserved verbatim');
    assert.equal(f.current().reason, REVIEW_BUDGET_EXHAUSTED);
    const restart = f.restartView();
    assert.deepEqual(restart.args, { action: 'restart', taskId: f.taskId, version: f.current().version, role: 'reviewer', fresh: true },
      'the spent budget recovers with a fresh reviewer, exactly as its own stop says');
    assert.equal(f.createdRuns.length, 0);
  } finally { await f.close(); }
});

test('a held task keeps its hold stop and records no terminal observation', async () => {
  const f = fixture(); try {
    const run = checkpointedReview(f);
    f.store.update(f.taskId, holdPatch(f.current(), 'dispatch', 'operator', 'Wait for staging'));
    closeReviewer(f);
    await f.engine.wake();
    await f.engine.quiesce();
    assert.equal(f.store.run(run.id)!.retainedAgentClosedAt, undefined);
    assert.deepEqual(terminalEvents(f), []);
    const next = f.next();
    assert.equal(next.stop!.kind, 'hold');
    assert.equal(next.stop!.reason, 'held');
    assert.match(next.stop!.detail, /Wait for staging/);
  } finally { await f.close(); }
});

test('a stale version or a moved head refuses the derived controls without changing the task', async () => {
  const f = fixture(); try {
    const run = checkpointedReview(f);
    closeReviewer(f);
    await f.engine.wake();
    await f.engine.quiesce();
    const stale = f.restartView().args as Record<string, unknown>;
    const before = f.current();
    // Any later change to the task invalidates the view's derived version.
    f.store.update(f.taskId, { reason: 'An unrelated later write' });
    const afterWrite = f.current();
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'restart', taskId: f.taskId, version: stale.version, role: 'reviewer', fresh: true, reason: 'Stale restart', caller: CALLER,
    })), /Task changed; refresh before restarting/);
    assert.equal(f.current().version, afterWrite.version, 'the refused stale control changed nothing');
    assert.equal(f.current().phase, before.phase);
    assert.equal(f.events('owner_control').length, 0);
    assert.deepEqual(f.createdRuns, []);
    assert.equal(f.store.run(run.id)!.released, false);

    // A moved recorded head refuses the same-run continuation at its exact-head gate.
    const g = fixture(); try {
      const gRun = checkpointedReview(g);
      g.store.update(g.taskId, { prHead: otherHead });
      await assert.rejects(g.control({ role: 'reviewer' }), /Reviewer continuation must remain on the exact recorded PR head/);
      assert.equal(g.store.run(gRun.id)!.released, false);
      assert.deepEqual(g.continuations, []);
      assert.equal(g.events('owner_control').length, 0);
    } finally { await g.close(); }
  } finally { await f.close(); }
});

test('one supported owner recovery settles the closed run and a real fresh reviewer advances the task', async () => {
  const f = fixture(); try {
    const run = checkpointedReview(f);
    closeReviewer(f);
    await f.engine.wake();
    await f.engine.quiesce();
    const restart = f.restartView();
    assert.equal((restart.args as Record<string, unknown>).fresh, true);
    // Apply exactly the derived control, adding only the reason `fill` names.
    const task = await f.engine.performTaskControl(taskControlInputSchema.parse({
      ...(restart.args as Record<string, unknown>), action: 'restart', reason: 'The reviewer closed; start a fresh review at the same head', caller: CALLER,
    }));
    assert.equal(task.phase, 'awaiting_review');
    assert.equal(task.resolution.currentRunId, null);
    assert.equal(task.resolution.reviewerAgentId, null);
    const settled = f.store.run(run.id)!;
    assert.equal(settled.released, true);
    assert.equal(settled.status, 'superseded');
    assert.equal(settled.completion, null, 'the recovery never invents a verdict');
    assert.deepEqual(settled.reviewCheckpoints, run.reviewCheckpoints, 'the closed reviewer keeps its saved progress as history');
    assert.ok(settled.retainedAgentClosedAt, 'the terminal observation stays as audit evidence');
    assert.equal(f.events('owner_control').length, 1);
    assert.deepEqual(f.continuations, [], 'no same-run continuation was ever delivered');
    assert.equal((settled.reviewDeliveries ?? []).length, 0, 'no duplicate delivery intent exists');

    await f.engine.wake();
    await f.engine.quiesce();
    const fresh = f.createdRuns.find(candidate => candidate.role === 'reviewer');
    assert.ok(fresh, 'the owner recovery launched one fresh reviewer');
    assert.equal(f.createdRuns.filter(candidate => candidate.role === 'reviewer').length, 1);
    assert.notEqual(fresh!.id, run.id);
    assert.notEqual(f.store.run(fresh!.id)!.agentId, 'review-agent', 'the fresh reviewer is a new agent');
    assert.equal(fresh!.head, head);
    assert.equal(fresh!.workspaceId, 'workspace');
    assert.equal(f.current().prUrl, 'https://github.com/example/repo/pull/7');
    // The fresh reviewer's turn ends, then its own authenticated verdict advances the task.
    const freshAgent = f.store.run(fresh!.id)!.agentId!;
    f.observations.set(freshAgent, { ...f.observations.get(freshAgent)!, status: 'idle', active: false });
    const token = f.createdRunTokens.get(fresh!.id)!;
    await f.engine.complete({ eventId: 'fresh-verdict', taskId: f.taskId, runId: fresh!.id, status: 'changes_required',
      summary: 'One finding', head, reviewResponsibility: 'author', reviewText: 'Address the retry guard.' } as never, token);
    await f.engine.wake();
    await f.engine.wake();
    await f.engine.quiesce();
    assert.equal(f.current().phase, 'changes_requested');
    assert.equal(f.current().resolution.review?.runId, fresh!.id);
    assert.equal(f.events('owner_control').length, 1, 'the whole recovery was one owner control');
  } finally { await f.close(); }
});

test('an archived reviewer with proven absent dispatch is reconciled before one fresh reviewer starts', async () => {
  const f = fixture(); try {
    const run = checkpointedReview(f);
    f.store.putRun({ ...run, status: 'uncertain', active: false, reviewCheckpoints: [] });
    const task = f.current();
    f.store.update(task.id, { reason: 'Prompt delivery is uncertain; inspect the retained thread before retrying' });
    Object.assign(f.adapter, {
      originAgent: async (id: string) => ({ id, workspaceId: 'workspace', title: 'Reviewer', archived: id === 'review-agent' }),
      agentTimelinePage: async () => ({ entries: [], hasOlder: false, gap: false }),
    });
    const restart = f.restartView();
    assert.equal(restart.available, true);
    assert.match(restart.note ?? '', /reconcile the uncertain dispatch/);
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      ...(restart.args as Record<string, unknown>), action: 'restart', reason: 'Reconcile the archived reviewer and restart', caller: CALLER,
    }));
    const settled = f.store.run(run.id)!;
    assert.equal(settled.status, 'superseded');
    assert.equal(settled.released, true);
    assert.match(f.events('run_delivery_not_delivered')[0]!.detail, /archived; complete readable timeline has no ns-run-checkpoint-run/);
    assert.equal(f.current().resolution.currentRunId, null);
    await f.engine.wake();
    await f.engine.quiesce();
    assert.equal(f.createdRuns.filter(candidate => candidate.role === 'reviewer').length, 1);
    assert.notEqual(f.store.run(f.createdRuns.find(candidate => candidate.role === 'reviewer')!.id)!.agentId, 'review-agent');
  } finally { await f.close(); }
});

test('an archived reviewer timeline containing its dispatch keeps the unknown-delivery fence', async () => {
  const f = fixture(); try {
    const run = checkpointedReview(f);
    f.store.putRun({ ...run, status: 'uncertain', active: false, reviewCheckpoints: [] });
    f.store.update(f.taskId, { reason: 'Prompt delivery is uncertain; inspect the retained thread before retrying' });
    Object.assign(f.adapter, {
      originAgent: async (id: string) => ({ id, workspaceId: 'workspace', title: 'Reviewer', archived: true }),
      agentTimelinePage: async () => ({ entries: [{ timestamp: new Date().toISOString(), item: { type: 'user_message', messageId: 'ns-run-checkpoint-run' } }], hasOlder: false, gap: false }),
    });
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'restart', role: 'reviewer', fresh: true, taskId: f.taskId, version: f.current().version,
      reason: 'Inspect archived reviewer delivery', caller: CALLER,
    })), /timeline contains ns-run-checkpoint-run/);
    assert.equal(f.store.run(run.id)!.status, 'uncertain');
    assert.equal(f.store.run(run.id)!.released, false);
    assert.equal(f.events('run_delivery_not_delivered').length, 0);
    assert.deepEqual(f.createdRuns, []);
  } finally { await f.close(); }
});

test('a closed checkpointed reviewer is replaced only by the deliberate fresh restart', async () => {
  const f = fixture(); try {
    const run = checkpointedReview(f);
    closeReviewer(f);
    await f.engine.wake();
    await f.engine.quiesce();
    const review = f.next().verbs.find(view => view.verb === 'move' && !view.available && /^move review: /.test(view.refusal ?? ''));
    assert.ok(review, 'move to=review cannot continue a closed reader and says so');
    assert.match(review!.refusal!, /preserves a reader it can continue, and this one cannot:[\s\S]*restart role=reviewer fresh/);
    // The applied control refuses the same way, before anything is replaced.
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'move', to: 'review', taskId: f.taskId, version: f.current().version, reason: 'The reviewer closed; start a fresh review', caller: CALLER,
    })), /preserves a reader it can continue[\s\S]*restart role=reviewer fresh/);
    assert.equal(f.store.run(run.id)!.released, false, 'the closed reader keeps its checkpoint and lease');
    assert.equal(f.current().resolution.currentRunId, run.id);

    // The deliberate fresh restart is the supported replacement.
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      action: 'restart', role: 'reviewer', fresh: true, taskId: f.taskId, version: f.current().version, reason: 'Replace the closed reviewer', caller: CALLER,
    }));
    assert.equal(f.current().phase, 'awaiting_review');
    assert.deepEqual(f.continuations, []);
    await f.engine.wake();
    await f.engine.quiesce();
    assert.equal(f.createdRuns.filter(candidate => candidate.role === 'reviewer').length, 1, 'exactly one fresh reviewer starts');
  } finally { await f.close(); }
});
