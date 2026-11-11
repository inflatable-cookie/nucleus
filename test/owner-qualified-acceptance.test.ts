import { profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from '../core/git/index';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { requiredMergeReview, reviewRequirementsWait, type FormalReviewRuntime, type ReviewerSetting } from '../core/forge/index';
import {
  completionSchema, coordinatorActionSchema, outcomeSchema, runSchema, submissionSchema, taskControlInputSchema,
  taskNextSchema, taskSchema, type Run, type Task,
} from '../shared/contracts';
import { qualifiedOwnerAcceptance } from '../shared/contracts';
import { collectOwnerVerbFacts, ownerTaskNext, qualifiedAcceptanceEligibility } from '../core/verbs/owner-verbs';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { toolTimelinePage } from './support/tool-timeline';

/**
 * Qualified owner acceptance (orchestration contract, 2026-10-17): `move
 * to=merge` records the task project's authorized owner decision at the exact
 * current PR head, separately from the immutable independent reviewer verdict,
 * and the ordinary verification, merge and closeout gates read that distinct
 * disposition without any fabricated reviewer pass. Every other gate — holds,
 * required checks, pre-merge hooks, forge identity — stays real.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);
const OWNER = 'owner-thread', OTHER = 'coordinator-thread';
const REVIEW_ID = 5553259160;


const workerProfile = profile('worker', 'test/worker'), reviewerProfile = profile('reviewer', 'test/reviewer'), coordinatorProfile = profile('coordinator', 'test/coordinator');

/** A dispatched task whose genuine independent review found changes at the current head. */
function fixture(options: { mergePipeline?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-owner-accept-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Accept me qualified', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  store.setMeta('pool', [
    { profileId: workerProfile.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewerProfile.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
    { profileId: coordinatorProfile.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const observations = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = 'workspace') => observations.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '' });
  idle('worker-agent');
  idle('review-agent');
  const remote = {
    pr: { url: 'https://github.com/example/repo/pull/902', head },
    merged: null as { head: string; commit: string } | null,
  };
  const counts = { mergeGates: 0, merges: 0, syncs: 0, reviewChecks: 0 };
  const adapter = {
    profiles: async () => [workerProfile, reviewerProfile, coordinatorProfile],
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: null, status: 'idle', active: false, permissions: false, error: '' },
    agentTimelinePage: async () => toolTimelinePage([]),
    archiveAgent: async () => {}, notify: async () => {},
    findAgents: async () => [], findRunAgents: async () => [],
    verifyWorkspace: async () => 'branch',
    findWorkspaces: async () => [],
    verifyPr: async () => remote.pr,
    verifyReview: async (_t: Task, _r: Run, c: { head: string }) => { counts.reviewChecks++; if (c.head !== remote.pr.head) throw new Error('Stale PR head'); },
    externalMerge: async (_task: Task, accept: boolean) => (accept ? remote.merged : remote.merged),
    mergeGate: options.mergePipeline ? async (t: Task) => { counts.mergeGates++; return { head: remote.pr.head, base, wait: '' }; } : undefined,
    merge: async () => { counts.merges++; },
    merged: async () => ({ merged: counts.merges > 0, commit: merged, head: remote.pr.head, base: 'main' }),
    syncMain: async () => { counts.syncs++; return merged; },
    verifyCloseout: async () => {},
    createRun: async () => { throw new Error('no dispatch is expected in these fixtures'); },
    sendRun: async () => {},
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [workerProfile, reviewerProfile, coordinatorProfile];
  const task = () => store.task(inserted.id);
  const facts = () => collectOwnerVerbFacts(store, task());
  const next = () => taskNextSchema.parse(ownerTaskNext(facts()));
  const moveViews = () => next().verbs.filter(entry => entry.verb === 'move');
  const mergeView = () => moveViews().find(view => view.args?.to === 'merge' || view.refusal?.startsWith('move merge:'))!;
  const events = (kind: string) => store.eventsAll(inserted.id).filter(event => event.kind === kind);
  const f = {
    dir, store, engine, adapter: adapter as Adapter & ResolutionAdapter, observations, remote, counts,
    taskId: inserted.id, task, facts, next, moveViews, mergeView, events, idle,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
  // Dispatched with a retained author and the PR, then the genuine review:
  // a finished released reviewer run whose changes_required verdict is published.
  store.update(inserted.id, {
    phase: 'changes_requested', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, workerModel: workerProfile.model,
    prHead: head, prUrl: remote.pr.url,
    completion: { taskId: inserted.id, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 902 },
    resolution: { ...store.task(inserted.id).resolution, revisionRuns: 7 },
  });
  reviewerRun(store, inserted.id);
  return f;
}

function reviewerRun(store: Store, taskId: string, released = true) {
  const completion = completionSchema.parse({
    eventId: 'review-cr', taskId, runId: 'review-run', status: 'changes_required',
    summary: 'The fail-fast harness ordering defect is real', head, reviewResponsibility: 'author',
    reviewText: 'Address the ordering defect.', reviewId: REVIEW_ID,
  });
  const run = runSchema.parse({
    id: 'review-run', taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
    profile: reviewerProfile, status: released ? 'finished' : 'running', createdAt: new Date().toISOString(), lastObservedAt: null,
    active: false, idleSince: null, completion: released ? completion : null, released,
  });
  store.putRun(run);
  store.setCredential(run.id, 'token');
  store.update(taskId, {
    resolution: {
      ...store.task(taskId).resolution, currentRunId: null, reviewerAgentId: 'review-agent', reviewerProfile,
      review: completion,
      reviews: [{ runId: run.id, agentId: run.agentId, head, status: 'changes_required', reviewId: REVIEW_ID, reviewCommentId: null, at: run.createdAt, verdicts: [] }],
    },
  });
  return run;
}

const accept = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) =>
  f.engine.performTaskControl(taskControlInputSchema.parse({
    taskId: f.taskId, version: f.task().version, action: 'move', to: 'merge',
    reason: 'Accepting with the harness ordering defect deferred to leadcbd546a8',
    qualification: 'The L3 fail-fast harness ordering defect is deferred to leadcbd546a8; all 4/4 author/reviewer cases pass at this head',
    caller: 'operator (board)', ...extra,
  }));

test('the contract accepts a qualification only on move to merge or closeout', () => {
  const valid = { taskId: 't', version: 1, action: 'move', to: 'merge', reason: 'r', qualification: 'q' };
  assert.equal(taskControlInputSchema.safeParse(valid).success, true);
  assert.equal(taskControlInputSchema.safeParse({ ...valid, qualification: '   ' }).success, false, 'the qualification is required text');
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'move', to: 'work', reason: 'r', instruction: 'i', qualification: 'q' }).success, false, 'no qualification on work');
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'move', to: 'review', reason: 'r', qualification: 'q' }).success, false, 'no qualification on review');
  // Closeout accepts an optional head with a qualification. The engine enforces
  // the distinct review-entry and dispatched retained-source boundaries.
  const closeout = { taskId: 't', version: 1, action: 'move', to: 'closeout', reason: 'r', qualification: 'q' };
  assert.equal(taskControlInputSchema.safeParse(closeout).success, true);
  assert.equal(taskControlInputSchema.safeParse({ ...closeout, qualification: '   ' }).success, false, 'the closeout acceptance is required text');
  assert.equal(taskControlInputSchema.safeParse({ ...closeout, head: 'a'.repeat(40) }).success, true, 'a qualified closeout may name the head being accepted');
  const { qualification: _qualification, ...unqualifiedCloseout } = closeout;
  assert.equal(taskControlInputSchema.safeParse({ ...unqualifiedCloseout, head: 'a'.repeat(40) }).success, false, 'a closeout head requires qualification');
  assert.equal(taskControlInputSchema.safeParse({ taskId: 't', version: 1, action: 'complete', reason: 'r', qualification: 'q' }).success, false, 'no qualification on complete');
  // A coordinatorAction has no acceptance field at all: the typed report cannot carry one.
  assert.equal(coordinatorActionSchema.safeParse({ verb: 'move', to: 'merge', reason: 'r', qualification: 'q' }).success, false);
});

test('next offers the acceptance with usable args over a released published verdict, and never on an ordinary approval', async () => {
  const f = fixture(); try {
    const view = f.mergeView();
    assert.equal(view.available, true, JSON.stringify(view));
    assert.deepEqual(view.args, { action: 'move', to: 'merge', taskId: f.taskId, version: f.task().version }, 'the acceptance field is owner-supplied, never derived');
    assert.deepEqual(view.fill, ['reason', 'qualification']);
    assert.equal('qualification' in (view.args ?? {}), false, 'no acceptance argument is prefilled');
    // The ordinary approval keeps the ordinary fill: no acceptance field exists there.
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-ok', status: 'ready_to_merge', summary: 'Fine', head, reviewId: 12 } } });
    const ordinary = f.mergeView();
    assert.equal(ordinary.available, true, JSON.stringify(ordinary));
    assert.deepEqual(ordinary.fill, ['reason']);
  } finally { await f.close(); }
});

test('next offers the operator source acceptance with honest missing evidence when no review binds the head', async () => {
  const f = fixture(); try {
    // No review at all: the source acceptance is available and names the gap.
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, review: null, reviews: [] } });
    const none = f.mergeView();
    assert.equal(none.available, true, JSON.stringify(none));
    assert.match(none.note!, /No reviewer verdict exists at the current PR head/);
    assert.deepEqual(f.mergeView().fill, ['reason', 'qualification']);
    assert.deepEqual(qualifiedAcceptanceEligibility(f.task(), f.store.runs(f.taskId)),
      { available: true, acceptance: 'operator_source', missingEvidence: 'No reviewer verdict exists at the current PR head', args: {} });
    // A stale verdict from an older head: history, never this head's evidence.
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-old', status: 'changes_required', summary: 'Old', head: 'e'.repeat(40), reviewId: 1 } } });
    assert.deepEqual(qualifiedAcceptanceEligibility(f.task(), f.store.runs(f.taskId)),
      { available: true, acceptance: 'operator_source', missingEvidence: 'The recorded changes_required review is at head eeeeeeeeeeee, not the current PR head', args: {} });
    // Published verdict at the current head but its reviewer run never released:
    // the interrupted reviewer is missing evidence, never review credit.
    f.store.putRun({ ...f.store.run('review-run')!, released: false, status: 'running', completion: null });
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-cr', status: 'changes_required', summary: 'Findings', head, reviewId: REVIEW_ID } } });
    assert.deepEqual(qualifiedAcceptanceEligibility(f.task(), f.store.runs(f.taskId)),
      { available: true, acceptance: 'operator_source', missingEvidence: 'No finished released reviewer run carries the recorded verdict', args: {} });
    // With the run released the shared rule binds the reviewed verdict instead.
    f.store.putRun({ ...f.store.run('review-run')!, released: true, status: 'finished', completion: completionSchema.parse({ eventId: 'review-cr', taskId: f.taskId, runId: 'review-run', status: 'changes_required', summary: 'Findings', head, reviewId: REVIEW_ID }) });
    assert.deepEqual(qualifiedAcceptanceEligibility(f.task(), f.store.runs(f.taskId)), { available: true, acceptance: 'reviewed', args: {} });
    // A ready approval at the current head keeps the ordinary path; no acceptance applies.
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-ok', status: 'ready_to_merge', summary: 'Fine', head, reviewId: 12 } } });
    assert.deepEqual(qualifiedAcceptanceEligibility(f.task(), f.store.runs(f.taskId)),
      { available: false, refusal: 'The review at the current head already approves merging; move to merge needs no owner acceptance' });
    // Without a published head there is nothing to accept.
    f.store.update(f.taskId, { prHead: null });
    assert.deepEqual(qualifiedAcceptanceEligibility(f.task(), f.store.runs(f.taskId)),
      { available: false, refusal: 'Moving to merge requires an accepted review at the current PR head' });
    assert.match(f.mergeView().refusal!, /move merge: Moving to merge requires an accepted review at the current PR head/);
  } finally { await f.close(); }
});

test('the operator at the board records one durable qualified acceptance and the task merges through the ordinary gates', async () => {
  const f = fixture({ mergePipeline: true }); try {
    // Queue-owned closeout keeps the whole pipeline inside the fixtures.
    f.store.putRepository({ origin: null, path: '/repo' }, 'queue', 'fixture keeps Queue closeout');
    const repo = { origin: 'github.com/example/repo', path: '/repo' };
    f.store.upsertProject({ key: 'example', name: 'Example', repositories: [repo] });
    const before = f.task();
    const moved = await accept(f);
    assert.equal(moved.phase, 'verifying');
    const record = moved.resolution.ownerAcceptances?.at(-1);
    assert.ok(record, 'the acceptance is recorded');
    assert.equal(record!.head, head);
    assert.equal(record!.prNumber, 902);
    assert.deepEqual(record!.review, { runId: 'review-run', eventId: 'review-cr', head, status: 'changes_required', reviewId: REVIEW_ID, reviewCommentId: null });
    assert.deepEqual(record!.actor, { agentId: 'operator (board)', role: 'operator' });
    assert.deepEqual(record!.authority, { kind: 'operator', note: null });
    assert.match(record!.qualification, /fail-fast harness ordering defect/);
    // The reviewer verdict, its records and its publication are untouched.
    assert.equal(moved.resolution.review?.status, 'changes_required');
    assert.equal(moved.resolution.review?.reviewId, REVIEW_ID);
    assert.equal(moved.resolution.reviews.length, 1);
    assert.equal(moved.resolution.mergedCommit, null, 'nothing merged during recording');
    // One durable decision event beside the ordinary audit lines.
    assert.equal(f.events('owner_acceptance').length, 1);
    const detail = JSON.parse(f.events('owner_acceptance')[0]!.detail);
    assert.equal(detail.head, head);
    assert.equal(detail.review.reviewId, REVIEW_ID);
    assert.equal(detail.actor.role, 'operator');
    assert.match(detail.qualification, /leadcbd546a8/);
    assert.equal(f.events('owner_control').length, 1);
    const audit = JSON.parse(f.events('owner_control')[0]!.detail);
    assert.deepEqual(audit.identities.move, { to: 'merge', qualifiedAcceptance: true });
    assert.equal(audit.caller, 'operator (board)');
    // The ordinary pipeline runs: verification, merge, sync and closeout with no new review.
    const reviewRunsBefore = f.store.runs(f.taskId).filter(run => run.role === 'reviewer').length;
    for (let round = 0; round < 12 && f.task().phase !== 'done'; round++) await f.engine.wake();
    assert.equal(f.task().phase, 'done', f.task().reason);
    assert.ok(f.counts.merges >= 1, 'the merge ran through the ordinary intent path');
    assert.equal(f.store.runs(f.taskId).filter(run => run.role === 'reviewer').length, reviewRunsBefore, 'no review round was spent');
    // The permanent outcome tells both truths: the reviewer verdict it kept and the acceptance it merged under.
    const outcome = outcomeSchema.parse(f.store.outcome(f.taskId));
    assert.equal(outcome.review?.status, 'changes_required');
    assert.equal(outcome.review?.reviewId, REVIEW_ID);
    assert.equal(outcome.ownerAcceptance?.qualification.includes('leadcbd546a8'), true);
    assert.equal(outcome.ownerAcceptance?.actor.role, 'operator');
  } finally { await f.close(); }
});

test('the operator at the board and a relayed ruling with its note are the other authorities', async () => {
  const f = fixture(); try {
    const board = await accept(f, { caller: 'operator (board)' });
    assert.equal(board.resolution.ownerAcceptances?.at(-1)?.authority.kind, 'operator');
    assert.equal(board.resolution.ownerAcceptances?.at(-1)?.actor.role, 'operator');
  } finally { await f.close(); }

  const g = fixture(); try {
    const relayed = await accept(g, { caller: OTHER, relayed: true, note: "Tom's ruling 2026-10-17: Accepted, deferred to leadcbd546a8" });
    const record = relayed.resolution.ownerAcceptances?.at(-1)!;
    assert.deepEqual(record.actor, { agentId: OTHER, role: 'authorized_relay' });
    assert.deepEqual(record.authority, { kind: 'relayed_note', note: "Tom's ruling 2026-10-17: Accepted, deferred to leadcbd546a8" });
  } finally { await g.close(); }

  const h = fixture(); try {
    const before = h.task();
    await assert.rejects(accept(h, { caller: OTHER, relayed: true }), /requires the recorded operator authorization note/);
    assert.equal(h.task().version, before.version, 'a refused relay changes nothing');
    assert.equal(h.events('owner_acceptance').length, 0);
  } finally { await h.close(); }
});

test('an ordinary caller or coordinator cannot grant itself acceptance by writing a reason', async () => {
  const f = fixture(); try {
    const before = f.task();
    await assert.rejects(accept(f, { caller: OTHER }), /Qualified owner acceptance needs the operator at the board or a relayed operator authorization note; coordinator-thread has none/);
    // Even an owner-sounding caller string is refused without the project binding.
    await assert.rejects(accept(f, { caller: 'the-real-owner' }), /the-real-owner has none/);
    // An unattributed caller is refused outright.
    await assert.rejects(accept(f, { caller: undefined }), /refuses an unattributed caller/);
    assert.equal(f.task().version, before.version, 'nothing was written');
    assert.equal(f.task().phase, before.phase);
    assert.equal(f.task().resolution.ownerAcceptances?.length ?? 0, 0);
    assert.equal(f.events('owner_acceptance').length, 0);
    assert.equal(f.events('owner_control').length, 0);
  } finally { await f.close(); }
});

test('a caller claiming the retired project-owner role, like any other non-authority, is refused', async () => {
  const f = fixture(); try {
    const repo = { origin: 'github.com/example/repo', path: '/repo' };
    f.store.upsertProject({ key: 'example', name: 'Example', repositories: [repo] });
    f.store.setProjectPlanner({ key: 'example', agentId: 'someone-else', setBy: 'test' });
    const before = f.task();
    await assert.rejects(accept(f, { caller: OWNER }), /owner-thread has none/);
    assert.equal(f.task().version, before.version);
  } finally { await f.close(); }
});

test('a stale or mismatched head refuses at the forge with nothing written', async () => {
  const f = fixture(); try {
    f.remote.pr.head = 'f'.repeat(40);
    const before = f.task();
    await assert.rejects(accept(f, { caller: 'operator (board)' }), /differs from the task's recorded head/);
    assert.equal(f.task().version, before.version);
    assert.equal(f.task().phase, before.phase);
    assert.equal(f.events('owner_acceptance').length, 0);
  } finally { await f.close(); }
});

test('an idle coordinator run no longer fences the acceptance; the move displaces it (round 4)', async () => {
  const f = fixture(); try {
    f.store.putRun(runSchema.parse({
      id: 'pending-run', taskId: f.taskId, role: 'recovery', generation: 1, head, base, agentId: 'coord-agent', workspaceId: 'workspace',
      profile: coordinatorProfile, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: false, idleSince: null, completion: null, released: false,
    }));
    // The retained coordinator is observed idle in the run's own workspace: the verb
    // displaces it from a complete participant observation, never from an absence.
    f.idle('coord-agent');
    assert.equal(f.mergeView().available, true, f.mergeView().refusal);
    const moved = await accept(f, { caller: 'operator (board)' });
    assert.equal(moved.phase, 'verifying');
    assert.equal(f.store.run('pending-run')!.released, true);
    assert.equal(f.store.run('pending-run')!.status, 'superseded');
    assert.equal(f.events('owner_acceptance').length, 1);
  } finally { await f.close(); }
});

test('a run with unknown delivery still fences the acceptance, changing nothing (durable side effect)', async () => {
  const f = fixture(); try {
    f.store.putRun(runSchema.parse({
      id: 'pending-run', taskId: f.taskId, role: 'recovery', generation: 1, head, base, agentId: 'coord-agent', workspaceId: 'workspace',
      profile: coordinatorProfile, status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: false, idleSince: null, completion: null, released: false,
    }));
    const before = f.task();
    assert.match(f.mergeView().refusal!, /move merge: A recovery run \(pending-run\) holds a durable side effect/);
    // Task 620 (PR 868) names the blocking delivery: the fence now reads the run's own
    // run-delivery effect instead of the generic unknown-delivery prose.
    await assert.rejects(accept(f, { caller: 'operator (board)' }),
      /holds a durable side effect Queue will not act over blindly \(run-delivery pending-run is uncertain: run pending-run has an uncertain delivery\)/);
    assert.equal(f.task().version, before.version);
    assert.equal(f.events('owner_acceptance').length, 0);
  } finally { await f.close(); }
});

test('a merge hold survives the acceptance and only its holder releases the merge', async () => {
  const f = fixture({ mergePipeline: true }); try {
    f.store.putRepository({ origin: null, path: '/repo' }, 'queue', 'fixture keeps Queue closeout');
    // The task sits at verification (as after an ordinary move to merge) when the hold lands.
    f.store.update(f.taskId, { phase: 'verifying', reason: 'Waiting for repository integration turn' });
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: f.task().version, action: 'hold', kind: 'merge', reason: 'Waiting for the stage and microphone acceptance' }));
    // Let the hold control's scheduled reconciliation settle before recording.
    await new Promise(resolve => setImmediate(resolve));
    const held = await accept(f, { caller: 'operator (board)' });
    assert.equal(held.phase, 'verifying');
    assert.ok(qualifiedOwnerAcceptance(held), 'the acceptance is recorded');
    assert.ok(held.holdGeneration > 0, 'the hold is untouched');
    // Under the hold the task cannot enter the integration turn; it waits, visibly.
    await f.engine.wake();
    assert.match(f.task().reason, /Merge held by operator/);
    assert.equal(f.counts.merges, 0);
    assert.equal(f.task().resolution.mergeIntent, false);
    // The hold owner releases; the ordinary pipeline then merges the accepted head.
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: f.task().version, action: 'release', kind: 'merge' }));
    for (let round = 0; round < 12 && f.task().phase !== 'done'; round++) await f.engine.wake();
    assert.equal(f.task().phase, 'done', f.task().reason);
    assert.ok(f.counts.merges >= 1);
    assert.ok(qualifiedOwnerAcceptance(f.task()), 'the acceptance still binds at the merged head');
  } finally { await f.close(); }
});

test('an exact-head accepted move releases the proof wait merge hold and records why', async () => {
  const f = fixture(); try {
    const reason = `Proofs Queue cannot run, left for the planner or operator at ${head}: socket tests`;
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: f.task().version,
      action: 'hold', kind: 'merge', reason }));
    await new Promise(resolve => setImmediate(resolve));

    const moved = await accept(f);
    assert.equal(moved.phase, 'verifying');
    assert.equal(moved.holds.merge, undefined, 'the proof hold at the accepted head is settled with the move');
    assert.match(f.events('merge_release').at(-1)?.detail ?? '', new RegExp(`exact head ${head}`));
    assert.ok(qualifiedOwnerAcceptance(moved), 'the qualified acceptance remains recorded');
  } finally { await f.close(); }
});

test('failed required checks stay real gates under an acceptance, and the record is kept', async () => {
  const f = fixture({ mergePipeline: true }); try {
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, revisionRuns: 2 } });
    f.adapter.mergeGate = async (t: Task) => ({ head: t.prHead!, base, wait: "Required check 'qa' failed", checksFailed: true as const });
    const moved = await accept(f, { caller: 'operator (board)' });
    assert.equal(moved.phase, 'verifying');
    for (let round = 0; round < 8 && f.task().phase === 'verifying'; round++) await f.engine.wake();
    const after = f.task();
    assert.equal(after.phase, 'changes_requested', `the failed check returns the PR to its worker: ${after.phase} ${after.reason}`);
    const revision = f.store.runs(f.taskId).findLast(run => run.role === 'revision');
    assert.match(revision?.instruction ?? '', /qa/, 'the worker is sent the failed check');
    assert.ok(qualifiedOwnerAcceptance(after), 'the acceptance is durable evidence, not a waived gate');
    assert.equal(f.counts.merges, 0);
  } finally { await f.close(); }
});

test('the pre-merge hook gates run for an accepted task and a hook refusal stays real', async () => {
  const f = fixture({ mergePipeline: true }); try {
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, revisionRuns: 2 } });
    // The pre-merge and reviewed-head hook gates must activate for an accepted task:
    // a bound fake proves the gate ran instead of silently skipping.
    const gateCalls: string[] = [];
    const refusedRecord = {
      id: 'occ-1', taskId: f.taskId, hookId: 'policy', event: 'task.pre_merge', eventId: 'hook-1', occurrence: 1,
      mode: 'read_only', delivery: 'required', state: 'failed', baseBranch: 'main', baseCommit: base, attempt: 0,
      timeoutMs: 1000, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null, eventDigest: 'd'.repeat(64),
      manifest: { path: 'paseo.queue.control.json', commit: base, digest: 'm'.repeat(64) },
      program: { kind: 'repository', executable: '.paseo/hooks/gate', digest: 'p'.repeat(64) }, instruction: null,
      result: { outcome: 'blocked', summary: 'synthetic_proof fail: the candidate tree lacks the harness fix' },
      summary: 'refused', target: 'prospective_merge', mergeCandidate: null, eventPayload: null, workspace: null,
      replayIntent: null, replay: null,
    };
    (f.engine.resolution as unknown as { hooks: unknown }).hooks = {
      boundHooks: async () => { gateCalls.push('bound'); return { discovery: null, hooks: [{ id: 'policy', events: ['task.pre_merge'], target: 'reviewed_head', mode: 'read_only', delivery: 'required' }] }; },
      emit: async () => { gateCalls.push('emit'); return { hold: false, attention: false, records: [refusedRecord] }; },
      prospectiveMergeGate: async () => ({ kind: 'none' }),
    };
    const moved = await accept(f, { caller: 'operator (board)' });
    assert.equal(moved.phase, 'verifying');
    await f.engine.wake();
    const after = f.task();
    assert.ok(gateCalls.length > 0, 'the hook gate ran for the accepted task instead of skipping');
    assert.equal(after.phase, 'changes_requested', `the hook refusal stays a real gate: ${after.phase} ${after.reason}`);
    const revision = f.store.runs(f.taskId).findLast(run => run.role === 'revision');
    assert.match(revision?.instruction ?? '', /synthetic_proof/, 'the reviewer finding goes to the worker, never to the acceptance');
    assert.ok(qualifiedOwnerAcceptance(after), 'the acceptance never waives a hook refusal');
    assert.equal(f.counts.merges, 0);
  } finally { await f.close(); }
});

test('a head change invalidates the acceptance for merge while its history remains', async () => {
  const f = fixture(); try {
    const moved = await accept(f, { caller: 'operator (board)' });
    assert.ok(qualifiedOwnerAcceptance(moved));
    // The source moves; the record stays but no longer authorizes merging.
    const newHead = '9'.repeat(40);
    f.store.update(f.taskId, { prHead: newHead });
    assert.equal(qualifiedOwnerAcceptance(f.task()), null);
    assert.equal(f.task().resolution.ownerAcceptances?.length, 1, 'history is kept');
    await assert.rejects(requiredMergeReview(f.task(), null), /The recorded review does not approve merging/);
  } finally { await f.close(); }
});

test('a duplicate or lost reply is observed under the original decision, never replayed', async () => {
  const f = fixture(); try {
    const moved = await accept(f, { caller: 'operator (board)' });
    assert.equal(moved.resolution.ownerAcceptances?.length, 1);
    const staleVersion = moved.version - 1;
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: f.taskId, version: staleVersion, action: 'move', to: 'merge', reason: 'again',
      qualification: 'again', caller: 'operator (board)',
    })), /Task changed; refresh before retrying/);
    assert.equal(f.task().resolution.ownerAcceptances?.length, 1, 'no second acceptance record');
    assert.equal(f.events('owner_acceptance').length, 1, 'no second decision event');
  } finally { await f.close(); }
});

test('the forge gate verifies the authentic verdict under the acceptance and relaxes only Queue review requirements', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-accept-forge-'));
  try {
    // A real repository whose origin is the GitHub name `repo()` requires.
    await git(dir, 'init', '--initial-branch=main');
    await git(dir, 'remote', 'add', 'origin', 'git@github.com:example/repo.git');
    const task = forgeGateTask(dir);
    const reviewer: ReviewerSetting = { login: 'reviewer-login' };
    const marker = `<!-- northstar-review:${task.id}:review-run:${head}:changes_required -->`;
    const runtime = (reviewBody: Record<string, unknown>): FormalReviewRuntime => ({
      readToken: async () => 'tok',
      runGh: async (_t, endpoint) => {
        assert.match(String(endpoint), /pulls\/902\/reviews\/5553259160/);
        return reviewBody;
      },
      verifyPr: async () => ({ url: task.prUrl!, head }),
    });
    const genuine = { id: REVIEW_ID, user: { login: 'reviewer-login' }, commit_id: head, state: 'CHANGES_REQUESTED', body: `Findings.\n${marker}` };
    // Without the acceptance, Queue's own gate refuses the changes_required verdict.
    const unacceptedTask = { ...task, resolution: { ...task.resolution, ownerAcceptances: [] } };
    await assert.rejects(requiredMergeReview(unacceptedTask, reviewer, runtime(genuine)), /The recorded review does not approve merging/);
    // With the acceptance the authentic verdict is verified at the exact head:
    // its formal review identity, commit and state are all re-proven at the forge.
    await requiredMergeReview(task, reviewer, runtime(genuine));
    // A review whose commit no longer matches the head still refuses under the acceptance.
    await assert.rejects(requiredMergeReview(task, reviewer, runtime({ ...genuine, commit_id: '9'.repeat(40) })), /stale|head|marker/i);
    // A mutated verdict body is never accepted as the bound evidence.
    await assert.rejects(requiredMergeReview(task, reviewer, runtime({ ...genuine, body: 'Rewritten findings.' })), /marker|authenticated|exactly/i);
    // Queue's review-requirement gate: the acceptance is the recorded approval,
    // while any other decision still waits.
    assert.equal(reviewRequirementsWait(task, 'CHANGES_REQUESTED'), '');
    assert.equal(reviewRequirementsWait(task, 'APPROVED'), '');
    const unaccepted = { ...task, resolution: { ...task.resolution, ownerAcceptances: [] } };
    assert.equal(reviewRequirementsWait(unaccepted, 'CHANGES_REQUESTED'), 'GitHub review requirements are not satisfied');
    assert.equal(reviewRequirementsWait(unaccepted, 'APPROVED'), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A full task row carrying a published changes_required verdict and one qualified owner acceptance at its head. */
function forgeGateTask(repoPath: string): Task {
  const submission = submissionSchema.parse({
    submissionId: randomUUID(), title: 'Forge gate', repoPath, planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  });
  return taskSchema.parse({
    ...submission, id: 'forge-task', hostId: 'host', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 3,
    phase: 'changes_requested', reason: 'Findings', handoffText: 'h', planningBase: base, held: false,
    workspaceId: null, directory: null, branch: 'ns-task', agentId: null, runId: null, profile: null,
    workspaceIntent: false, agentIntent: false, lastAgentStatus: null, idleSince: null,
    completion: { eventId: 'e', taskId: 'forge-task', runId: 'worker-run', status: 'ready_for_review', summary: 'Ready', prNumber: 902, head },
    agentActive: false, lastObservedAt: null, prUrl: 'https://github.com/example/repo/pull/902', prHead: head, coordinatorGeneration: 1,
    resolution: { attention: false, review: { taskId: 'forge-task', runId: 'review-run', eventId: 'review-cr', status: 'changes_required', summary: 'Findings', head, reviewId: REVIEW_ID },
      ownerAcceptances: [{
        at: new Date().toISOString(), head, prNumber: 902,
        review: { runId: 'review-run', eventId: 'review-cr', head, status: 'changes_required', reviewId: REVIEW_ID, reviewCommentId: null },
        actor: { agentId: OWNER, role: 'project_owner' }, authority: { kind: 'project_owner', note: null },
        reason: 'Accepted', qualification: 'Deferred defect',
      }] },
  });
}
