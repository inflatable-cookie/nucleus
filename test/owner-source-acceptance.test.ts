import { profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { requiredMergeReview, reviewRequirementsWait } from '../core/forge/index';
import {
  completionSchema, outcomeSchema, runSchema, submissionSchema, taskControlInputSchema,
  taskNextSchema, type Run, type Task,
} from '../shared/contracts';
import { operatorSourceAcceptance, qualifiedOwnerAcceptance } from '../shared/contracts';
import { collectOwnerVerbFacts, ownerTaskNext, qualifiedAcceptanceEligibility } from '../core/verbs/owner-verbs';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';
import { toolTimelinePage } from './support/tool-timeline';

/**
 * Explicit operator source acceptance (2026-10-20, Tom's "Approve" on lead
 * 87115b71, Supervisor relay 59f8bd7e, relayed by the Project-C owner): `move
 * to=merge` with a qualification records one durable acceptance of the exact
 * published source head AS IS when no review evidence binds it — an
 * interrupted or unfinished reviewer, an unpublished verdict, or a head a
 * docs-only resolution moved after the verdict. The record binds actor,
 * authority, ruling, head, qualification and the concrete missing evidence;
 * nothing fabricates or rewrites a verdict, and every other gate — holds,
 * required checks, pre-merge hooks, forge identity — stays real.
 */

const head = 'a'.repeat(40), oldHead = 'e'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);
const OWNER = 'owner-thread', OTHER = 'coordinator-thread';
const REVIEW_ID = 5553259161;


const workerProfile = profile('worker', 'test/worker'), reviewerProfile = profile('reviewer', 'test/reviewer'), coordinatorProfile = profile('coordinator', 'test/coordinator');

/** Which review evidence (not) to bind to the current head. */
type ReviewShape = 'none' | 'unpublished' | 'interrupted' | 'stale_ready' | 'stale_changes';

function fixture(options: { review?: ReviewShape; mergePipeline?: boolean } = {}) {
  const shape = options.review ?? 'none';
  const dir = mkdtempSync(join(tmpdir(), 'ns-source-accept-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Accept my source', repoPath: '/repo', planningCommit: base,
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
  const remote = {
    pr: { url: 'https://github.com/example/repo/pull/903', head },
    merged: null as { head: string; commit: string } | null,
  };
  const counts = { merges: 0, reviewChecks: 0 };
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
    mergeGate: options.mergePipeline ? async (t: Task) => ({ head: t.prHead!, base, wait: '' }) : undefined,
    merge: async () => { counts.merges++; },
    merged: async () => ({ merged: counts.merges > 0, commit: merged, head: remote.pr.head, base: 'main' }),
    syncMain: async () => merged,
    verifyCloseout: async () => {},
    createRun: async () => { throw new Error('no dispatch is expected in these fixtures'); },
    sendRun: async () => {},
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [workerProfile, reviewerProfile, coordinatorProfile];
  const task = () => store.task(inserted.id);
  const facts = () => collectOwnerVerbFacts(store, task());
  const next = () => taskNextSchema.parse(ownerTaskNext(facts()));
  const mergeView = () => next().verbs.find(view => view.verb === 'move' && ((view.args?.to === 'merge') || view.refusal?.startsWith('move merge:')))!;
  const events = (kind: string) => store.eventsAll(inserted.id).filter(event => event.kind === kind);
  // Dispatched with a retained author and the PR; the review evidence follows the shape.
  store.update(inserted.id, {
    phase: 'changes_requested', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, workerModel: workerProfile.model,
    prHead: head, prUrl: remote.pr.url,
    completion: { taskId: inserted.id, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 903 },
  });
  if (shape === 'interrupted') {
    // An interrupted reviewer: an unpublished-verdict-looking record whose run
    // never finished or released. The verdict is history, never credit.
    store.putRun(runSchema.parse({
      id: 'review-run', taskId: inserted.id, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace',
      profile: reviewerProfile, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: false, idleSince: null, completion: null, released: false,
    }));
    // The interrupted reviewer's agent is observed idle in its own task workspace;
    // a missing observation would be unknown, not this participant.
    idle('review-agent');
    store.setCredential('review-run', 'token');
    store.update(inserted.id, {
      resolution: { ...store.task(inserted.id).resolution, reviewerAgentId: 'review-agent', reviewerProfile,
        review: { taskId: inserted.id, runId: 'review-run', eventId: 'review-cr', status: 'changes_required', summary: 'Findings', head, reviewId: REVIEW_ID } },
    });
  }
  if (shape === 'stale_ready' || shape === 'stale_changes') {
    idle('review-agent');
    // A verdict from before a docs-only conflict resolution moved the head.
    store.putRun(runSchema.parse({
      id: 'review-run', taskId: inserted.id, role: 'reviewer', generation: 1, head: oldHead, base, agentId: 'review-agent', workspaceId: 'workspace',
      profile: reviewerProfile, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: false, idleSince: null,
      completion: completionSchema.parse({ eventId: 'review-old', taskId: inserted.id, runId: 'review-run',
        status: shape === 'stale_ready' ? 'ready_to_merge' : 'changes_required', summary: 'Old verdict', head: oldHead, reviewId: REVIEW_ID }),
      released: true,
    }));
    store.setCredential('review-run', 'token');
    store.update(inserted.id, {
      resolution: { ...store.task(inserted.id).resolution, reviewerAgentId: 'review-agent', reviewerProfile,
        review: { taskId: inserted.id, runId: 'review-run', eventId: 'review-old',
          status: shape === 'stale_ready' ? 'ready_to_merge' : 'changes_required', summary: 'Old verdict', head: oldHead, reviewId: REVIEW_ID } },
    });
  }
  if (shape === 'unpublished') {
    store.update(inserted.id, {
      resolution: { ...store.task(inserted.id).resolution,
        review: { taskId: inserted.id, runId: 'review-run', eventId: 'review-cr', status: 'changes_required', summary: 'Unpublished findings', head } },
    });
  }
  const f = {
    dir, store, engine, adapter: adapter as Adapter & ResolutionAdapter, observations, remote, counts,
    taskId: inserted.id, task, facts, next, mergeView, events,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
  return f;
}

const accept = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) =>
  f.engine.performTaskControl(taskControlInputSchema.parse({
    taskId: f.taskId, version: f.task().version, action: 'move', to: 'merge',
    reason: 'Accepting the source as is; the interrupted review never finished',
    qualification: 'The docs-only conflict resolution is the only change; the product code at this head is the reviewed work',
    caller: 'operator (board)', ...extra,
  }));

test('an interrupted reviewer leaves the source acceptance available with its missing evidence named', async () => {
  const f = fixture({ review: 'interrupted' }); try {
    assert.deepEqual(qualifiedAcceptanceEligibility(f.task(), f.store.runs(f.taskId)),
      { available: true, acceptance: 'operator_source', missingEvidence: 'No finished released reviewer run carries the recorded verdict', args: {} });
    const view = f.mergeView();
    assert.equal(view.available, true, JSON.stringify(view));
    assert.deepEqual(view.fill, ['reason', 'qualification']);
    assert.match(view.note!, /No finished released reviewer run carries the recorded verdict/);
    assert.match(view.note!, /operator source acceptance/);
    const moved = await accept(f);
    assert.equal(moved.phase, 'verifying');
    const record = moved.resolution.ownerAcceptances?.at(-1);
    assert.ok(record);
    assert.equal(record!.kind, 'operator_source');
    assert.equal(record!.head, head);
    assert.equal(record!.prNumber, 903);
    assert.equal(record!.review, null);
    assert.equal(record!.missingEvidence, 'No finished released reviewer run carries the recorded verdict');
    assert.deepEqual(record!.actor, { agentId: 'operator (board)', role: 'operator' });
    assert.deepEqual(record!.authority, { kind: 'operator', note: null });
    // The interrupted reviewer's record is untouched history, never rewritten or minted into a pass.
    assert.equal(moved.resolution.review?.status, 'changes_required');
    assert.equal(moved.resolution.review?.reviewId, REVIEW_ID);
    assert.equal(moved.resolution.mergedCommit, null, 'nothing merged during recording');
    // One durable decision event naming the disposition and the accepted risk.
    assert.equal(f.events('owner_acceptance').length, 1);
    const detail = JSON.parse(f.events('owner_acceptance')[0]!.detail);
    assert.equal(detail.kind, 'operator_source');
    assert.equal(detail.review, null);
    assert.equal(detail.missingEvidence, 'No finished released reviewer run carries the recorded verdict');
    assert.equal(detail.head, head);
    const audit = JSON.parse(f.events('owner_control')[0]!.detail);
    assert.deepEqual(audit.identities.move, { to: 'merge', qualifiedAcceptance: true });
    assert.equal(audit.caller, 'operator (board)');
  } finally { await f.close(); }
});

test('the accepted source head merges through the ordinary gates with no review round and no fabricated evidence', async () => {
  const f = fixture({ review: 'none', mergePipeline: true }); try {
    f.store.putRepository({ origin: null, path: '/repo' }, 'queue', 'fixture keeps Queue closeout');
    const reviewRunsBefore = f.store.runs(f.taskId).filter(run => run.role === 'reviewer').length;
    const moved = await accept(f);
    assert.equal(moved.phase, 'verifying');
    assert.match(moved.reason, /Operator accepted the source head/);
    for (let round = 0; round < 12 && f.task().phase !== 'done'; round++) await f.engine.wake();
    assert.equal(f.task().phase, 'done', f.task().reason);
    assert.ok(f.counts.merges >= 1, 'the merge ran through the ordinary intent path');
    assert.equal(f.store.runs(f.taskId).filter(run => run.role === 'reviewer').length, reviewRunsBefore, 'no review round was spent');
    // The permanent outcome records the accepted risk, not a verified review.
    const outcome = outcomeSchema.parse(f.store.outcome(f.taskId));
    assert.equal(outcome.review, null);
    assert.equal(outcome.ownerAcceptance?.kind, 'operator_source');
    assert.equal(outcome.ownerAcceptance?.review, null);
    assert.equal(outcome.ownerAcceptance?.missingEvidence, 'No reviewer verdict exists at the current PR head');
  } finally { await f.close(); }
});

test('after a docs-only conflict resolution the old approval stays history and the operator accepts the resulting head', async () => {
  const f = fixture({ review: 'stale_ready' }); try {
    assert.equal(qualifiedOwnerAcceptance(f.task()), null, 'a stale approval is not merge credit');
    assert.deepEqual(qualifiedAcceptanceEligibility(f.task(), f.store.runs(f.taskId)),
      { available: true, acceptance: 'operator_source', missingEvidence: 'The recorded ready_to_merge approval is at head eeeeeeeeeeee, not the current PR head', args: {} });
    const moved = await accept(f);
    const record = moved.resolution.ownerAcceptances?.at(-1)!;
    assert.equal(record.kind, 'operator_source');
    assert.equal(record.head, head, 'the fresh disposition binds the actual resulting head');
    assert.equal(operatorSourceAcceptance(moved), record, 'the resulting head is authorized by the new disposition');
    // The old approval keeps its own record, unchanged and linked as history.
    assert.equal(moved.resolution.review?.status, 'ready_to_merge');
    assert.equal(moved.resolution.review?.head, oldHead);
    assert.equal(moved.resolution.review?.reviewId, REVIEW_ID);
  } finally { await f.close(); }
});

test('source drift after acceptance invalidates the disposition for merge while its history remains', async () => {
  const f = fixture(); try {
    const moved = await accept(f);
    assert.ok(operatorSourceAcceptance(moved));
    const newHead = '9'.repeat(40);
    f.store.update(f.taskId, { prHead: newHead });
    assert.equal(operatorSourceAcceptance(f.task()), null, 'no head inherits the old acceptance');
    assert.equal(f.task().resolution.ownerAcceptances?.length, 1, 'history is kept');
    await assert.rejects(requiredMergeReview(f.task(), null), /The recorded review does not approve merging/);
    assert.equal(reviewRequirementsWait(f.task(), 'REVIEW_REQUIRED'), 'GitHub review requirements are not satisfied');
    // A fresh disposition binds the actual new head; nothing is inherited. The
    // move's own lane quantum settles before the version is read again.
    f.remote.pr.head = newHead;
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    const again = await accept(f, { reason: 'The head moved again; accepting the current source' });
    assert.equal(operatorSourceAcceptance(again)?.head, newHead);
    assert.equal(f.task().resolution.ownerAcceptances?.length, 2);
  } finally { await f.close(); }
});

test('the forge review gates read the disposition instead of demanding publication-only evidence', async () => {
  const f = fixture({ review: 'none' }); try {
    const moved = await accept(f);
    // No review identity exists and none is invented; the disposition authorizes.
    await requiredMergeReview(moved, { login: 'reviewer-login' });
    assert.equal(f.counts.reviewChecks, 0, 'nothing is verified because nothing is bound');
    assert.equal(reviewRequirementsWait(moved, 'REVIEW_REQUIRED'), '');
    assert.equal(reviewRequirementsWait(moved, 'CHANGES_REQUESTED'), '');
    assert.equal(reviewRequirementsWait(moved, 'APPROVED'), '');
    // Strip the disposition and the same gates refuse exactly as before.
    const unaccepted = { ...moved, resolution: { ...moved.resolution, ownerAcceptances: [] } } as Task;
    await assert.rejects(requiredMergeReview(unaccepted, { login: 'reviewer-login' }), /The recorded review does not approve merging/);
    assert.equal(reviewRequirementsWait(unaccepted, 'REVIEW_REQUIRED'), 'GitHub review requirements are not satisfied');
  } finally { await f.close(); }
});

test('ordinary callers, owner-sounding strings, unattributed callers and noteless relays are refused with nothing written', async () => {
  const f = fixture({ review: 'unpublished' }); try {
    const before = f.task();
    await assert.rejects(accept(f, { caller: OTHER }), /needs the operator at the board or a relayed operator authorization note; coordinator-thread has none/);
    await assert.rejects(accept(f, { caller: 'the-real-owner' }), /the-real-owner has none/);
    await assert.rejects(accept(f, { caller: undefined }), /refuses an unattributed caller/);
    await assert.rejects(accept(f, { caller: OTHER, relayed: true }), /requires the recorded operator authorization note/);
    assert.equal(f.task().version, before.version, 'nothing was written');
    assert.equal(f.task().phase, before.phase);
    assert.equal(f.task().resolution.ownerAcceptances?.length ?? 0, 0);
    assert.equal(f.events('owner_acceptance').length, 0);
    assert.equal(f.events('owner_control').length, 0);
  } finally { await f.close(); }
});

test('a caller claiming the retired project-owner role is refused like any other non-authority', async () => {
  const f = fixture({ review: 'unpublished' }); try {
    const repo = { origin: 'github.com/example/repo', path: '/repo' };
    f.store.upsertProject({ key: 'example', name: 'Example', repositories: [repo] });
    f.store.setProjectPlanner({ key: 'example', agentId: OWNER, setBy: 'test' });
    const before = f.task();
    await assert.rejects(accept(f, { caller: OWNER }), /owner-thread has none/);
    assert.equal(f.task().version, before.version);
    assert.equal(f.task().resolution.ownerAcceptances?.length ?? 0, 0);
  } finally { await f.close(); }
});

test('a relayed operator ruling with its recorded note and date authorizes the disposition', async () => {
  const f = fixture({ review: 'none' }); try {
    const moved = await accept(f, { caller: OTHER, relayed: true, note: "Tom's ruling 2026-10-20: Approve (lead 87115b71)" });
    const record = moved.resolution.ownerAcceptances?.at(-1)!;
    assert.deepEqual(record.actor, { agentId: OTHER, role: 'authorized_relay' });
    assert.deepEqual(record.authority, { kind: 'relayed_note', note: "Tom's ruling 2026-10-20: Approve (lead 87115b71)" });
  } finally { await f.close(); }
});

test('a run with unknown delivery still fences the source acceptance, changing nothing', async () => {
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
    await assert.rejects(accept(f),
      /holds a durable side effect Queue will not act over blindly \(run-delivery pending-run is uncertain: run pending-run has an uncertain delivery\)/);
    assert.equal(f.task().version, before.version);
    assert.equal(f.events('owner_acceptance').length, 0);
  } finally { await f.close(); }
});

test('the authorized path rechecks the canonical source and the task identity after its awaits', async () => {
  const f = fixture(); try {
    f.remote.pr.head = 'f'.repeat(40);
    const before = f.task();
    await assert.rejects(accept(f), /differs from the task's recorded head/);
    assert.equal(f.task().version, before.version);
    assert.equal(f.task().phase, before.phase);
    assert.equal(f.events('owner_acceptance').length, 0);
  } finally { await f.close(); }

  const g = fixture(); try {
    // A source change landing after the queued move bounces it once, with nothing
    // written: the settled head is re-derived after the waits, never assumed.
    const adapter = g.adapter.verifyPr as (t: Task, n: number) => Promise<{ url: string; head: string }>;
    g.adapter.verifyPr = async (t: Task, n: number) => {
      const pr = await adapter(t, n);
      g.store.update(g.taskId, { prHead: 'f'.repeat(40) });
      return pr;
    };
    // The write lands during the move's final PR observation, inside its task lane:
    // the general guard refuses it before the commit (the head-specific check sees
    // the same drift only if it gets there first), and nothing is written.
    await assert.rejects(accept(g), /Task changed; refresh before retrying|The accepted review or PR head changed during the move; refresh before retrying/);
    assert.equal(g.events('owner_acceptance').length, 0);
    assert.equal(g.task().resolution.ownerAcceptances?.length ?? 0, 0);
  } finally { await g.close(); }
});

test('a merge hold survives the source acceptance and only its holder releases the merge', async () => {
  const f = fixture({ mergePipeline: true }); try {
    f.store.putRepository({ origin: null, path: '/repo' }, 'queue', 'fixture keeps Queue closeout');
    f.store.update(f.taskId, { phase: 'verifying', reason: 'Waiting for repository integration turn' });
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: f.task().version, action: 'hold', kind: 'merge', reason: "Waiting for the operator's own acceptance" }));
    await new Promise(resolve => setImmediate(resolve));
    const held = await accept(f);
    assert.equal(held.phase, 'verifying');
    assert.ok(operatorSourceAcceptance(held));
    assert.ok(held.holdGeneration > 0, 'the hold is untouched');
    await f.engine.wake();
    assert.match(f.task().reason, /Merge held by operator/);
    assert.equal(f.counts.merges, 0);
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version: f.task().version, action: 'release', kind: 'merge' }));
    for (let round = 0; round < 12 && f.task().phase !== 'done'; round++) await f.engine.wake();
    assert.equal(f.task().phase, 'done', f.task().reason);
    assert.ok(f.counts.merges >= 1);
    assert.ok(operatorSourceAcceptance(f.task()), 'the acceptance still binds at the merged head');
  } finally { await f.close(); }
});

test('failed required checks stay real gates under a source acceptance, and the record is kept', async () => {
  const f = fixture({ mergePipeline: true }); try {
    f.adapter.mergeGate = async (t: Task) => ({ head: t.prHead!, base, wait: "Required check 'qa' failed", checksFailed: true as const });
    const moved = await accept(f);
    assert.equal(moved.phase, 'verifying');
    for (let round = 0; round < 8 && f.task().phase === 'verifying'; round++) await f.engine.wake();
    const after = f.task();
    assert.equal(after.phase, 'changes_requested', `the failed check returns the PR to its worker: ${after.phase} ${after.reason}`);
    const revision = f.store.runs(f.taskId).findLast(run => run.role === 'revision');
    assert.match(revision?.instruction ?? '', /qa/, 'the worker is sent the failed check');
    assert.ok(operatorSourceAcceptance(after), 'the acceptance is durable evidence, not a waived gate');
    assert.equal(f.counts.merges, 0);
  } finally { await f.close(); }
});

test('the pre-merge hook gate activates for a source-accepted task and a hook refusal stays real', async () => {
  const f = fixture({ mergePipeline: true }); try {
    const gateCalls: string[] = [];
    const refusedRecord = {
      id: 'occ-1', taskId: f.taskId, hookId: 'policy', event: 'task.pre_merge', eventId: 'hook-1', occurrence: 1,
      mode: 'read_only', delivery: 'required', state: 'failed', baseBranch: 'main', baseCommit: base, attempt: 0,
      timeoutMs: 1000, maxOutputBytes: 65536, allowedPaths: [], commitSubject: null, eventDigest: 'd'.repeat(64),
      manifest: { path: 'paseo.queue.control.json', commit: base, digest: 'm'.repeat(64) },
      program: { kind: 'repository', executable: '.paseo/hooks/gate', digest: 'p'.repeat(64) }, instruction: null,
      result: { outcome: 'blocked', summary: 'synthetic_proof fail: the candidate tree lacks the harness fix' },
      summary: 'refused', target: 'reviewed_head', mergeCandidate: null, eventPayload: null, workspace: null,
      replayIntent: null, replay: null,
    };
    (f.engine.resolution as unknown as { hooks: unknown }).hooks = {
      boundHooks: async () => { gateCalls.push('bound'); return { discovery: null, hooks: [{ id: 'policy', events: ['task.pre_merge'], target: 'reviewed_head', mode: 'read_only', delivery: 'required' }] }; },
      emit: async (_event: string, _task: Task, delivery: { review?: string | null }) => {
        gateCalls.push(`emit:${delivery.review ?? 'none'}`);
        return { hold: false, attention: false, records: [refusedRecord] };
      },
      prospectiveMergeGate: async () => ({ kind: 'none' }),
    };
    const moved = await accept(f);
    assert.equal(moved.phase, 'verifying');
    await f.engine.wake();
    const after = f.task();
    assert.ok(gateCalls.length > 0, 'the hook gate ran for the source-accepted task instead of skipping');
    assert.match(gateCalls.join(','), /emit:none/, 'the payload carries no review it cannot prove');
    assert.equal(after.phase, 'changes_requested', `the hook refusal stays a real gate: ${after.phase} ${after.reason}`);
    const revision = f.store.runs(f.taskId).findLast(run => run.role === 'revision');
    assert.match(revision?.instruction ?? '', /synthetic_proof/, 'the hook refusal goes to the worker, never to the acceptance');
    assert.ok(operatorSourceAcceptance(after), 'the acceptance never waives a hook refusal');
    assert.equal(f.counts.merges, 0);
  } finally { await f.close(); }
});

// Papercut 209406f4 (Project-C #112): the remote PR head moved past the stored one
// with no no-review refresh. An owner acceptance may name the exact head it
// accepts; Queue adopts it atomically with the acceptance, judges every gate at
// that head, and never lends an old-head verdict to it.
const newHead = 'd'.repeat(40);

test('209406f4: a named head is valid only on an owner acceptance move to merge, as a full SHA', async () => {
  const parse = (extra: Record<string, unknown>) => taskControlInputSchema.safeParse({ taskId: 't', version: 1, reason: 'r', ...extra });
  assert.equal(parse({ action: 'move', to: 'merge', qualification: 'q', head: newHead }).success, true);
  assert.equal(parse({ action: 'move', to: 'merge', head: newHead }).success, false, 'a reviewed merge names no head');
  assert.equal(parse({ action: 'move', to: 'review', head: newHead }).success, false);
  assert.equal(parse({ action: 'move', to: 'merge', qualification: 'q', head: 'd'.repeat(12) }).success, false, 'an abbreviated head is refused');
  const f = fixture(); try {
    f.remote.pr.head = newHead;
    const before = f.task();
    await assert.rejects(f.engine.moveToMerge({ taskId: f.taskId, version: before.version, reason: 'r', caller: 'operator (board)', head: newHead }),
      /A head can be named only with an owner acceptance/);
    assert.equal(f.task().version, before.version);
    assert.equal(f.task().prHead, head);
  } finally { await f.close(); }
});

test('209406f4: a remote head past the stored one is refused unnamed, refused misnamed, and adopted when named', async () => {
  const f = fixture(); try {
    f.remote.pr.head = newHead;
    const before = f.task();
    await assert.rejects(accept(f), new RegExp(`differs from the task's recorded head ${head}; pass head=${newHead} with an owner acceptance`));
    await assert.rejects(accept(f, { head: '9'.repeat(40) }), new RegExp(`The current PR head ${newHead} differs from the head you accept \\(${'9'.repeat(40)}\\)`));
    assert.equal(f.task().version, before.version, 'nothing was written');
    assert.equal(f.task().prHead, head);
    assert.equal(f.events('owner_acceptance').length + f.events('owner_head_adopted').length, 0);
    const moved = await accept(f, { head: newHead });
    assert.equal(moved.phase, 'verifying');
    assert.equal(moved.prHead, newHead, 'the head is adopted with the acceptance');
    const record = moved.resolution.ownerAcceptances?.at(-1)!;
    assert.equal(record.kind, 'operator_source');
    assert.equal(record.head, newHead);
    assert.equal(record.missingEvidence, 'No reviewer verdict exists at the current PR head');
    assert.equal(operatorSourceAcceptance(moved), record);
    const adopted = f.events('owner_head_adopted');
    assert.equal(adopted.length, 1);
    assert.deepEqual(JSON.parse(adopted[0]!.detail), { from: head, to: newHead, caller: 'operator (board)', reason: 'Accepting the source as is; the interrupted review never finished' });
  } finally { await f.close(); }
});

test('209406f4: naming the stored head changes nothing about the matching-head acceptance', async () => {
  const f = fixture({ review: 'unpublished' }); try {
    const moved = await accept(f, { head });
    assert.equal(moved.prHead, head);
    assert.equal(moved.resolution.ownerAcceptances?.at(-1)?.missingEvidence, 'The recorded review verdict has no published evidence to verify at the forge');
    assert.equal(f.events('owner_head_adopted').length, 0, 'no adoption is recorded for the stored head');
  } finally { await f.close(); }
});

test('209406f4: an old-head ready_to_merge neither makes the acceptance unnecessary nor approves the named head', async () => {
  const f = fixture({ review: 'stale_ready' }); try {
    // The approval is current at the stored head; the PR moved past it.
    f.store.update(f.taskId, { prHead: oldHead });
    const version = f.task().version;
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.taskId, version, action: 'move', to: 'merge', reason: 'Merge the approval', caller: 'operator (board)' })),
      new RegExp(`differs from the task's recorded head ${oldHead}; pass head=${head}`), 'the stored approval does not merge a moved PR');
    await assert.rejects(accept(f), /already approves merging/, 'unnamed, the stored head is still the one judged');
    const moved = await accept(f, { head });
    const record = moved.resolution.ownerAcceptances?.at(-1)!;
    assert.equal(record.kind, 'operator_source', 'the approval is not borrowed for the named head');
    assert.equal(record.review, null);
    assert.equal(record.missingEvidence, 'The recorded ready_to_merge approval is at head eeeeeeeeeeee, not the current PR head');
    assert.equal(moved.resolution.review?.head, oldHead, 'the approval stays history at its own head');
    assert.equal(moved.resolution.review?.status, 'ready_to_merge');
    assert.equal(f.store.runs(f.taskId).find(run => run.id === 'review-run')?.completion?.head, oldHead);
  } finally { await f.close(); }
});

test('209406f4: an old-head changes_required is not borrowed as a reviewed acceptance of the named head', async () => {
  const f = fixture({ review: 'stale_changes' }); try {
    f.store.update(f.taskId, { prHead: oldHead });
    assert.deepEqual(qualifiedAcceptanceEligibility(f.task(), f.store.runs(f.taskId)), { available: true, acceptance: 'reviewed', args: {} },
      'at the stored head the findings would be a reviewed acceptance');
    const moved = await accept(f, { head });
    const record = moved.resolution.ownerAcceptances?.at(-1)!;
    assert.equal(record.kind, 'operator_source');
    assert.equal(record.review, null);
    assert.equal(record.missingEvidence, 'The recorded changes_required review is at head eeeeeeeeeeee, not the current PR head');
    assert.deepEqual(moved.resolution.review, { taskId: f.taskId, runId: 'review-run', eventId: 'review-old', status: 'changes_required', summary: 'Old verdict', head: oldHead, reviewId: REVIEW_ID },
      'the findings stay immutable history');
    const run = f.store.runs(f.taskId).find(item => item.id === 'review-run')!;
    assert.equal(run.status, 'finished');
    assert.equal(run.completion?.head, oldHead);
  } finally { await f.close(); }
});

test('209406f4: a fenced run or a refused authority adopts nothing', async () => {
  const f = fixture(); try {
    f.remote.pr.head = newHead;
    f.store.putRun(runSchema.parse({
      id: 'pending-run', taskId: f.taskId, role: 'recovery', generation: 1, head, base, agentId: 'coord-agent', workspaceId: 'workspace',
      profile: coordinatorProfile, status: 'uncertain', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: false, idleSince: null, completion: null, released: false,
    }));
    const before = f.task();
    await assert.rejects(accept(f, { head: newHead }), /holds a durable side effect Queue will not act over blindly/);
    await assert.rejects(accept(f, { head: newHead, caller: OTHER }), /coordinator-thread has none/);
    assert.equal(f.task().version, before.version);
    assert.equal(f.task().prHead, head, 'no partial adoption');
    assert.equal(f.events('owner_acceptance').length + f.events('owner_head_adopted').length + f.events('owner_control').length, 0);
    assert.equal(f.store.runs(f.taskId).find(run => run.id === 'pending-run')?.status, 'uncertain', 'the unknown delivery is not reinterpreted');
  } finally { await f.close(); }
});

test('209406f4: the head re-observed before commit must still be the named head, and a stored-head race adopts nothing', async () => {
  const f = fixture(); try {
    f.remote.pr.head = newHead;
    let calls = 0;
    f.adapter.verifyPr = async () => ({ url: f.remote.pr.url, head: ++calls === 1 ? newHead : '9'.repeat(40) });
    await assert.rejects(accept(f, { head: newHead }), new RegExp(`The current PR head ${'9'.repeat(40)} differs from the accepted head ${newHead}`));
    assert.equal(f.task().prHead, head);
    assert.equal(f.events('owner_acceptance').length + f.events('owner_head_adopted').length, 0);
  } finally { await f.close(); }

  const g = fixture(); try {
    g.remote.pr.head = newHead;
    let calls = 0;
    g.adapter.verifyPr = async () => {
      // Another writer records a head between the observations.
      if (++calls === 2) g.store.update(g.taskId, { prHead: '9'.repeat(40) });
      return g.remote.pr;
    };
    await assert.rejects(accept(g, { head: newHead }), /refresh before retrying/);
    assert.equal(g.task().prHead, '9'.repeat(40), 'the other writer stands; nothing was adopted over it');
    assert.equal(g.events('owner_acceptance').length + g.events('owner_head_adopted').length, 0);
  } finally { await g.close(); }
});

test('209406f4: a head that moves after the adoption holds the merge; the acceptance binds only the head it named', async () => {
  const f = fixture({ mergePipeline: true }); try {
    f.store.putRepository({ origin: null, path: '/repo' }, 'queue', 'fixture keeps Queue closeout');
    f.adapter.mergeGate = async () => ({ head: f.remote.pr.head, base, wait: '' });
    f.remote.pr.head = newHead;
    const moved = await accept(f, { head: newHead });
    assert.equal(operatorSourceAcceptance(moved)?.head, newHead);
    f.remote.pr.head = '9'.repeat(40);
    for (let round = 0; round < 6; round++) await f.engine.wake();
    assert.equal(f.counts.merges, 0, 'the moved head is not merged under the acceptance');
    const after = f.task();
    assert.notEqual(after.phase, 'done', after.reason);
    assert.equal(after.phase, 'verifying');
    assert.match(after.reason, /the open PR no longer matches the accepted reviewed head/, 'the merge gate holds on the moved head');
    assert.equal(after.prHead, newHead, 'the stored head stays the accepted one; nothing adopts the moved head');
    assert.equal(operatorSourceAcceptance(after)?.head, newHead);
  } finally { await f.close(); }
});

test('209406f4 (Sol #603): an outlived approval is history at the forge gate; the named head merges under its acceptance', async () => {
  const f = fixture({ review: 'stale_ready', mergePipeline: true }); try {
    f.store.putRepository({ origin: null, path: '/repo' }, 'queue', 'fixture keeps Queue closeout');
    f.store.update(f.taskId, { prHead: oldHead });
    const moved = await accept(f, { head });
    // The forge gate reads the disposition, not the old approval it outlived:
    // verifying that approval against the named head would throw it stale.
    await requiredMergeReview(moved, { login: 'reviewer-login' });
    for (let round = 0; round < 12 && f.task().phase !== 'done'; round++) await f.engine.wake();
    assert.equal(f.task().phase, 'done', f.task().reason);
    assert.ok(f.counts.merges >= 1);
    assert.equal(outcomeSchema.parse(f.store.outcome(f.taskId)).ownerAcceptance?.head, head);
  } finally { await f.close(); }
});

test('209406f4 (Sol #603): a head pushed while a displaced turn is cancelled is re-observed before commit', async () => {
  const f = fixture(); try {
    f.remote.pr.head = newHead;
    f.store.putRun(runSchema.parse({
      id: 'live-revision', taskId: f.taskId, role: 'revision', generation: 1, head, base, agentId: 'worker-agent', workspaceId: 'workspace',
      profile: workerProfile, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: true, idleSince: null, completion: null, released: false,
    }));
    f.store.setCredential('live-revision', 'token');
    f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    let stops = 0;
    (f.adapter as unknown as { stopAgentTurn: (id: string) => Promise<void> }).stopAgentTurn = async () => {
      stops++;
      // The displaced author pushed once more before its turn stopped.
      f.remote.pr.head = '9'.repeat(40);
    };
    await assert.rejects(accept(f, { head: newHead }), new RegExp(`The current PR head ${'9'.repeat(40)} differs from the accepted head ${newHead}`));
    assert.equal(stops, 1, 'the observation follows the cancellation');
    assert.equal(f.task().prHead, head, 'nothing was adopted');
    assert.equal(f.events('owner_acceptance').length + f.events('owner_head_adopted').length + f.events('owner_control').length, 0);
  } finally { await f.close(); }
});
