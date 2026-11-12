import { profile } from './support/fakes';
import { COORDINATOR_LOOP_LIMIT, COORDINATOR_LOOP_SUMMARY, taskWorkIdentity, unproductiveCoordinatorRuns } from '../core/recovery/recovery-bound';
import { test } from './support/sharded-test';
import { whileReaderInTurn } from './support/reader-in-turn';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, digest, operationIdForKey, operationInputHash } from '../core/store/store';
import { Engine } from '../core/engine';
import { taskProgressDigest } from '../core/recovery/recovery';
import { collectOwnerVerbFacts, ownerControlEventDetail, ownerTaskNext } from '../core/verbs/owner-verbs';
import { reviewContinuationState } from '../core/review/review-continuation';
import { OPERATOR_BOARD_CALLER, REVISION_BUDGET, reviewDeliveryAuthorizationSchema, runSchema, submissionSchema, taskControlInputSchema, taskNextSchema, type Completion, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { RecoveryDispatchSnapshot } from '../core/recovery/recovery-context';
import { recoveryDispatchSnapshot } from '../core/recovery/recovery-context';
import { ownerReviewContext, type OwnerReviewContext } from '../core/review/owner-review-context';
import { queueOperationSchema } from '../shared/operations';
import { briefDigest } from '../core/planning/brief';
import { runPrompt } from '../core/dispatch/prompts';

/**
 * The general lifecycle rule (Tom, 2026-10-27): an authenticated coordinator's
 * report is requested verb intent. Queue derives the current identities from the
 * same task-scoped plan `next` shows, settles the episode bookkeeping and the
 * reporting run the transition obsoletes, and applies the transition. It never
 * answers `cannot` because of bookkeeping it owns, and repeated recovery that
 * moves no work is still bounded.
 *
 * These scenarios use the ordinary lifecycle: a retained worker error or an
 * authenticated reviewer checkpoint, the real coordinator episode, the
 * authenticated coordinator report, the ordinary verb registry and the real
 * continuation/delivery gates. A reviewer checkpoint opens no episode: Queue
 * continues it itself (Tom, 2026-10-31). Nothing here releases a run by hand,
 * refunds a budget or reviews the source.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40);

const worker = profile('worker', 'test/worker'), reviewer = profile('reviewer', 'test/reviewer'), coordinator = profile('coordinator', 'test/coordinator');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-coordinator-lifecycle-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewer.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
    { profileId: coordinator.id, enabled: true, group: 'coordinate', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Coordinated lifecycle', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  store.update(submitted.id, {
    phase: 'reviewing', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker', runId: 'worker-run', profile: worker, workerModel: worker.model, prHead: head,
    prUrl: 'https://github.com/example/repo/pull/7',
    completion: { taskId: submitted.id, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
  }, 'dispatched');
  const reviewerRunId = 'review-run';
  const reviewerRun = (id: string, agentId: string, created = new Date().toISOString(), at = head): Run => runSchema.parse({
    id, taskId: submitted.id, role: 'reviewer', generation: 1, head: at, base, agentId, workspaceId: 'workspace',
    profile: reviewer, status: 'running', createdAt: created, briefVersion: submitted.briefVersions.at(-1)?.version ?? null,
    lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
  });
  const tokens = new Map<string, string>([['reviewer-token', 'reviewer-token']]);
  store.putRun(reviewerRun(reviewerRunId, 'review-agent'));
  store.setCredential(reviewerRunId, 'reviewer-token');
  tokens.set(reviewerRunId, 'reviewer-token');
  store.update(submitted.id, { resolution: { ...store.task(submitted.id).resolution, currentRunId: reviewerRunId, reviewerAgentId: 'review-agent', reviewerProfile: reviewer } });

  const reviewerDeliveries: { runId: string; messageId: string; text: string }[] = [];
  const timeline: { timestamp: string; item: Record<string, unknown> }[] = [];
  const states = new Map<string, AgentObservation>([
    ['worker', { id: 'worker', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: worker.model }],
    ['review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: reviewer.model }],
  ]);
  const createdRuns: Run[] = [], stoppedTurns: string[] = [];
  /** Every run dispatch and the launch snapshot its prompt received. */
  const dispatches: { runId: string; role: Run['role']; path: 'create' | 'send'; context: RecoveryDispatchSnapshot | null; ownerContext?: OwnerReviewContext | null }[] = [];
  /** A store write another participant makes while Queue is observing (the observation race). */
  const hooks: { onObserve?: (id: string) => void; onVerifyPr?: () => void } = {};
  const idle = (id: string) => states.set(id, { ...states.get(id)!, active: false, status: 'idle' });
  const adapter = {
    profiles: async () => [worker, reviewer, coordinator], validate: async () => base,
    createWorkspace: async () => { throw new Error('fixtures do not create workspaces'); },
    findWorkspaces: async () => [], findAgents: async () => [], findRunAgents: async () => [],
    createAgent: async () => { throw new Error('fixtures do not create agents'); },
    observe: async (id: string) => {
      const observed = states.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' };
      hooks.onObserve?.(id);
      return observed;
    },
    archiveAgent: async () => {}, notify: async () => {},
    stopAgentTurn: async (id: string) => { stoppedTurns.push(id); idle(id); },
    verifyPr: async () => { hooks.onVerifyPr?.(); return { url: 'https://github.com/example/repo/pull/7', head: store.task(submitted.id).prHead ?? head }; },
    verifyPrIdentity: async () => ({ url: 'https://github.com/example/repo/pull/7', head: store.task(submitted.id).prHead ?? head, repository: 'example/repo', headRepository: 'example/repo' }),
    verifyCleanQueueWorktree: async () => {}, verifyReview: async () => {},
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }),
    syncMain: async () => head, verifyCloseout: async () => {},
    createRun: async (_t: Task, r: Run, token: string, context?: RecoveryDispatchSnapshot | null, ownerContext?: OwnerReviewContext | null) => {
      createdRuns.push(r); tokens.set(r.id, token); dispatches.push({ runId: r.id, role: r.role, path: 'create', context: context ?? null, ownerContext });
      const id = `agent-${r.id}`;
      states.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' });
      return { id, workspaceId: r.workspaceId };
    },
    sendRun: async (_t: Task, r: Run, token: string, context?: RecoveryDispatchSnapshot | null, ownerContext?: OwnerReviewContext | null) => { createdRuns.push(r); tokens.set(r.id, token); dispatches.push({ runId: r.id, role: r.role, path: 'send', context: context ?? null, ownerContext }); states.set(r.agentId!, { ...states.get(r.agentId!)!, active: true, status: 'running' }); },
    continueReviewer: async (_task: Task, r: Run, messageId: string, text: string, allowed: () => Promise<boolean>, stillAllowed: () => boolean) => {
      const before = states.get(r.agentId!)!;
      if (before.status !== 'idle' || before.active || before.permissions) return { sent: false as const, reason: 'reviewer not idle' };
      if (!await allowed()) return { sent: false as const, reason: 'authorization changed' };
      if (!stillAllowed()) return { sent: false as const, reason: 'reviewer or task fence changed' };
      reviewerDeliveries.push({ runId: r.id, messageId, text });
      timeline.push({ timestamp: new Date().toISOString(), item: { type: 'user_message', messageId, text } });
      return { sent: true as const };
    },
    agentTimeline: async () => timeline,
  } as unknown as Adapter & { supportsCoordinatorRecovery?: boolean };
  adapter.supportsCoordinatorRecovery = true;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker, reviewer, coordinator];
  const current = () => store.task(submitted.id);
  const run = (id = reviewerRunId) => store.run(id)!;
  const coordinatorRuns = () => store.runs(submitted.id).filter(item => item.role === 'recovery');
  const reviewerRuns = () => store.runs(submitted.id).filter(item => item.role === 'reviewer');
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, current())));
  const view = (verb: string) => next().verbs.find(item => item.verb === verb)!;
  const events = (kind: string) => store.eventsAll(submitted.id).filter(event => event.kind === kind);
  /** An authenticated reviewer progress checkpoint on the exact head, before its wake settles. */
  const reportCheckpoint = async (label: string, eventId: string = randomUUID(), runId = reviewerRunId) => engine.complete({ eventId, taskId: submitted.id, runId,
    status: 'review_in_progress' as const, head: store.run(runId)!.head, summary: label, reviewResponsibility: 'reviewer' as const,
    checkpoint: { covered: [label], remaining: ['the rest'] } }, tokens.get(runId)!) as Promise<{ accepted: true; eventId: string; checkpoint: { ordinal: number; continued: boolean; attention?: string } }>;
  /** The same checkpoint, settled; the reader reports from inside its own turn (see whileReaderInTurn). */
  const checkpoint = async (label: string, eventId: string = randomUUID(), runId = reviewerRunId) =>
    whileReaderInTurn(engine, store.run(runId)!.agentId, () => reportCheckpoint(label, eventId, runId));
  /** The coordinator's one typed report, through its own authenticated callback. */
  const coordinatorReport = async (action: Record<string, unknown>, runId: string, summary = 'Continue the unfinished work') => {
    const latest = store.run(runId)!;
    idle(latest.agentId!);
    await engine.complete({ eventId: randomUUID(), taskId: submitted.id, runId, status: 'recovered', summary,
      coordinatorAction: action, coordinatorGeneration: latest.generation } as Completion, tokens.get(runId)!);
    await engine.quiesce();
  };
  /** A fresh reviewer at the same exact head, as `move to=review` leaves one. */
  const freshReviewer = (label: string) => {
    const id = `review-${label}`, agentId = `review-agent-${label}`;
    store.putRun(reviewerRun(id, agentId));
    store.setCredential(id, `token-${label}`);
    tokens.set(id, `token-${label}`);
    states.set(agentId, { id: agentId, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: reviewer.model });
    store.update(submitted.id, { resolution: { ...current().resolution, currentRunId: id, reviewerAgentId: agentId, reviewerProfile: reviewer } });
    return id;
  };
  const ownerControl = async (input: Record<string, unknown>) =>
    engine.performTaskControl(taskControlInputSchema.parse({ taskId: submitted.id, version: current().version, caller: 'owner-thread', reason: 'Owner continues the work', ...input }));
  /** A coordinator run the previous release recorded: no launch detail, so no work identity. */
  const legacyRun = (index: number, at = head) => {
    store.putRun(runSchema.parse({ id: `legacy-${index}`, taskId: submitted.id, role: 'recovery', generation: 1,
      head: at, base, agentId: `legacy-agent-${index}`, workspaceId: 'workspace', profile: coordinator, status: 'finished',
      createdAt: new Date(Date.now() + index).toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null, released: true }));
    // The previous release recorded a launch without a work identity.
    store.event(submitted.id, 'telemetry_recovery', JSON.stringify({ runId: `legacy-${index}`, targetRole: 'reviewer', cause: 'the previous release' }));
  };
  const launchedCoordinators = () => store.runs(submitted.id).filter(item => item.role === 'recovery' && !item.id.startsWith('legacy-'));
  return { dir, store, engine, adapter, submitted, reviewerRunId, tokens, hooks, head, base, current, run, next, view, coordinatorRuns, reviewerRuns, events,
    reviewerDeliveries, createdRuns, dispatches, stoppedTurns, states, idle, legacyRun, launchedCoordinators, reportCheckpoint, checkpoint, coordinatorReport, freshReviewer, ownerControl,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Two passes: the first observes the reader's ended turn, the second lets Queue act on it. */
async function settle(f: ReturnType<typeof fixture>, passes = 2) {
  for (let pass = 0; pass < passes; pass++) { await f.engine.wake(); await f.engine.quiesce(); }
}

test('coordinator launches recorded during an outage do not spend the recovery bound', async () => {
  const f=fixture(); try {
    f.legacyRun(1);
    f.legacyRun(2);
    f.store.event(f.submitted.id,'telemetry_recovery',JSON.stringify({runId:'legacy-2',outage:true,work:taskWorkIdentity(f.current(),f.store)}));
    assert.equal(unproductiveCoordinatorRuns(f.store,f.submitted.id),1);
    f.legacyRun(3);
    assert.equal(unproductiveCoordinatorRuns(f.store,f.submitted.id),2,'an outage does not reset earlier charged launches');
  } finally { await f.close(); }
});

/**
 * A retained worker error on the PR: a stop the task's coordinator is asked
 * about. A reviewer checkpoint no longer is one, because Queue continues it
 * itself (Tom, 2026-10-31), so the generic coordinator machinery rides on this.
 */
async function workerErrorEpisode(f: ReturnType<typeof fixture>, runId = 'failed-revision') {
  f.store.putRun(runSchema.parse({ id: runId, taskId: f.submitted.id, role: 'revision', generation: 1, head, base,
    agentId: 'worker', workspaceId: 'workspace', profile: worker, status: 'finished', createdAt: new Date().toISOString(),
    lastObservedAt: null, active: false, idleSince: null, completion: null, released: true }));
  f.store.update(f.submitted.id, { phase: 'error', reason: 'Worker error: the build failed', agentActive: true, lastAgentStatus: 'running',
    completion: { taskId: f.submitted.id, runId, eventId: `worker-error-${runId}`, status: 'error', summary: 'The build failed', prNumber: 7 } }, 'worker_error');
  await f.engine.resolution.recovery.route(f.current());
  await f.engine.quiesce();
  const episode = f.coordinatorRuns().at(-1)!;
  assert.equal(f.current().resolution.recovery?.runId, episode.id, 'the worker error opened one coordinator episode');
  return episode;
}

test('a coordinator actually launched during a worker provider outage is not charged', async () => {
  const f=fixture(); try {
    f.store.setAvailability('author',JSON.stringify({group:'author',unavailable:true,reason:'Provider down',retryAt:null}));
    const run=await workerErrorEpisode(f);
    const launch=f.events('telemetry_recovery').find(event=>JSON.parse(event.detail).runId===run.id)!;
    assert.equal(JSON.parse(launch.detail).outage,true);
    assert.equal(unproductiveCoordinatorRuns(f.store,f.submitted.id),0);
    assert.equal(f.current().resolution.recoveryAttempts,0);
  } finally { await f.close(); }
});

test('a coordinator launched during a catalog provider outage is not charged', async () => {
  const f=fixture(); try {
    f.store.update(f.submitted.id,{profile:{...worker,provider:'pi'}});
    (f.engine as any).hostCatalogs.set('\u0000primary',{catalog:{providers:[{key:'pi',label:'Pi',available:false,problem:'Provider offline',models:[]}]},readAt:new Date().toISOString()});
    const run=await workerErrorEpisode(f);
    const launch=f.events('telemetry_recovery').find(event=>JSON.parse(event.detail).runId===run.id)!;
    assert.equal(JSON.parse(launch.detail).outage,true);
    assert.equal(unproductiveCoordinatorRuns(f.store,f.submitted.id),0);
    assert.equal(f.current().resolution.recoveryAttempts,0);
  } finally { await f.close(); }
});

/** The reader's delivered turn runs, as a real Paseo turn does, until the test ends it. */
function readerRunsDeliveredTurns(f: ReturnType<typeof fixture>) {
  const send = f.adapter.continueReviewer!;
  f.adapter.continueReviewer = async (...args) => {
    const result = await send(...args);
    if (result.sent) f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    return result;
  };
}

/** Turns delivered to the retained worker (each restart role=worker re-prompts it). */
const workerTurns = (f: ReturnType<typeof fixture>) => f.dispatches.filter(item => item.role === 'revision');

function ownerInstruction(f: ReturnType<typeof fixture>, instruction: string, version: number) {
  const input = taskControlInputSchema.parse({ taskId: f.submitted.id, version, action: 'restart', role: 'reviewer', fresh: true,
    caller: 'owner-thread', instruction, reason: 'Replace the reader' });
  const payload = { type: 'task_control', control: input }, key = `owner-${version}`;
  const operation = queueOperationSchema.parse({ id: operationIdForKey(key), key, kind: 'task_control', inputHash: operationInputHash(payload),
    state: 'succeeded', taskId: f.submitted.id, expectedVersion: version, createdAt: '2020-01-01T00:00:00.000Z', result: { taskId: f.submitted.id } });
  f.store.putOperation(operation, payload);
  f.store.event(f.submitted.id, 'owner_control', ownerControlEventDetail(f.current(), input, 'blocked', 'awaiting_review'));
  return operation;
}

test('owner reviewer context is attributed, bounded and superseded by current source facts', async () => {
  const f = fixture();
  try {
    const text = 'The inventory locator is lane version 33; lane version 38 identifies its report.';
    const brief = { version: 1, digest: briefDigest('brief'), mediaType: 'text/markdown', text: 'brief', reason: 'Submitted', pinnedAt: '2020-01-01T00:00:00.000Z' };
    f.store.update(f.submitted.id, { briefVersions: [brief] });
    const op = ownerInstruction(f, text, 10);
    f.store.putRun({ ...f.run(), reviewReason: text, briefVersion: 1, createdAt: '2099-01-01T00:00:00.000Z', released: true });
    const replacement = f.freshReviewer('context');
    const plan = () => ownerReviewContext(f.store, f.current(), f.run(replacement));
    const context = plan();
    assert.equal(context?.state, 'compatible');
    assert.equal(context?.source?.operationId, op.id);
    assert.equal(context?.source?.runId, f.reviewerRunId);
    assert.equal(context?.source?.text, text);
    const prompt = runPrompt(f.current(), f.run(replacement), '/helper', '/ticket', true, null, context);
    assert.match(prompt, /lane version 33/);
    assert.match(prompt, /not a new instruction or authority/);
    assert.match(prompt, /Do not select a route from it, replay an earlier proof/);
    f.store.update(f.submitted.id, { prHead: 'c'.repeat(40) });
    assert.equal(plan()?.state, 'historical');
    assert.equal(plan()?.source, undefined);
    f.store.update(f.submitted.id, { prHead: head, briefVersions: [brief, { ...brief, version: 2, text: 'amended', digest: briefDigest('amended') }] });
    assert.equal(plan()?.state, 'historical');
    f.store.update(f.submitted.id, { briefVersions: [brief] });
    ownerInstruction(f, 'A newer explicit instruction', 11);
    assert.equal(plan()?.state, 'unknown', 'a new instruction awaiting its reader does not inherit the earlier text');
    assert.equal(plan()?.source, undefined);
  } finally { await f.close(); }
});

test('an unproven previous reason cannot acquire owner provenance', async () => {
  const f = fixture();
  try {
    f.store.putRun({ ...f.run(), reviewReason: 'Source locator without an owner control', released: true });
    const replacement = f.freshReviewer('unknown-context');
    const context = ownerReviewContext(f.store, f.current(), f.run(replacement));
    assert.equal(context?.state, 'unknown');
    assert.equal(context?.source, undefined);
  } finally { await f.close(); }
});

test('completed reviewer impediments survive the shared recovery plan without becoming verdicts', async () => {
  const f = fixture();
  try {
    for (const status of ['blocked', 'error'] as const) {
      const id = f.freshReviewer(status);
      const result: Completion = { taskId: f.submitted.id, runId: id, eventId: `event-${status}`, status,
        head, summary: 'Owner proof remains outstanding', reviewResponsibility: 'environment' };
      f.store.putRun({ ...f.run(id), completion: result, released: true });
      f.store.update(f.submitted.id, { phase: status, resolution: { ...f.current().resolution, currentRunId: null } });
      const facts = collectOwnerVerbFacts(f.store, f.current());
      const next = f.next().outcome;
      const snapshot = recoveryDispatchSnapshot(facts, { cause: result.summary, target: 'reviewer', recoveryRunId: 'recovery' });
      assert.deepEqual(snapshot.outcome, next);
      assert.equal(next.impediment?.runId, id);
      assert.equal(next.impediment?.status, status);
      assert.equal(next.impediment?.reviewText, null);
      assert.equal(next.impediment?.retained, false);
      assert.match(next.decision, /Owner proof remains outstanding/);
      assert.match(next.decision, /not an approval/);
      assert.equal(next.accepted, null);
    }
    const blockedRun = f.run('review-error');
    f.store.event(f.submitted.id, 'blocked_review_evidence', blockedRun.id);
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, review: blockedRun.completion } });
    assert.equal(f.next().outcome.impediment?.retained, true);
    assert.equal(f.next().outcome.impediment?.current, true);
    const reader = f.freshReviewer('replacement');
    assert.equal(f.next().outcome.reader?.runId, reader);
    assert.match(f.next().outcome.decision, /current reader/);
    const revision = runSchema.parse({ ...f.run(reader), id: 'new-author', role: 'revision', agentId: 'author',
      completion: { taskId: f.submitted.id, runId: 'new-author', eventId: 'new-author-result', status: 'ready_for_review', head, summary: 'New author result' }, released: true });
    f.store.putRun(revision);
    f.store.update(f.submitted.id, { completion: revision.completion, resolution: { ...f.current().resolution, currentRunId: null } });
    assert.match(f.next().outcome.decision, /author returned ready_for_review/);
    f.store.update(f.submitted.id, { prHead: 'c'.repeat(40) });
    assert.equal(f.next().outcome.impediment?.currentHead, false);
    assert.match(f.next().outcome.decision, /independent review/);
  } finally { await f.close(); }
});

test('an authenticated completed blocker on a legacy task reaches next, coordinator launch and credentialed refresh', async () => {
  const f = fixture();
  try {
    // Responsible tasks route this owner proof gap to the planner ladder. This
    // case preserves the generic coordinator workflow for legacy task rows.
    f.store.update(f.submitted.id, { responsible: false });
    await f.engine.complete({ eventId: 'owner-proof-gap', taskId: f.submitted.id, runId: f.reviewerRunId,
      status: 'blocked', head, summary: 'Owner author proof is missing', reviewResponsibility: 'environment',
      reviewText: 'Source reading finished; owner proof is outstanding.' }, f.tokens.get(f.reviewerRunId)!);
    f.idle('review-agent');
    await f.engine.resolution.observe();
    await f.engine.quiesce();
    const plan = f.next();
    assert.equal(plan.outcome.impediment?.eventId, 'owner-proof-gap');
    assert.equal(plan.outcome.impediment?.retained, true);
    assert.match(plan.outcome.decision, /Owner author proof is missing/);
    assert.equal(plan.outcome.accepted, null);
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    const launch = f.dispatches.find(item => item.role === 'recovery');
    assert.ok(launch?.context);
    const episode = f.store.run(launch.runId)!;
    const refreshed = f.engine.recoveryTaskNextFromAgent({ taskId: f.submitted.id, runId: episode.id, token: f.tokens.get(episode.id)! });
    assert.deepEqual(launch.context.outcome.impediment, refreshed.outcome.impediment);
    assert.equal(launch.context.outcome.decision, refreshed.outcome.decision);
    assert.match(refreshed.outcome.decision, /not an approval/);
    await assert.rejects(f.ownerControl({ action: 'move', to: 'merge', reason: 'No approval' }), /review|accept|qualification|hold/i);
  } finally { await f.close(); }
});

test('a legacy task replacement receives the attributed owner locator beside the new action reason', async () => {
  const f = fixture();
  try {
    f.store.update(f.submitted.id, { responsible: false });
    const text = 'The inventory locator is lane version 33 and its report is in version 38.';
    const brief = { version: 1, digest: briefDigest('brief'), mediaType: 'text/markdown', text: 'brief', reason: 'Submitted', pinnedAt: '2020-01-01T00:00:00.000Z' };
    f.store.update(f.submitted.id, { briefVersions: [brief] });
    ownerInstruction(f, text, 10);
    f.store.putRun({ ...f.run(), reviewReason: text, briefVersion: 1, createdAt: '2099-01-01T00:00:00.000Z' });
    await f.engine.complete({ eventId: 'proof-gap', taskId: f.submitted.id, runId: f.reviewerRunId, status: 'blocked',
      head, summary: 'Author proof remains missing', reviewText: 'Reading completed', reviewResponsibility: 'environment' }, f.tokens.get(f.reviewerRunId)!);
    f.idle('review-agent');
    await f.engine.resolution.observe(); await f.engine.quiesce();
    await f.engine.resolution.recovery.route(f.current()); await f.engine.quiesce();
    const episode = f.coordinatorRuns().at(-1)!;
    await f.coordinatorReport({ verb: 'move', to: 'review', reason: 'A new reader was deliberately requested' }, episode.id);
    await f.engine.wake(); await f.engine.quiesce();
    const launch = f.dispatches.find(item => item.role === 'reviewer' && item.runId !== f.reviewerRunId);
    assert.ok(launch, 'the existing move dispatched the replacement');
    assert.equal(launch.ownerContext?.source?.text, text);
    assert.equal(launch.ownerContext?.source?.runId, f.reviewerRunId);
    assert.equal(f.store.run(launch.runId)?.reviewReason, 'A new reader was deliberately requested');
    assert.equal(f.next().outcome.accepted, null);
    const newRun = f.store.run(launch.runId)!;
    f.idle(newRun.agentId!);
    await f.engine.complete({ eventId: 'replacement-blocked', taskId: f.submitted.id, runId: newRun.id, status: 'blocked',
      head, summary: 'Owner ruling still missing', reviewResponsibility: 'environment' }, f.tokens.get(newRun.id)!);
    await f.engine.resolution.observe(); await f.engine.quiesce();
    const current = f.next().outcome;
    assert.equal(current.impediment?.eventId, 'replacement-blocked');
    assert.deepEqual(current.impediments.map(item => item.eventId), ['proof-gap', 'replacement-blocked']);
    assert.equal(current.impediment?.retained, true, 'a summary-only report replaces any earlier approval without becoming a verdict');
    assert.match(current.decision, /Owner ruling still missing/);
    assert.equal(current.accepted, null);
  } finally { await f.close(); }
});


test('Queue continues a retained reviewer through every successive checkpoint on the same run, with no coordinator', async () => {
  const f = fixture();
  try {
    // Tom, 2026-10-31: a reviewer checkpoint continues by itself once the
    // reader's turn has ended, as a worker checkpoint does.
    readerRunsDeliveredTurns(f);
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    for (const [index, label] of ['Reading chapter one', 'Reading chapter two', 'Reading chapter three'].entries()) {
      // The reader checkpoints from inside its turn; nothing continues until that turn ends.
      const receipt = await f.checkpoint(label);
      assert.equal(receipt.checkpoint.ordinal, index + 1);
      await settle(f);
      assert.equal(f.reviewerDeliveries.length, index, 'a reader still in its turn is not continued');
      f.idle('review-agent');
      await settle(f);
      assert.equal(f.reviewerDeliveries.length, index + 1, `checkpoint ${index + 1} reached exactly one continuation`);
      assert.equal(f.events('review_auto_continued').length, index + 1);
      assert.equal(f.coordinatorRuns().length, 0, 'no coordinator episode opened for the checkpoint');
    }
    // Further passes send nothing more: each delivery is at most once.
    f.idle('review-agent');
    await settle(f);
    assert.equal(f.reviewerDeliveries.length, 3);
    assert.deepEqual(f.reviewerDeliveries.map(item => item.runId), [f.reviewerRunId, f.reviewerRunId, f.reviewerRunId],
      'every continuation stayed on the retained reviewer run, so its coverage accumulated');
    assert.equal(f.reviewerRuns().length, 1, 'no fresh reviewer replaced it');
    assert.equal(f.run().reviewDeliveries?.map(item => item.checkpointOrdinal).join(','), '1,2,3');
    assert.equal(f.events('review_auto_continue_deferred').length, 0);
    assert.equal(f.events('owner_control').length, 0, 'Queue continued it; no owner verb was recorded');
  } finally { await f.close(); }
});

test('an owner stop holds the reviewer continuation; pause allows it to drain', async () => {
  const f = fixture();
  try {
    // The reader is still in its turn when it checkpoints, so nothing continues yet.
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    await f.checkpoint('Reading the diff');
    await f.ownerControl({ action: 'stop', reason: 'Owner looks at the review first' });
    f.idle('review-agent');
    await settle(f, 3);
    assert.equal(f.reviewerDeliveries.length, 0, 'the owner stop hold keeps Queue from continuing');
    assert.equal(f.events('review_auto_continued').length, 0);
    assert.equal(f.coordinatorRuns().length, 0, 'the held checkpoint opens no coordinator either');

    // Released while paused: the bound reviewer settles in flight.
    f.store.setMeta('paused', true);
    await f.ownerControl({ action: 'release', kind: 'dispatch', reason: undefined });
    await settle(f, 3);
    assert.equal(f.reviewerDeliveries.length, 1, 'pause allows the bound reviewer to continue');

    // Unpausing does not deliver a second continuation.
    f.store.setMeta('paused', false);
    await settle(f, 3);
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.reviewerDeliveries[0]!.runId, f.reviewerRunId);
    assert.equal(f.events('review_auto_continued').length, 1);
    assert.equal(f.coordinatorRuns().length, 0);
  } finally { await f.close(); }
});



test('the automatic reviewer continuation observes stale activity and settles a superseded run', async () => {
  const f = fixture();
  try {
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    await f.checkpoint('Reading the diff');
    const oldRun = runSchema.parse({ id: 'old-closeout', taskId: f.submitted.id, role: 'closeout', generation: 1,
      head, base, agentId: 'old-verifier', workspaceId: 'workspace', profile: coordinator, status: 'running',
      createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: true,
      idleSince: null, completion: null, released: false });
    f.store.putRun(oldRun);
    f.states.set('old-verifier', { id: 'old-verifier', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    const planned = f.view('restart');
    let observations = 0;
    f.hooks.onObserve = id => {
      if (id !== oldRun.agentId) return;
      observations++;
      // The participant stops after a read snapshots its running turn. That
      // snapshot cannot settle it, so the applying verb owes its own fresh read.
      if (observations === 1) f.idle(id);
    };
    // Queue's own continuation reaches the same fresh observation an owner
    // restart performs; the cached activity is not a reason to refuse.
    f.idle('review-agent');
    await settle(f, 3);
    assert.equal(f.events('review_auto_continued').length, 1);
    assert.equal(planned.available, true, JSON.stringify(planned));
    assert.match(planned.note ?? '', /old-closeout.*observ|observ.*old-closeout/i, 'the plan names the observation it needs');
    assert.ok(observations > 1, 'execution freshly observed the now-idle superseded participant');
    assert.equal(f.run(oldRun.id).released, true, 'the idle superseded run settled with the continuation');
    assert.equal(f.run(oldRun.id).completion, null, 'no result was invented for the old run');
    assert.deepEqual(f.stoppedTurns, [], 'no idle turn was cancelled');
    assert.deepEqual(f.reviewerDeliveries.map(item => item.runId), [f.reviewerRunId]);
    assert.equal(f.reviewerRuns().length, 1, 'coverage stays on the retained reviewer');
  } finally { await f.close(); }
});

test('the task-scoped view offers the restart the transition applies, and a direct owner verb settles the episode run', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    assert.equal(f.store.run(episode.id)!.released, false, 'the coordinator run is still unreleased');
    assert.equal(f.store.run(episode.id)!.completion, null, 'and has not reported yet');
    // The view is one task-scoped plan: every reader sees the restart the
    // transition will apply, not its own bookkeeping as a fence.
    const view = f.view('restart');
    assert.equal(view.available, true, JSON.stringify(view));
    assert.equal(workerTurns(f).length, 0, 'a read sends nothing');

    // The direct owner verb is the same transition: it displaces the episode's
    // own run durably (its live turn is cancelled first), then delivers once.
    await f.ownerControl({ action: 'restart', role: 'worker', instruction: 'Finish the build fixes' });
    await f.engine.wake(); await f.engine.quiesce();
    assert.equal(workerTurns(f).length, 1);
    assert.equal(f.store.run(episode.id)?.released, true, 'the episode run settled with the transition');
    assert.deepEqual(f.stoppedTurns, [episode.agentId], 'the working coordinator turn was cancelled, not orphaned');
    assert.equal(f.events('owner_stop_sent').length, 1);
    assert.equal(f.current().resolution.recoveryActive, false, 'the episode no longer owns the task');
  } finally { await f.close(); }
});


test('the coordinator run row still reads live and unreleased, and the transition settles it from its report', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    // The run row still carries the liveness bookkeeping the last observation
    // left. The report is the run's result, so the transition settles it without
    // another observation and never cancels the turn delivering it.
    f.store.putRun({ ...f.store.run(episode.id)!, active: true, status: 'running' });
    await f.coordinatorReport({ verb: 'restart', role: 'worker', instruction: 'Finish the build fixes', reason: 'Continue the worker' }, episode.id);
    assert.equal(workerTurns(f).length, 1, 'the restart applied');
    assert.equal(f.store.run(episode.id)?.released, true, 'its reporting run settled');
    assert.deepEqual(f.stoppedTurns, [], 'the reporting turn was never cancelled');
    assert.equal(f.events('coordinator_action_applied').length, 1);
  } finally { await f.close(); }
});


test('a coordinator report applies its own transition while a task observation lands during the verb', async () => {
  const f = fixture();
  try {
    // A retained worker error on the PR: one authenticated coordinator episode.
    const episode = await workerErrorEpisode(f);
    const before = f.current();
    let observations = 0, injected = 0;
    // A reader or Queue's own lifecycle pass records the worker's idle projection
    // while the reported verb is inside its awaited liveness read.
    f.hooks.onObserve = () => {
      observations++;
      if (injected) return;
      injected = 1;
      f.store.update(f.current().id, { agentActive: false, lastAgentStatus: 'idle', lastObservedAt: new Date().toISOString() });
    };
    await f.coordinatorReport({ verb: 'restart', role: 'worker', instruction: 'Finish the build fixes', reason: 'Continue the worker' }, episode.id);

    assert.equal(injected, 1, 'the observation race landed during the settlement');
    assert.ok(observations > 1, 'the reported verb kept observing after the raced write');
    assert.equal(f.events('coordinator_action_applied').length, 1, 'the authenticated report applied once');
    assert.equal(f.events('coordinator_action_refused').length, 0);
    assert.equal(f.store.run(episode.id)?.released, true, 'its reporting run settled with the transition');
    assert.equal(f.events('owner_stopped').length, 0, 'the reporting turn was never cancelled');
    assert.equal(workerTurns(f).length, 1, 'the worker continuation is delivered once');
    assert.ok(f.current().version > before.version, 'versions stay monotonic');
    assert.doesNotMatch(f.current().reason, /Task changed/, 'no false stale-version stop replaced the transition');
  } finally { await f.close(); }
});

test('a general coordinator verb settles the episode run too, not only a restart', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    await f.coordinatorReport({ verb: 'route', role: 'reviewer', profileId: reviewer.id, reason: 'Keep the reviewer on its current profile' }, episode.id);
    assert.equal(f.events('coordinator_action_applied').length, 1, 'the route applied through the shared plan');
    assert.equal(f.events('coordinator_action_refused').length, 0);
    assert.equal(f.store.run(episode.id)?.released, true, 'its reporting run settled with the transition');
    assert.equal(f.current().profileRequests?.reviewer?.profileId, reviewer.id);
  } finally { await f.close(); }
});


test('harmless bookkeeping does not refuse a report, while moved work supersedes the episode', async () => {
  const f = fixture();
  try {
    const asked = await workerErrorEpisode(f);
    // Genuine task work - a replaced initial worker - supersedes the episode.
    f.store.update(f.submitted.id, { agentId: 'worker-2' }, 'worker_remapped', 'Replacement worker');
    await f.coordinatorReport({ verb: 'restart', role: 'worker', instruction: 'Finish the build fixes', reason: 'Continue the worker' }, asked.id);
    assert.equal(f.events('coordinator_action_refused').length, 1, 'the replaced worker refused the old report');
    assert.equal(workerTurns(f).length, 0);
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    const current = f.coordinatorRuns().at(-1)!;
    assert.notEqual(current.id, asked.id, 'the current work gets its own coordinator');

    // A stop record that churns for the same condition is bookkeeping, not work.
    f.engine.resolution.recordStop(f.current(), 'operator_needed', 'Worker error: the build failed', ['restart']);
    await f.coordinatorReport({ verb: 'restart', role: 'worker', instruction: 'Finish the build fixes', reason: 'Continue the worker' }, current.id);
    assert.equal(f.events('coordinator_action_refused').length, 1, 'the stop churn refused nothing');
    assert.equal(f.events('coordinator_action_applied').length, 1, 'the current episode applies its own restart');
    assert.equal(workerTurns(f).length, 1);
  } finally { await f.close(); }
});


test('an uncertain continuation delivery is never resent, by Queue or through a coordinator', async () => {
  const f = fixture();
  try {
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    await f.checkpoint('Reading the diff');
    const record = f.run().reviewCheckpoints!.at(-1)!;
    f.store.putRun({ ...f.run(), reviewDeliveries: [reviewDeliveryAuthorizationSchema.parse({
      authorizationId: 'review-auth-1', operationId: 'review-operation-1', deliveryId: `ns-review-${'a'.repeat(64)}`,
      taskId: f.submitted.id, runId: f.reviewerRunId, head, checkpointOrdinal: record.ordinal, taskVersion: f.current().version,
      briefVersion: null, briefDigest: null, reason: 'Continue', instruction: 'Continue', createdAt: new Date().toISOString(),
      status: 'uncertain', evidence: 'the send outcome is unknown', observedAt: null }) ] });
    assert.equal(reviewContinuationState(f.current(), f.store), 'uncertain');
    f.idle('review-agent');
    await settle(f, 3);
    assert.equal(f.reviewerDeliveries.length, 0, 'Queue resent nothing');
    assert.equal(f.events('review_auto_continued').length, 0);
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    assert.equal(f.coordinatorRuns().length, 0, 'an uncertain delivery opens no coordinator episode');
    assert.equal(f.current().resolution.stop?.reason, 'operator_needed', 'a person inspects the uncertain send');
    // The owner's own restart is refused before any send.
    await assert.rejects(() => f.ownerControl({ action: 'restart', role: 'reviewer', reason: 'Continue anyway' }));
    assert.equal(f.reviewerDeliveries.length, 0, 'an uncertain delivery is never resent');
    assert.equal(f.run().reviewDeliveries?.[0].status, 'uncertain', 'the durable uncertain record is retained');
  } finally { await f.close(); }
});


test('a coordinator returns the work to its author through the same plan, settling its own run', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    // A worker-role transition requested by the report: the author gets the
    // instruction, the episode and its reporting run settle with it.
    await f.coordinatorReport({ verb: 'move', to: 'work', instruction: 'Address the build failure', reason: 'The author needs a source change' }, episode.id);
    assert.equal(f.events('coordinator_action_applied').length, 1, 'the worker move applied through the shared plan');
    assert.equal(f.store.run(episode.id)?.released, true, 'its reporting run settled with the transition');
    assert.equal(f.current().phase === 'working' || f.current().phase === 'changes_requested', true, `the task returned to its author (${f.current().phase})`);
    assert.equal(f.current().resolution.recoveryActive, false, 'the episode no longer owns the task');
    const revision = f.store.runs(f.submitted.id).findLast(item => item.role === 'revision' && item.id !== 'failed-revision');
    assert.match(revision?.instruction ?? '', /Address the build failure/, 'the author got the instruction');
  } finally { await f.close(); }
});

/** A task parked at the cap: the final findings applied with the allowance spent. */
async function parkAtCap(f: ReturnType<typeof fixture>) {
  f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, revisionRuns: REVISION_BUDGET } });
  await f.engine.complete({ eventId: 'exhausted-review', taskId: f.submitted.id, runId: f.reviewerRunId,
    status: 'changes_required', head, summary: 'Fix the finding', reviewText: 'Fix the finding',
    reviewCommentId: 4111, reviewResponsibility: 'author' }, f.tokens.get(f.reviewerRunId)!);
  f.idle('review-agent');
  await f.engine.resolution.observe();
  await f.engine.quiesce();
}

test('the owner at the board returns an author parked at the cap for exactly one round', async () => {
  const f = fixture();
  try {
    await parkAtCap(f);
    assert.equal(f.events('revision_budget_exhausted').length, 1, 'the cap parked the task');
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.submitted.id, version: f.current().version,
      action: 'move', to: 'work', instruction: 'Fix the finding with a different approach', reason: 'Owner chooses one more round',
      caller: OPERATOR_BOARD_CALLER }));
    await f.engine.quiesce();
    const rounds = f.store.runs(f.submitted.id).filter(run => run.role === 'revision');
    assert.equal(rounds.length, 1, 'the owner decision started one author round');
    assert.match(rounds[0]!.instruction ?? '', /different approach/);
    assert.equal(f.current().resolution.revisionRuns, REVISION_BUDGET + 1, 'the round is charged, so its findings park at the cap again');
  } finally { await f.close(); }
});

test('an unattributed caller cannot return an author parked at the cap', async () => {
  const f = fixture();
  try {
    await parkAtCap(f);
    await assert.rejects(() => f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.submitted.id, version: f.current().version,
      action: 'move', to: 'work', instruction: 'Fix the finding', reason: 'Continue', caller: 'some-other-thread' })),
      /operator at the board or a relayed operator authorization note/);
    assert.equal(f.store.runs(f.submitted.id).filter(run => run.role === 'revision').length, 0);
  } finally { await f.close(); }
});

test('a worker that stops inside an owner-approved round past the cap is ordinary coordinator recovery', async () => {
  const f = fixture();
  try {
    // Past the cap, but an author round started after the cap parked the task.
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, revisionRuns: REVISION_BUDGET + 1 } });
    f.store.event(f.submitted.id, 'revision_budget_exhausted', 'Revision budget exhausted after 6 review rounds; project owner disposition required');
    f.store.putRun(runSchema.parse({ id: 'failed-revision', taskId: f.submitted.id, role: 'revision', generation: 1, head, base,
      agentId: 'worker', workspaceId: 'workspace', profile: worker, status: 'finished', createdAt: new Date(Date.now() + 1000).toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: true }));
    f.store.update(f.submitted.id, { phase: 'error', reason: 'Worker error: the build failed', agentActive: true, lastAgentStatus: 'running',
      completion: { taskId: f.submitted.id, runId: 'failed-revision', eventId: 'worker-error', status: 'error', summary: 'The build failed', prNumber: 7 } }, 'worker_error');
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    const episode = f.coordinatorRuns().at(-1)!;
    await f.coordinatorReport({ verb: 'restart', role: 'worker', instruction: 'Finish the round', reason: 'Continue the retained worker' }, episode.id);
    assert.equal(f.events('coordinator_action_applied').length, 1, JSON.stringify(f.events('coordinator_action_refused')));
  } finally { await f.close(); }
});

test('a coordinator restarts a retained worker with its own reporting run', async () => {
  const f = fixture();
  try {
    // The retained worker reported an error on its PR, so the task needs
    // attention and a coordinator is asked about it.
    f.store.putRun(runSchema.parse({ id: 'failed-revision', taskId: f.submitted.id, role: 'revision', generation: 1, head, base,
      agentId: 'worker', workspaceId: 'workspace', profile: worker, status: 'finished', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: true }));
    f.store.update(f.submitted.id, { phase: 'error', reason: 'Worker error: the build failed', agentActive: true, lastAgentStatus: 'running',
      completion: { taskId: f.submitted.id, runId: 'failed-revision', eventId: 'worker-error', status: 'error', summary: 'The build failed', prNumber: 7 } }, 'worker_error');
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    const episode = f.coordinatorRuns().at(-1)!;
    assert.equal(f.current().resolution.recovery?.runId, episode.id, 'the error opened one coordinator episode');
    assert.equal(f.view('restart').available, true, 'the retained worker also needs fresh observation despite saved activity');

    // The coordinator restarts the retained worker: its own reporting run settles
    // with the transition, and the author gets the instruction.
    await f.coordinatorReport({ verb: 'restart', role: 'worker', instruction: 'Finish the remaining build fixes', reason: 'Continue the retained worker' }, episode.id);
    assert.equal(f.events('coordinator_action_applied').length, 1,
      `the worker restart applied through the shared plan: ${JSON.stringify(f.current().resolution.recovery?.action ?? {})} ${JSON.stringify(f.events('coordinator_action_refused'))}`);
    assert.equal(f.events('coordinator_action_refused').length, 0);
    assert.equal(f.store.run(episode.id)?.released, true, 'the reporting coordinator run settled');
    const revision = f.store.runs(f.submitted.id).findLast(item => item.role === 'revision' && item.id !== 'failed-revision');
    assert.equal(revision?.agentId, 'worker', 'the retained worker continues, not a replacement');
    assert.match(revision?.instruction ?? '', /Finish the remaining build fixes/);
    assert.equal(f.current().phase === 'working' || f.current().phase === 'changes_requested', true, `the task returned to its author (${f.current().phase})`);
  } finally { await f.close(); }
});


test('a run change during the displacement observation refuses before any cancellation intent', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    // The coordinator's run is observed idle, so the verb would settle it.
    f.idle(episode.agentId!);
    // Even an inactive observation must be rejected if its binding changes.
    // While Queue observes that run, its durable delivery state changes without a
    // task-version bump: an accepted report that is not yet released.
    f.hooks.onObserve = (id) => {
      if (id !== episode.agentId) return;
      f.hooks.onObserve = undefined;
      f.store.putRun({ ...f.store.run(episode.id)!, status: 'uncertain' });
    };
    const restart = { action: 'restart', role: 'worker', instruction: 'Finish the build fixes' };
    await assert.rejects(() => f.ownerControl(restart), /(Task or run changed|episode changed|delivery is unknown)/);
    assert.deepEqual(f.stoppedTurns, [], 'no turn was cancelled against the stale observation');
    assert.equal(f.events('owner_stop_intent').length, 0, 'no stop intent was written');
    assert.equal(workerTurns(f).length, 0, 'nothing was delivered');
    assert.equal(f.store.run(episode.id)?.released, false);

    // A changed episode binding refuses the same way, and only after the decision.
    f.store.putRun({ ...f.store.run(episode.id)!, status: 'running' });
    f.hooks.onObserve = (id) => {
      if (id !== episode.agentId) return;
      f.hooks.onObserve = undefined;
      const task = f.current();
      f.store.update(f.submitted.id, { resolution: { ...task.resolution,
        recovery: { ...task.resolution.recovery!, runId: 'another-run' } } }, 'fixture_episode_rebound');
    };
    await assert.rejects(() => f.ownerControl(restart), /(Task changed|episode changed)/);
    assert.deepEqual(f.stoppedTurns, [], 'the rebound episode was not cancelled against');
    assert.equal(f.events('owner_stop_intent').length, 0);
  } finally { await f.close(); }
});


test('the plan names fresh observation while execution keeps unrelated run and effect fences', async () => {
  const f = fixture();
  try {
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    await f.checkpoint('Reading the diff');
    const now = new Date().toISOString();

    // An unrelated run with unknown delivery cannot settle at all.
    f.store.putRun(runSchema.parse({ id: 'uncertain-closeout', taskId: f.submitted.id, role: 'closeout', generation: 1, head, base,
      agentId: null, workspaceId: 'workspace', profile: coordinator, status: 'uncertain', createdAt: now,
      lastObservedAt: null, active: null, idleSince: null, completion: null, released: false }));
    let view = f.view('restart');
    assert.equal(view.available, false, JSON.stringify(view));
    // Task 620 (PR 868): the fence names the blocking run-delivery effect.
    assert.match(view.refusal!, /run-delivery uncertain-closeout is uncertain: run uncertain-closeout has an uncertain delivery/);
    assert.match(view.refusal!, /restart re-creates it|wait for reconciliation/);
    // Queue's own continuation refuses the same way, records why once, and cancels nothing.
    f.idle('review-agent');
    await settle(f, 3);
    assert.equal(f.reviewerDeliveries.length, 0, 'the continuation could not settle the uncertain run');
    assert.equal(f.events('review_auto_continued').length, 0);
    assert.equal(f.events('review_auto_continue_deferred').length, 1, 'the refusal is recorded once, not every pass');
    assert.match(f.events('review_auto_continue_deferred')[0]!.detail, /uncertain-closeout/);
    assert.equal(f.events('owner_stop_intent').length, 0);
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    f.store.putRun({ ...f.store.run('uncertain-closeout')!, released: true, status: 'finished' });
    // The fixture settles the first delivery episode before constructing a new
    // live-participant fence. Its bound incident otherwise still owns recovery.
    const incident = f.current().resolution.incident;
    assert.ok(incident);
    assert.equal(incident.status, 'reconciling');
    assert.match(f.view('restart').refusal!, /Automatic reconciliation still owns the task incident/);
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution,
      incident: { ...incident, status: 'resolved', detail: 'The fixture settled the uncertain closeout delivery', updatedAt: now } } });

    // Saved activity requires observation; a genuinely live participant still
    // refuses execution and is never cancelled by a reviewer continuation.
    f.store.putRun(runSchema.parse({ id: 'live-closeout', taskId: f.submitted.id, role: 'closeout', generation: 1, head, base,
      agentId: 'verify-agent', workspaceId: 'workspace', profile: coordinator, status: 'running', createdAt: now,
      lastObservedAt: now, active: true, idleSince: null, completion: null, released: false }));
    f.states.set('verify-agent', { id: 'verify-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    view = f.view('restart');
    assert.equal(view.available, true, JSON.stringify(view));
    assert.match(view.note!, /observ.*live-closeout/s);
    f.idle('review-agent');
    for (const state of [
      { status: 'running', active: true, activeTurnId: null, permissions: false },
      { status: 'idle', active: false, activeTurnId: 'still-reading', permissions: false },
      { status: 'idle', active: false, activeTurnId: null, permissions: true },
      { id: 'another-agent', status: 'idle', active: false, activeTurnId: null, permissions: false },
      { id: 'verify-agent', workspaceId: 'another-workspace', status: 'idle', active: false, activeTurnId: null, permissions: false },
    ]) {
      f.states.set('verify-agent', { id: 'verify-agent', workspaceId: 'workspace', error: '', ...state });
      await assert.rejects(() => f.ownerControl({ action: 'restart', role: 'reviewer' }), /live-closeout.*(active|permission|unreadable|workspace)/s);
      assert.equal(f.run('live-closeout').released, false);
    }
    assert.equal(f.reviewerDeliveries.length, 0);
    assert.deepEqual(f.stoppedTurns, [], 'an unrelated live run is never cancelled by a reviewer continuation');
  } finally { await f.close(); }
});


test('legacy recovery history does not keep the bound exhausted after substantive progress', async () => {
  const f = fixture();
  try {
    // The previous release left three unbound coordinator runs behind this
    // stopped state at this exact head.
    for (let index = 0; index < COORDINATOR_LOOP_LIMIT; index++) f.legacyRun(index);
    f.store.update(f.submitted.id, { phase: 'error', reason: 'Integration check failed',
      resolution: { ...f.current().resolution, attention: true } });

    // With no work movement, legacy churn still bounds recovery.
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    assert.equal(f.current().resolution.recovery?.summary, COORDINATOR_LOOP_SUMMARY, 'unchanged legacy churn still escalates');
    assert.equal(f.launchedCoordinators().length, 0, 'no coordinator launches past the legacy bound');

    // A new source head is substantive progress: the legacy runs cannot be
    // charged to the new work, so the ordinary coordinator is asked again.
    const nextHead = 'c'.repeat(40);
    f.store.update(f.submitted.id, { prHead: nextHead, resolution: { ...f.current().resolution, recovery: null, recoveryActive: false, attention: false } });
    f.store.putRun({ ...f.store.run(f.reviewerRunId)!, head: nextHead });
    await workerErrorEpisode(f, 'failed-at-new-head');
    assert.equal(f.launchedCoordinators().length, 1, 'the new head gets its own coordinator');
    assert.notEqual(f.current().resolution.recovery?.summary, COORDINATOR_LOOP_SUMMARY);
    assert.equal(unproductiveCoordinatorRuns(f.store, f.submitted.id) < COORDINATOR_LOOP_LIMIT, true);
  } finally { await f.close(); }
});

test('a conflicting or missing participant observation refuses before the episode run is settled', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    const agent = episode.agentId!;
    const saveObserve = f.adapter.observe;
    const working = { id: agent, workspaceId: 'workspace', status: 'running' as const, active: true, permissions: false, error: '' };
    const refused = /does not match|outside the run workspace|cannot be observed|could not observe/;
    const settleRefused = async (label: string) => {
      for (const intent of [{ action: 'restart', role: 'worker', instruction: 'Finish the build fixes' }, { action: 'move', to: 'work', instruction: 'Finish the build fixes' }])
        await assert.rejects(() => f.ownerControl(intent), refused, `${label}: ${intent.action}`);
      assert.equal(f.store.run(episode.id)?.released, false, `${label}: the coordinator run was not released`);
      assert.equal(workerTurns(f).length, 0, `${label}: nothing was delivered`);
      assert.equal(f.events('owner_stop_intent').length, 0, `${label}: no cancellation intent was written`);
    };

    // A failed read proves nothing about this participant.
    f.states.set(agent, working);
    for (const message of ['transport down', 'agent not found', 'agent missing']) {
      (f.adapter as { observe: typeof saveObserve }).observe = async id => {
        if (id === agent) throw new Error(message);
        return saveObserve(id);
      };
      await settleRefused(message);
    }
    (f.adapter as { observe: typeof saveObserve }).observe = saveObserve;

    // A live turn observed under another agent identity proves nothing about
    // this participant.
    f.states.set(agent, { ...working, id: 'someone-else' });
    await settleRefused('conflicting agent identity');
    // Nor does a live turn observed in another workspace.
    f.states.set(agent, { ...working, workspaceId: 'elsewhere' });
    await settleRefused('conflicting workspace');
    // Only the matching participant settles, after its turn is cancelled.
    f.states.set(agent, { id: agent, workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
    await f.ownerControl({ action: 'restart', role: 'worker', instruction: 'Finish the build fixes' });
    assert.equal(f.store.run(episode.id)?.released, true, 'the coordinator run released after its own turn was cancelled');
    assert.deepEqual(f.stoppedTurns, [agent], 'the coordinator turn was cancelled, not orphaned');
    await f.engine.wake(); await f.engine.quiesce();
    assert.equal(workerTurns(f).length, 1, 'the matching observation settled the run and the worker continued');
  } finally { await f.close(); }
});


test('a reported episode carrying a durable effect is never settled over it', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    // The coordinator reports, but its run still owes a durable effect: a
    // recorded report is its result and never settles that effect.
    const reported = f.store.run(episode.id)!;
    f.store.putRun({ ...reported, completion: { taskId: f.submitted.id, runId: episode.id, eventId: 'coordinator-report',
      status: 'recovered', summary: 'Continue the worker', coordinatorAction: { verb: 'restart', role: 'worker', reason: 'Continue' },
      coordinatorGeneration: reported.generation } });
    f.store.putRun({ ...f.store.run(episode.id)!, reviewDeliveries: [reviewDeliveryAuthorizationSchema.parse({
      authorizationId: 'episode-auth', operationId: 'episode-operation', deliveryId: `ns-review-${'b'.repeat(64)}`,
      taskId: f.submitted.id, runId: episode.id, head, checkpointOrdinal: 1, taskVersion: f.current().version,
      briefVersion: null, briefDigest: null, reason: 'episode effect', instruction: 'episode effect',
      createdAt: new Date().toISOString(), status: 'reserved', evidence: '', observedAt: null })] });

    // The applying restart refuses with the durable reason instead of releasing
    // the episode over the effect. Task 620 (PR 868): the fence names the
    // in-flight review delivery.
    await assert.rejects(() => f.ownerControl({ action: 'restart', role: 'worker', instruction: 'Finish the build fixes' }),
      /durable side effect Queue will not act over blindly \(review-delivery ns-review-b{64} is in-flight: review delivery ns-review-b{64} on run .* is reserved\)/);
    assert.equal(workerTurns(f).length, 0, 'nothing was delivered');
    assert.equal(f.store.run(episode.id)?.released, false, 'the reported episode run was not released');
    assert.equal(f.events('owner_stop_sent').length, 0, 'nothing was cancelled');
  } finally { await f.close(); }
});


test('a durable effect recorded during the continuation observation refuses at the settlement boundary', async () => {
  const f = fixture();
  try {
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    await f.checkpoint('Reading the diff');
    f.idle('review-agent');
    const settling = runSchema.parse({ id: 'settling-closeout', taskId: f.submitted.id, role: 'closeout', generation: 1, head, base,
      agentId: 'settling-agent', workspaceId: 'workspace', profile: coordinator, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: false });
    f.store.putRun(settling);
    f.states.set('settling-agent', { id: 'settling-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
    // The remote PR proof is the last asynchronous observation before the
    // superseded run settles. A durable effect recorded there must refuse the
    // settlement instead of delivering over it.
    f.hooks.onVerifyPr = () => {
      f.hooks.onVerifyPr = undefined;
      f.store.putRun({ ...f.store.run(settling.id)!, reviewDeliveries: [reviewDeliveryAuthorizationSchema.parse({
        authorizationId: 'late-auth', operationId: 'late-operation', deliveryId: `ns-review-${'c'.repeat(64)}`,
        taskId: f.submitted.id, runId: settling.id, head, checkpointOrdinal: 1, taskVersion: f.current().version,
        briefVersion: null, briefDigest: null, reason: 'late effect', instruction: 'late effect',
        createdAt: new Date().toISOString(), status: 'reserved', evidence: '', observedAt: null })] });
    };
    await assert.rejects(() => f.ownerControl({ action: 'restart', role: 'reviewer' }),
      /durable side effect Queue will not act over blindly \(review-delivery ns-review-c{64} is in-flight: review delivery ns-review-c{64} on run settling-closeout is reserved\)/);
    assert.equal(f.reviewerDeliveries.length, 0, 'the continuation was not delivered over the late effect');
    assert.equal(f.store.run(settling.id)?.released, false, 'the superseded run stays held');
    assert.equal(f.events('owner_control').length, 0, 'no owner control was recorded as applied');
  } finally { await f.close(); }
});


test('a refused restart leaves the working coordinator uncancelled', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    const agent = episode.agentId!;
    f.states.set(agent, { ...f.states.get(agent)!, status: 'running', active: true });

    // The retained worker is still live, so its restart refuses after its own
    // checks: the coordinator's turn must not have been touched.
    f.states.set('worker', { ...f.states.get('worker')!, status: 'running', active: true });
    await assert.rejects(() => f.ownerControl({ action: 'restart', role: 'worker', instruction: 'Finish the build fixes' }), /active|live|turn/i);
    assert.equal(f.events('owner_stop_intent').length, 0, 'no cancellation intent was written');
    assert.deepEqual(f.stoppedTurns, [], 'no turn was cancelled');
    assert.equal(f.store.run(episode.id)?.released, false, 'the coordinator run is untouched');
    assert.equal(workerTurns(f).length, 0);
  } finally { await f.close(); }
});


test('a delivered continuation is not offered as a continuation any executor can send', async () => {
  const f = fixture();
  try {
    await f.checkpoint('Reading the diff');
    await settle(f);
    assert.equal(f.reviewerDeliveries.length, 1, 'Queue delivered the checkpoint continuation');
    const delivery = f.run().reviewDeliveries?.at(-1)!;
    assert.equal(delivery.status, 'delivered');

    // The same-retained continuation is spent: the plan refuses it and names the
    // exits an owner actually has, instead of advertising a turn nothing sends.
    const view = f.view('restart');
    assert.equal(view.available, false, JSON.stringify(view));
    assert.match(view.refusal!, /already has its delivered continuation/);
    assert.match(view.refusal!, /route role=reviewer/);
    assert.match(view.refusal!, /restart role=reviewer fresh|move to=review/);
    // The ordinary owner exits stay offered and are the ones the refusal names.
    assert.equal(f.next().verbs.find(item => item.verb === 'route' && item.args?.role === 'reviewer')?.available, true);
    assert.equal(f.next().verbs.find(item => item.verb === 'move' && item.args?.to === 'review')?.available, true);

    // A changed intent is refused with the same truthful reason and never sends;
    // neither do further passes.
    await assert.rejects(() => f.ownerControl({ action: 'restart', role: 'reviewer', reason: 'Read a bit further' }), /already has its delivered continuation/);
    await settle(f);
    assert.equal(f.reviewerDeliveries.length, 1, 'no second turn was sent');
    assert.equal(f.run().reviewDeliveries?.length, 1);
  } finally { await f.close(); }
});


test('a delivered turn needs its own later matching observation before it is reported stopped', async () => {
  const f = fixture();
  try {
    // The idle observation that admitted delivery says nothing about the turn
    // that delivery starts.
    readerRunsDeliveredTurns(f);
    await f.checkpoint('Reading the diff');
    await settle(f);
    assert.equal(f.reviewerDeliveries.length, 1, 'Queue continued the idle reader');
    assert.match(f.current().reason, /Reviewer continuing from checkpoint 1/, 'pre-delivery inactivity cannot stop the newly delivered turn');
    const oldInventory = new Map([['review-agent', { ...f.states.get('review-agent')!, status: 'idle' as const, active: false }]]);
    await f.engine.resolution.observe(oldInventory);
    assert.equal(f.run().active, true, 'a pre-delivery inventory cannot stop the newly delivered turn');
    await f.engine.wake();
    await f.engine.quiesce();
    assert.equal(f.run().active, true, 'ordinary observation follows the delivered turn');
    assert.doesNotMatch(f.current().reason, /stopped without/);

    // A turn or permission remains live even if the adapter's coarse active
    // flag is false. Neither is evidence that delivered work has stopped.
    for (const activity of [{ activeTurnId: 'reading-turn' }, { permissions: true }]) {
      f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'idle', active: false,
        activeTurnId: null, permissions: false, ...activity });
      await f.engine.wake();
      await f.engine.quiesce();
      assert.equal(f.run().active, true);
      assert.doesNotMatch(f.current().reason, /stopped without/);
    }
    f.states.set('review-agent', { ...f.states.get('review-agent')!, activeTurnId: null, permissions: false });

    // A conflicting inactive participant cannot overwrite the working run's
    // observation, even when it is returned for the requested agent.
    f.states.set('review-agent', { ...f.states.get('review-agent')!, id: 'someone-else', status: 'idle', active: false });
    await f.engine.wake();
    await f.engine.quiesce();
    assert.equal(f.run().active, true, 'another participant proves no inactivity');
    assert.doesNotMatch(f.current().reason, /stopped without/);

    // A matching later observation is the honest stopped-delivery case. No
    // manual saved-flag update stands in for observing that actual participant.
    f.states.set('review-agent', { ...f.states.get('review-agent')!, id: 'review-agent', status: 'error', active: false });
    await f.engine.wake();
    await f.engine.quiesce();
    assert.match(f.current().reason, /delivered continuation for checkpoint 1 .*stopped without/);
    assert.equal(f.current().resolution.stop?.reason, 'operator_needed');
    assert.equal(f.reviewerDeliveries.length, 1, 'observations never resend delivered work');
  } finally { await f.close(); }
});


test('a delivered continuation whose retained run stopped is reported as a stopped delivery', async () => {
  const f = fixture();
  try {
    readerRunsDeliveredTurns(f);
    await f.checkpoint('Reading the diff');
    await settle(f);
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.match(f.current().reason, /Reviewer continuing from checkpoint 1/, 'a delivered continuation reads as continuing while it runs');

    // The reviewer reads further, then fails on provider capacity: the run is
    // observed errored with no active turn and no permission, same identity.
    f.states.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'error', active: false, permissions: false,
      error: 'Selected model is at capacity', provider: 'test', model: reviewer.model });
    await f.engine.wake();
    await f.engine.quiesce();

    // The task no longer claims the reviewer is continuing: the stop names the
    // delivered checkpoint, the run and agent, and the ordinary exits.
    assert.doesNotMatch(f.current().reason, /Reviewer continuing from checkpoint/);
    assert.match(f.current().reason, /delivered continuation for checkpoint 1 .*stopped without a verdict or a new checkpoint/);
    assert.match(f.current().reason, /route the reviewer to an available profile|fresh reviewer/);
    assert.equal(f.current().resolution.stop?.reason, 'operator_needed');
    // The evidence is preserved: checkpoint, delivery and run identity are intact.
    assert.equal(f.run().reviewCheckpoints?.length, 1);
    assert.equal(f.run().reviewDeliveries?.[0].status, 'delivered');
    assert.equal(f.current().resolution.currentRunId, f.reviewerRunId);
  } finally { await f.close(); }
});


test('an exact head, identity or owner hold keeps its ordinary handling', async () => {
  const f = fixture();
  try {
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    await f.checkpoint('Reading the diff');
    // A moved exact head is work: the continuation cannot carry it.
    f.store.update(f.submitted.id, { prHead: 'd'.repeat(40) });
    assert.equal(f.view('restart').available, false, JSON.stringify(f.view('restart')));
    assert.match(f.view('restart').refusal!, /head|exact recorded PR head/);
    assert.equal(f.reviewerDeliveries.length, 0);
    f.store.update(f.submitted.id, { prHead: head });

    // A changed reviewer identity is not the retained reviewer.
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, reviewerAgentId: 'someone-else' } });
    assert.equal(f.view('restart').available, false);
    assert.match(f.view('restart').refusal!, /identity/i);
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, reviewerAgentId: 'review-agent' } });

    // An operator dispatch hold defers the continuation: nothing is sent while
    // the hold stands, by Queue or by the owner, and the recorded verb is the same one.
    f.store.update(f.submitted.id, { held: true, holds: { dispatch: { owner: 'operator', reason: 'Operator hold: maintenance',
      at: new Date().toISOString(), generation: f.current().coordinatorGeneration, until: null } } });
    f.idle('review-agent');
    await settle(f, 3);
    assert.equal(f.reviewerDeliveries.length, 0, 'Queue does not continue a held reader');
    assert.equal(f.events('review_auto_continued').length, 0);
    await f.ownerControl({ action: 'restart', role: 'reviewer' });
    assert.equal(f.reviewerDeliveries.length, 0, 'nothing was sent while dispatched work is held');
    assert.equal(f.current().resolution.deferredVerb?.why, 'held');
    assert.equal(f.current().resolution.deferredVerb?.target?.runId, f.reviewerRunId);
  } finally { await f.close(); }
});


test('routes and retained restarts at unchanged work never refill the coordinator bound; an explicit coordinator restart re-arms it', async () => {
  const f = fixture();
  try {
    // The bound is spent at this head: the previous release's unbound runs.
    for (let index = 0; index < COORDINATOR_LOOP_LIMIT; index++) f.legacyRun(index);
    f.store.update(f.submitted.id, { phase: 'error', reason: 'Integration check failed',
      resolution: { ...f.current().resolution, attention: true } });
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    assert.equal(f.current().resolution.recovery?.summary, COORDINATOR_LOOP_SUMMARY);
    assert.equal(f.current().resolution.recovery?.status, 'escalated');
    assert.equal(f.launchedCoordinators().length, 0, 'no coordinator launches past the bound');
    const charged = unproductiveCoordinatorRuns(f.store, f.submitted.id);
    assert.equal(charged >= COORDINATOR_LOOP_LIMIT, true);
    const boundStop = f.next().stop!;
    assert.match(boundStop.detail, /one explicit restart role=coordinator re-arms it/);

    // Tom, 2026-10-27: a routine route change and the ordinary retained restart
    // the owner uses to keep stuck work moving do not refill the bound.
    await f.ownerControl({ action: 'route', role: 'reviewer', profileId: reviewer.id });
    assert.equal(unproductiveCoordinatorRuns(f.store, f.submitted.id), charged, 'a route change at unchanged work does not refill the bound');
    await f.ownerControl({ action: 'restart', role: 'worker', instruction: 'Fix the integration check' });
    await f.engine.wake(); await f.engine.quiesce();
    assert.equal(unproductiveCoordinatorRuns(f.store, f.submitted.id), charged, 'a routine retained restart does not refill the bound');
    // The same work stops again at the same head: still no coordinator launch.
    for (const run of f.store.runs(f.submitted.id).filter(item => item.role === 'revision' && !item.released))
      f.store.putRun({ ...run, status: 'finished', released: true, active: false });
    f.idle('worker');
    f.store.update(f.submitted.id, { phase: 'error', reason: 'Integration check failed',
      resolution: { ...f.current().resolution, attention: true } });
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    assert.equal(f.launchedCoordinators().length, 0, 'the restart bought no coordinator launch');
    assert.equal(f.current().resolution.recovery?.summary, COORDINATOR_LOOP_SUMMARY);

    // An authenticated coordinator report naming the same verb must not buy its
    // own allowance: the re-arm belongs to the owner's explicit action alone.
    const reportContext = f.engine as unknown as { coordinatorActionRunId: { run<T>(value: boolean, work: () => Promise<T>): Promise<T> } };
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution,
      recovery: { ...f.current().resolution.recovery!, progress: taskProgressDigest(f.current()) } } });
    const versionBefore = f.current().version, eventsBefore = f.store.eventsAll(f.submitted.id).length;
    await assert.rejects(reportContext.coordinatorActionRunId.run(true, () => f.ownerControl({ action: 'restart', role: 'coordinator' })),
      /No resolution action needs retry|No resolution run|not applied|refused/i);
    assert.equal(f.events('coordinator_rearm').length, 0, 'a coordinator report recorded no re-arm');
    assert.equal(unproductiveCoordinatorRuns(f.store, f.submitted.id), charged, 'the coordinator report did not reset the bound');
    assert.equal(f.current().resolution.recovery?.status, 'escalated', 'the episode keeps its ownership and evidence');
    assert.equal(f.current().version, versionBefore, 'the refused coordinator attempt changed nothing');
    assert.equal(f.store.eventsAll(f.submitted.id).length, eventsBefore, 'its settlement rolled back');
    // The worker's errored run is the one an explicit coordinator restart resumes.
    const errored = f.store.runs(f.submitted.id).findLast(item => item.role === 'revision')!;
    f.store.putRun({ ...errored, completion: { taskId: f.submitted.id, runId: errored.id, eventId: `error-${errored.id}`, status: 'error',
      summary: 'The integration check failed', prNumber: 7 } });
    await f.ownerControl({ action: 'restart', role: 'coordinator' });
    assert.equal(unproductiveCoordinatorRuns(f.store, f.submitted.id), 0, 'the explicit coordinator restart reset the bound');
  } finally { await f.close(); }
});


test('an episode with no progress digest never matches a report, even at its exact stop', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    const stop = f.current().resolution.stop!;
    const undigested = { ...f.current().resolution.recovery!, progress: undefined, key: digest(`stop:${stop.reason}:${stop.since}`) };
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, recovery: undigested } });
    await f.coordinatorReport({ verb: 'restart', role: 'worker', instruction: 'Finish the build fixes', reason: 'Continue the retained worker' }, episode.id);
    assert.equal(f.events('coordinator_action_applied').length, 0, 'a report never applies to an episode it cannot match');
    assert.equal(workerTurns(f).length, 0);
  } finally { await f.close(); }
});


test('a recovery coordinator launches with the plan next derives, and reads that plan with its own run credential', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    const launch = f.dispatches.find(item => item.runId === episode.id);
    assert.ok(launch, 'the coordinator run was dispatched');
    // The dispatched prompt receives the snapshot: the wiring, not only the prompt text, carries it.
    const snapshot = launch.context!;
    assert.ok(snapshot, 'the dispatch carried a launch snapshot');
    assert.equal(snapshot.why.recoveryRunId, episode.id);
    assert.match(snapshot.why.cause ?? '', /Worker error/, 'the coordinator is told why it was asked');
    assert.equal(snapshot.stop?.kind, 'attention');
    assert.ok(!snapshot.verbs.some(verb => verb.refusal?.includes(episode.id)), 'the coordinator\'s own pending launch is not a refusal');
    // The restart is offered from the same plan `next` derives.
    const restart = snapshot.verbs.find(verb => verb.verb === 'restart')!;
    assert.equal(restart.available, true);
    assert.equal(restart.args?.action, undefined, 'identity and plumbing fields are not offered as report fields');
    // Its own run credential reads the same plan through the refresh path.
    const plan = f.engine.recoveryTaskNextFromAgent({ taskId: f.submitted.id, runId: episode.id, token: f.tokens.get(episode.id)! });
    assert.deepEqual(plan.verbs, f.next().verbs);
    assert.equal(workerTurns(f).length, 0, 'reading the plan sends nothing');
    // A retained reviewer's credential reads nothing: only the recovery coordinator reads the plan this way.
    assert.throws(() => f.engine.recoveryTaskNextFromAgent({ taskId: f.submitted.id, runId: f.reviewerRunId, token: 'reviewer-token' }), /Only the recovery coordinator/);
  } finally { await f.close(); }
});


test('every recovery dispatch carries its launch snapshot, and an offered move still applies through current facts', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    // The snapshot is observation: the same move the plan offers still applies by current facts.
    const launch = f.dispatches.find(item => item.runId === episode.id)!;
    assert.equal(launch.context?.verbs.find(verb => verb.verb === 'move' && verb.args?.to === 'work')?.available, true);
    await f.coordinatorReport({ verb: 'move', to: 'work', instruction: 'Fix the build', reason: 'Return the author' }, episode.id);
    assert.equal(f.events('coordinator_action_applied').length, 1, 'the offered move applied');
    // Every recovery dispatch of this task carried a snapshot, whichever path launched it.
    const recoveries = f.dispatches.filter(item => item.role === 'recovery');
    assert.ok(recoveries.length >= 1);
    for (const item of recoveries) assert.ok(item.context, `${item.path} dispatch ${item.runId} carried a snapshot`);
  } finally { await f.close(); }
});


test('a stale launch snapshot cannot apply a restart after the owner has moved the task on', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    const launch = f.dispatches.find(item => item.runId === episode.id)!;
    assert.equal(launch.context?.verbs.some(verb => verb.verb === 'restart' && verb.available), true, 'the snapshot offered a restart');
    // The owner moves the task on after the launch snapshot was taken.
    await f.ownerControl({ action: 'move', to: 'work', instruction: 'Fix the build', reason: 'Owner returns the author' });
    assert.equal(f.store.run(episode.id)?.released, true, 'the owner move settled the coordinator run');
    await f.engine.wake(); await f.engine.quiesce();
    const afterMove = workerTurns(f).length;
    // The stale report is refused or rejected by current facts; either way it applies nothing.
    await f.coordinatorReport({ verb: 'restart', role: 'worker', instruction: 'Continue from the snapshot', reason: 'Continue from the snapshot' }, episode.id).catch(() => undefined);
    assert.equal(workerTurns(f).length, afterMove, 'the worker was never restarted from the stale snapshot');
    assert.equal(f.events('coordinator_action_applied').length, 0, 'no coordinator action applied');
  } finally { await f.close(); }
});

test('a coordinator asked about a retained worker error launches with that stop, its recorded result and no checkpoint', async () => {
  const f = fixture();
  try {
    // The retained worker reported an error on its PR, so a coordinator is asked about it.
    f.store.putRun(runSchema.parse({ id: 'failed-revision', taskId: f.submitted.id, role: 'revision', generation: 1, head, base,
      agentId: 'worker', workspaceId: 'workspace', profile: worker, status: 'finished', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: true }));
    f.store.update(f.submitted.id, { phase: 'error', reason: 'Worker error: the build failed', agentActive: true, lastAgentStatus: 'running',
      completion: { taskId: f.submitted.id, runId: 'failed-revision', eventId: 'worker-error', status: 'error', summary: 'The build failed', prNumber: 7 } }, 'worker_error');
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    const episode = f.coordinatorRuns().at(-1)!;
    const snapshot = f.dispatches.find(item => item.runId === episode.id)!.context!;
    assert.ok(snapshot, 'the dispatch carried a launch snapshot');
    assert.match(snapshot.why.cause ?? '', /Worker error: The build failed/, 'the coordinator is told the worker error it was asked about');
    assert.equal(snapshot.authorResult?.status, 'error');
    assert.equal(snapshot.authorResult?.runId, 'failed-revision');
    assert.equal(snapshot.outcome.accepted, null, 'a recorded author result is never read as an accepted review');
    assert.match(snapshot.outcome.decision, /is the current reader at aaaaaaaaaaaa with no verdict yet/, 'the retained reader at that head is the outstanding decision, not the author result');
    assert.equal(snapshot.checkpoint, null, 'no checkpoint is invented for a worker error');
    assert.equal(snapshot.stop?.kind, 'attention');
    // The plan refresh reads the same stop and verbs through the coordinator's own credential.
    const plan = f.engine.recoveryTaskNextFromAgent({ taskId: f.submitted.id, runId: episode.id, token: f.tokens.get(episode.id)! });
    assert.equal(plan.stop?.kind, snapshot.stop?.kind);
    assert.deepEqual(plan.verbs.map(verb => verb.verb), snapshot.verbs.map(verb => verb.verb));
    assert.equal(snapshot.verbs.find(verb => verb.verb === 'restart')?.available, true, 'the retained worker continuation stays offered');
  } finally { await f.close(); }
});


test('a coordinator launched under an operator merge hold sees the hold and the merge verb as next offers it', async () => {
  const f = fixture();
  try {
    // An operator merge hold does not stop a recovery launch, so the coordinator is dispatched into it.
    f.store.update(f.submitted.id, { held: true, holds: { merge: { owner: 'operator', reason: 'Operator merge hold: release window',
      at: new Date().toISOString(), generation: f.current().coordinatorGeneration, until: null } } });
    const episode = await workerErrorEpisode(f);
    const snapshot = f.dispatches.find(item => item.runId === episode.id)!.context!;
    assert.ok(snapshot, 'the dispatch carried a launch snapshot');
    assert.equal(snapshot.stop?.kind, 'hold');
    assert.equal(snapshot.stop?.reason, 'held');
    assert.equal(snapshot.holds.merge?.reason, 'Operator merge hold: release window');
    // The merge verb is offered exactly as `next` offers it, so the snapshot does not invent a merge permission.
    const mergeMove = snapshot.verbs.find(verb => verb.verb === 'move' && verb.args?.to === 'merge');
    const offered = f.next().verbs.find(verb => verb.verb === 'move' && verb.args?.to === 'merge');
    assert.equal(mergeMove?.available, offered?.available);
    assert.deepEqual(mergeMove?.fill, offered?.fill);
    assert.equal(mergeMove?.note, offered?.note);
    // The restart is still offered, not confused with the merge hold.
    assert.equal(snapshot.verbs.find(verb => verb.verb === 'restart')?.available, true);
    // The refresh reads the same hold through the coordinator's own credential.
    const plan = f.engine.recoveryTaskNextFromAgent({ taskId: f.submitted.id, runId: episode.id, token: f.tokens.get(episode.id)! });
    assert.equal(plan.holds.merge?.reason, 'Operator merge hold: release window');
    assert.deepEqual(plan.verbs, f.next().verbs, 'the refresh and next read the same plan');
    assert.equal(workerTurns(f).length, 0, 'the hold sent nothing');
  } finally { await f.close(); }
});


test('a retained coordinator re-prompt carries a fresh launch snapshot of the second stop', async () => {
  const f = fixture();
  try {
    const first = await workerErrorEpisode(f, 'failed-one');
    await f.coordinatorReport({ verb: 'restart', role: 'worker', instruction: 'Fix the build', reason: 'Continue the worker' }, first.id);
    await f.engine.wake(); await f.engine.quiesce();
    // The continued worker errors again on the same PR.
    const revision = f.store.runs(f.submitted.id).findLast(item => item.role === 'revision' && !item.id.startsWith('failed-'))!;
    assert.ok(revision, 'the restart started a worker run');
    f.store.putRun({ ...f.store.run(revision.id)!, status: 'finished', released: true, active: false });
    f.idle('worker');
    const second = await workerErrorEpisode(f, 'failed-two');
    assert.notEqual(second.id, first.id, 'the second stop opened its own episode');
    // The retained coordinator is re-prompted through sendRun, not a new agent, and its prompt gets the snapshot too.
    const reprompt = f.dispatches.find(item => item.runId === second.id)!;
    assert.equal(reprompt.path, 'send', 'the retained coordinator was re-prompted');
    assert.equal(reprompt.role, 'recovery');
    assert.equal(second.agentId, first.agentId, 'the same coordinator agent serves the second episode');
    const snapshot = reprompt.context!;
    assert.ok(snapshot, 'the re-prompt carried a launch snapshot');
    assert.equal(snapshot.why.recoveryRunId, second.id);
    assert.equal(snapshot.authorResult?.runId, 'failed-two', 'the snapshot names the newest stop');
    assert.equal(snapshot.verbs.find(verb => verb.verb === 'restart')?.available, true);
  } finally { await f.close(); }
});

test('a coordinator asked about an unfinished worker revision launches with that worker as the unfinished participant', async () => {
  const f = fixture();
  try {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    // The retained worker's revision never reported and its turn stopped. Its agent is idle, so Queue can launch a coordinator.
    f.store.putRun(runSchema.parse({ id: 'stalled-revision', taskId: f.submitted.id, role: 'revision', generation: 1, head, base,
      agentId: 'worker', workspaceId: 'workspace', profile: worker, status: 'running', createdAt: minutesAgo(30),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false }));
    f.store.update(f.submitted.id, { phase: 'changes_requested', completion: null,
      resolution: { ...f.current().resolution, currentRunId: 'stalled-revision', reviewerAgentId: null } });
    f.store.putRun({ ...f.run(), released: true, status: 'finished' });
    f.idle('review-agent');
    f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' } as never);
    await f.engine.resolution.observe();
    await f.engine.quiesce();
    await f.engine.resolution.observe();
    await f.engine.quiesce();
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    const episode = f.coordinatorRuns().at(-1)!;
    const launch = f.dispatches.find(item => item.runId === episode.id)!;
    assert.equal(launch.path, 'create');
    const snapshot = launch.context!;
    assert.ok(snapshot, 'the dispatch carried a launch snapshot');
    assert.equal(snapshot.why.target, 'worker');
    assert.match(snapshot.why.cause ?? '', /callback reminder expired/, 'the coordinator is told it stopped without a result');
    assert.equal(snapshot.activeRun?.runId, 'stalled-revision');
    assert.equal(snapshot.activeRun?.role, 'revision');
    assert.equal(snapshot.activeRun?.workspaceId, 'workspace', 'the unfinished worker names its workspace');
    assert.equal(snapshot.checkpoint, null, 'no reviewer checkpoint is invented for a worker stop');
    assert.equal(snapshot.stop?.kind, 'attention');
    // The refresh reads the same plan through the coordinator's own credential.
    const plan = f.engine.recoveryTaskNextFromAgent({ taskId: f.submitted.id, runId: episode.id, token: f.tokens.get(episode.id)! });
    assert.equal(plan.activeRun?.runId, 'stalled-revision');
    assert.deepEqual(plan.verbs.map(verb => verb.verb), snapshot.verbs.map(verb => verb.verb));
  } finally { await f.close(); }
});

/**
 * Seed accepted review coverage at one head the way the product records it: the
 * run's checkpoint records plus one `review_checkpoint` line per acceptance (the
 * durable event the recovery bound dates coverage by). No coordinator launches,
 * so the fixture measures the bound derivation alone.
 */
/** The cross-reader maximum at the task's exact head, derived here so this file also runs against the parent. */
const coverageAtHead = (f: ReturnType<typeof fixture>) => f.store.runs(f.submitted.id)
  .filter(run => run.role === 'reviewer' && run.head === f.current().prHead)
  .flatMap(run => run.reviewCheckpoints ?? []).reduce((max, record) => Math.max(max, record.ordinal), 0);

function seedCoverage(f: ReturnType<typeof fixture>, runId: string, ordinals: number[], limit = 8): void {
  const run = f.store.run(runId)!;
  const records = ordinals.map(ordinal => ({ ordinal, checkpoint: { covered: [`section ${ordinal}`], remaining: ['the rest'] },
    head, at: new Date().toISOString(), runId, path: `/tmp/${runId}-${ordinal}.json`, eventId: `receipt-${runId}-${ordinal}` }));
  f.store.putRun({ ...run, reviewCheckpoints: records });
  for (const record of records)
    f.store.event(f.submitted.id, 'review_checkpoint', `${record.ordinal}/${limit} ${record.eventId} run ${runId} at ${head}`);
}

test('a replacement reader below the cross-reader maximum does not release the legacy bound; a higher maximum does', async () => {
  const f = fixture();
  try {
    // A prior reader reached checkpoint 6 at this exact head.
    seedCoverage(f, f.reviewerRunId, [1, 2, 3, 4, 5, 6]);
    // Three coordinator launches from the previous release recorded no work identity.
    for (let index = 0; index < COORDINATOR_LOOP_LIMIT; index++) f.legacyRun(index);
    assert.equal(unproductiveCoordinatorRuns(f.store, f.submitted.id), COORDINATOR_LOOP_LIMIT);
    // A replacement reader at the same head starts over at checkpoint 1. The
    // maximum is still 6, so this is not progress and cannot buy more recovery.
    const replacement = f.freshReviewer('replacement');
    seedCoverage(f, replacement, [1]);
    assert.equal(coverageAtHead(f), 6);
    assert.equal(unproductiveCoordinatorRuns(f.store, f.submitted.id), COORDINATOR_LOOP_LIMIT,
      'a lower replacement checkpoint keeps every legacy charge');
    // Going beyond the cross-reader maximum is progress and releases the bound.
    seedCoverage(f, replacement, [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(coverageAtHead(f), 7);
    assert.equal(unproductiveCoordinatorRuns(f.store, f.submitted.id), 0, 'a higher maximum releases the legacy charges');
  } finally { await f.close(); }
});

test('an explicit coordinator restart records its re-arm with the transition, independent of the audit prose', () => {
  // The structured re-arm identity survives a maximal accepted reason: the audit
  // line stays parseable JSON within its bound.
  const f = fixture();
  try {
    const reason = `Owner re-arms coordinator recovery: ${'x'.repeat(4000)}`.slice(0, 4000);
    const detail = ownerControlEventDetail(f.current(), taskControlInputSchema.parse({ taskId: f.submitted.id, version: f.current().version,
      action: 'restart', role: 'coordinator', reason, caller: 'owner-thread' }) as never, 'reviewing', 'reviewing');
    assert.ok(detail.length <= 4000, `audit line stays inside its bound (${detail.length})`);
    const parsed = JSON.parse(detail) as { verb: string; identities: { restart?: { role?: string } }; reason: string | null };
    assert.equal(parsed.verb, 'restart');
    assert.equal(parsed.identities.restart?.role, 'coordinator', 'the structured re-arm identity is never truncated away');
    assert.ok((parsed.reason ?? '').length > 0, 'the audit keeps what prose fits');
  } finally { void f.close(); }
});

test('an unresolved delivery on the current reader refuses the coordinator restart instead of re-arming', async () => {
  const f = fixture();
  try {
    // The exhausted-bound episode an owner restart would otherwise re-arm.
    for (let index = 0; index < COORDINATOR_LOOP_LIMIT; index++) f.legacyRun(index);
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution,
      recovery: { id: 'bound-episode', key: 'bound-key', generation: 1, runId: null, agentId: null, status: 'escalated',
        summary: COORDINATOR_LOOP_SUMMARY, idleSince: null, incidentId: null } } });
    assert.equal(unproductiveCoordinatorRuns(f.store, f.submitted.id), COORDINATOR_LOOP_LIMIT);
    // The task's current reader holds an unresolved delivery: exactly the retained
    // run whose refusal must never be reclassified as a successful re-arm.
    f.store.putRun({ ...f.store.run(f.reviewerRunId)!, reviewDeliveries: [reviewDeliveryAuthorizationSchema.parse({
      authorizationId: 'auth-uncertain', operationId: 'operation-uncertain', deliveryId: `ns-review-${'e'.repeat(64)}`,
      taskId: f.submitted.id, runId: f.reviewerRunId, head, checkpointOrdinal: 1, taskVersion: f.current().version,
      briefVersion: null, briefDigest: null, reason: 'uncertain delivery', instruction: 'uncertain delivery',
      createdAt: new Date().toISOString(), status: 'uncertain', evidence: '', observedAt: null })] });
    const version = f.current().version, eventsBefore = f.store.eventsAll(f.submitted.id).length;
    await assert.rejects(f.ownerControl({ action: 'restart', role: 'coordinator' }),
      /owns this task|delivery|unsettled|current run/i);
    assert.equal(f.events('coordinator_rearm').length, 0, 'no re-arm was recorded');
    assert.equal(unproductiveCoordinatorRuns(f.store, f.submitted.id), COORDINATOR_LOOP_LIMIT, 'the bound was not reset');
    assert.equal(f.current().resolution.recovery?.status, 'escalated', 'the episode keeps its ownership and evidence');
    assert.equal(f.current().version, version, 'the refused restart changed nothing');
    assert.equal(f.store.eventsAll(f.submitted.id).length, eventsBefore, 'settlement rolled back');
    assert.equal(f.store.run(f.reviewerRunId)!.released, false, 'the retained reader was not released');
  } finally { await f.close(); }
});

test('a deliberate fresh review at an unchanged head is the outstanding decision in both allowance states', async () => {
  for (const exhausted of [false, true]) {
    const f = fixture();
    try {
      if (exhausted) f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, revisionRuns: REVISION_BUDGET } });
      // The reviewer's authenticated changes_required verdict applies at the exact head.
      await f.engine.complete({ eventId: 'review-first', taskId: f.submitted.id, runId: f.reviewerRunId, status: 'changes_required',
        head, summary: 'Fix the retry path', reviewText: 'Fix the retry path', reviewCommentId: 4111, reviewResponsibility: 'author' },
        f.tokens.get(f.reviewerRunId)!);
      f.idle('review-agent');
      await f.engine.resolution.observe();
      await f.engine.quiesce();
      assert.equal(f.current().resolution.review?.eventId, 'review-first');
      // A deliberate fresh review at the same unchanged head clears the accepted slot and starts a reader.
      await f.ownerControl({ action: 'move', to: 'review', reason: 'A second independent read of the same head' });
      // Before the reader is allocated the same deliberate review is the outstanding decision.
      const allocated = f.next();
      assert.equal(allocated.outcome.reader, null, 'no reader is allocated yet');
      assert.match(allocated.outcome.decision, /a deliberate fresh review of the same unchanged head is the outstanding decision before its reader is allocated/);
      assert.doesNotMatch(allocated.outcome.decision, /owner's disposition the next step/);
      assert.doesNotMatch(allocated.outcome.decision, /outstanding decision is the author revision/);
      await f.engine.quiesce();
      assert.equal(f.current().resolution.review, null, 'the move clears the accepted slot');
      const reader = f.current().resolution.currentRunId!;
      assert.ok(reader && reader !== f.reviewerRunId, 'a fresh reader holds the same head');
      const moved = f.next();
      // The applied findings survive as observation, with their exact source.
      assert.equal(moved.outcome.accepted?.runId, f.reviewerRunId);
      assert.equal(moved.outcome.accepted?.status, 'changes_required');
      assert.equal(moved.outcome.accepted?.eventId, 'review-first');
      assert.equal(moved.outcome.accepted?.reviewId, 4111);
      assert.equal(moved.outcome.accepted?.reviewerAgentId, 'review-agent');
      assert.equal(moved.outcome.accepted?.currentHead, true);
      assert.equal(moved.outcome.accepted?.superseded, true, 'applied history, not the current accepted slot');
      assert.equal(moved.outcome.reported, null, 'an applied verdict is never a pending report');
      assert.equal(moved.outcome.reader?.runId, reader, 'the deliberate fresh reader is named separately');
      assert.equal(moved.outcome.revision.exhausted, exhausted);
      // The reader's verdict is the outstanding decision; the allowance and the
      // findings stay recorded behind it instead of competing with it.
      assert.match(moved.outcome.decision, /so the outstanding decision is that reader's verdict, not another author return or another review/);
      assert.doesNotMatch(moved.outcome.decision, /owner's disposition the next step/);
      assert.doesNotMatch(moved.outcome.decision, /outstanding decision is the author revision/);
      if (exhausted) {
        assert.match(moved.outcome.decision, /exhausted author revision allowance/);
        assert.match(moved.outcome.decision, /project planner's disposition through the blocker ladder/);
      } else {
        assert.match(moved.outcome.decision, /author-revision evidence if that review returns changes_required/);
      }
      // Retained checkpoint work is separate from the applied verdict.
      f.idle(f.store.run(reader)!.agentId!);
      for (const run of f.coordinatorRuns()) if (run.agentId) f.idle(run.agentId);
      await f.checkpoint('Reading the unchanged diff', randomUUID(), reader);
      const checkpointed = f.next();
      assert.equal(checkpointed.outcome.accepted?.runId, f.reviewerRunId, 'the checkpoint replaces no verdict');
      assert.equal(checkpointed.outcome.reader?.runId, reader);
      assert.equal(checkpointed.outcome.reader?.checkpoint, 1, 'its checkpoint work is named separately');
      // A launch snapshot carries the same decision and history `next` shows.
      const snapshot = recoveryDispatchSnapshot(collectOwnerVerbFacts(f.store, f.current()), { cause: 'checkpoint', target: 'reviewer', recoveryRunId: 'recovery' });
      const bound = (text: string) => text.length > 500 ? `${text.slice(0, 499)}…` : text;
      assert.deepEqual(snapshot.outcome.accepted, checkpointed.outcome.accepted);
      assert.deepEqual(snapshot.outcome.reader, checkpointed.outcome.reader);
      assert.equal(snapshot.outcome.decision, bound(checkpointed.outcome.decision), 'the snapshot names the same fresh review');
      assert.equal(snapshot.outcome.accepted?.superseded, true);
      assert.equal(snapshot.outcome.accepted?.reviewId, 4111);
      assert.equal(snapshot.checkpoint?.runId, reader);
      assert.equal(snapshot.checkpoint?.ordinal, 1);
      // An owner merge hold is preserved beside the same outcome, reader and stop.
      f.store.update(f.submitted.id, { holds: { merge: { owner: 'operator', reason: 'Operator merge hold: release window',
        at: new Date().toISOString(), generation: f.current().coordinatorGeneration, until: null } } });
      const held = f.next();
      assert.equal(held.holds.merge?.reason, 'Operator merge hold: release window');
      assert.equal(held.stop?.kind, 'hold');
      assert.equal(held.outcome.accepted?.runId, f.reviewerRunId, 'the hold does not disturb the applied history');
      assert.equal(held.outcome.accepted?.superseded, true);
      assert.equal(held.outcome.reader?.runId, reader, 'the hold does not disturb the deliberate reader');
    } finally { await f.close(); }
  }
});

test('a same-head author return puts its review ahead of the applied findings, not another author revision', async () => {
  const f = fixture();
  // Inspect the intermediate owner projection before the next task quantum.
  const lanes = f.engine as unknown as { scheduleLifecycleFollowUp: (taskId: string) => void };
  lanes.scheduleLifecycleFollowUp = () => {};
  try {
    // An ordinary changes_required verdict applies at the head, so the author
    // return is the open decision.
    await f.engine.complete({ eventId: 'review-first', taskId: f.submitted.id, runId: f.reviewerRunId, status: 'changes_required',
      head, summary: 'Fix the retry path', reviewText: 'Fix the retry path', reviewCommentId: 4111, reviewResponsibility: 'author' },
      f.tokens.get(f.reviewerRunId)!);
    f.idle('review-agent');
    await f.engine.resolution.observe();
    await f.engine.quiesce();
    assert.equal(f.current().phase, 'changes_requested');
    assert.equal(f.next().outcome.decision.includes('outstanding decision is the author revision'), true, 'the author revision is the open decision');
    await f.engine.wake();
    // The retained author's revision returns ready_for_review at the same unchanged head.
    const revision = f.current().resolution.currentRunId;
    assert.ok(revision, 'the revision run was dispatched');
    const revisionRun = f.store.run(revision)!;
    assert.equal(revisionRun.role, 'revision');
    f.idle(revisionRun.agentId!);
    await f.engine.complete({ eventId: 'author-return', taskId: f.submitted.id, runId: revision, status: 'ready_for_review',
      head, prNumber: 7, summary: 'Addressed the findings at the same head' }, f.tokens.get(revision)!);
    await f.engine.resolution.observe();
    await f.engine.quiesce();
    assert.equal(f.current().phase, 'awaiting_review');
    assert.equal(f.current().resolution.review, null, 'the later author result cleared the accepted slot');
    assert.equal(f.current().completion?.eventId, 'author-return');
    const plan = f.next();
    // The applied findings stay evidence, and the later author result is what the review covers.
    assert.equal(plan.outcome.accepted?.status, 'changes_required');
    assert.equal(plan.outcome.accepted?.superseded, true);
    assert.equal(plan.outcome.authorResult?.runId, revision);
    assert.equal(plan.outcome.authorResult?.status, 'ready_for_review');
    assert.equal(plan.outcome.authorResult?.head, head);
    assert.equal(plan.outcome.authorResult?.currentHead, true);
    assert.equal(plan.outcome.authorResult?.afterApplied, true, 'the author already returned at this head');
    assert.equal(plan.outcome.reader, null, 'no reader holds the head yet');
    assert.match(plan.outcome.decision, /that author result's independent review, not another author return/);
    assert.doesNotMatch(plan.outcome.decision, /outstanding decision is the author revision/);
    // A live fresh reviewer at the same head is the outstanding review, and the
    // exhausted-author disposition is not offered again.
    const reader = f.freshReviewer('returned');
    const live = f.next();
    assert.equal(live.outcome.reader?.runId, reader);
    assert.equal(live.outcome.authorResult?.runId, revision);
    assert.match(live.outcome.decision, /so the outstanding decision is that reader's verdict, not another author return or another review/);
    assert.ok(live.outcome.decision.includes(`Reviewer run ${reader}`), 'the live reader is named');
    assert.doesNotMatch(live.outcome.decision, /owner's disposition the next step/);
    assert.doesNotMatch(live.outcome.decision, /another request to return the author/);
  } finally { delete (lanes as { scheduleLifecycleFollowUp?: unknown }).scheduleLifecycleFollowUp; await f.close(); }
});

test('the outcome projection keeps an approval, a changed head, a report, a later verdict and a live reader distinct', async () => {
  const f = fixture();
  try {
    // One applied verdict the way the product records it: the authenticated run
    // carries the completion, the task row holds it as the accepted slot, and the
    // run's own review_result_applied event proves the application.
    const applied = (eventId: string, status: 'ready_to_merge' | 'changes_required', at = head, extra: Record<string, unknown> = {}, runId = f.reviewerRunId) => {
      const verdict = { eventId, taskId: f.submitted.id, runId, status, head: at, summary: `${status} at ${at.slice(0, 12)}`, ...extra } as Completion;
      const existing = f.store.run(runId);
      const run = runSchema.parse({ ...(existing ?? { id: runId, taskId: f.submitted.id, role: 'reviewer', generation: 1, head: at, base,
        agentId: `agent-${runId}`, workspaceId: 'workspace', profile: reviewer, createdAt: new Date().toISOString(), lastObservedAt: null, idleSince: null }),
        status: 'finished', active: false, completion: verdict, released: true });
      f.store.putRun(run);
      f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, currentRunId: null, review: verdict } }, 'review_result_applied', runId);
    };
    // An accepted approval at the current head leaves only the guarded merge.
    applied('review-approve', 'ready_to_merge', head, { reviewId: 7001 });
    const approved = f.next().outcome;
    assert.equal(approved.accepted?.status, 'ready_to_merge');
    assert.equal(approved.accepted?.currentHead, true);
    assert.equal(approved.accepted?.reviewId, 7001);
    assert.equal(approved.accepted?.reviewerAgentId, 'review-agent');
    assert.equal(approved.accepted?.superseded, false, 'the current accepted slot holds it');
    assert.match(approved.decision, /approves the current head/);
    assert.match(approved.decision, /guarded merge/);
    // A changed source head turns that verdict into history; the author result at the old head is no verdict either.
    const moved = 'c'.repeat(40);
    f.store.update(f.submitted.id, { prHead: moved });
    const changed = f.next();
    assert.equal(changed.outcome.accepted?.head, head);
    assert.equal(changed.outcome.accepted?.currentHead, false);
    assert.match(changed.outcome.decision, /history for the changed source and cannot qualify it/);
    // A reviewer report at the new head that Queue never applied is a report, not a verdict; an unpublished one says so.
    f.store.putRun(runSchema.parse({ id: 'review-report', taskId: f.submitted.id, role: 'reviewer', generation: 1, head: moved, base,
      agentId: 'review-agent-report', workspaceId: 'workspace', profile: reviewer, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false }));
    const reporting = f.store.run('review-report')!;
    f.store.putRun({ ...reporting, status: 'finished', active: false, completion: { eventId: 'review-report-result', taskId: f.submitted.id,
      runId: 'review-report', status: 'changes_required', head: moved, summary: 'Unpublished findings' } });
    const reported = f.next().outcome;
    assert.equal(reported.accepted?.currentHead, false, 'the older applied verdict stays history');
    assert.equal(reported.reported?.runId, 'review-report');
    assert.equal(reported.reported?.status, 'changes_required');
    assert.equal(reported.reported?.published, false, 'an unpublished report says so');
    assert.equal(reported.reported?.head, moved);
    assert.match(reported.decision, /a report is never the accepted verdict/);
    // The recorded result is not the active participant while publication and
    // application still have to clear the task row's current binding.
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, currentRunId: 'review-report' } });
    const applying = f.next();
    assert.equal(applying.outcome.reported?.runId, 'review-report');
    assert.equal(applying.activeRun, null, 'a finished current run is never the active participant');
    f.store.putRun({ ...f.store.run('review-report')!, released: true, status: 'finished' });
    assert.equal(f.next().activeRun, null, 'a released current binding is never the active participant');
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, currentRunId: null } });
    // A later applied verdict at the new head becomes the accepted outcome.
    applied('review-report-result', 'changes_required', moved, {}, 'review-report');
    const later = f.next().outcome;
    assert.equal(later.accepted?.runId, 'review-report');
    assert.equal(later.accepted?.currentHead, true);
    assert.equal(later.accepted?.published, false, 'the later verdict still carries no publication evidence');
    assert.equal(later.reported, null, 'the applied report is no longer a pending report');
    assert.equal(later.accepted?.superseded, false);
    assert.match(later.decision, /outstanding decision is the author revision/);
    // A second applied verdict at the same head: the earlier applied verdict is
    // application history, never a pending report Queue forgot to apply.
    f.store.putRun(runSchema.parse({ id: 'review-later', taskId: f.submitted.id, role: 'reviewer', generation: 1, head: moved, base,
      agentId: 'review-agent-later', workspaceId: 'workspace', profile: reviewer, status: 'finished', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, released: true,
      completion: { eventId: 'review-later-result', taskId: f.submitted.id, runId: 'review-later', status: 'changes_required',
        head: moved, summary: 'Second applied findings', reviewCommentId: 7002 } }));
    applied('review-later-result', 'changes_required', moved, { reviewCommentId: 7002 }, 'review-later');
    const twice = f.next().outcome;
    assert.equal(twice.accepted?.runId, 'review-later', 'the newest applied verdict is accepted');
    assert.equal(twice.accepted?.superseded, false);
    assert.equal(twice.reported, null, 'the earlier applied verdict is not misread as an unapplied report');
    // A reviewer actually holding a later head is a live participant with no verdict yet.
    const liveHead = 'd'.repeat(40);
    f.store.update(f.submitted.id, { prHead: liveHead });
    f.store.putRun(runSchema.parse({ id: 'live-reader', taskId: f.submitted.id, role: 'reviewer', generation: 1, head: liveHead, base,
      agentId: 'review-agent-live', workspaceId: 'workspace', profile: reviewer, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false }));
    f.store.setCredential('live-reader', 'live-token');
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, currentRunId: 'live-reader', reviewerAgentId: 'review-agent-live' } });
    const livePlan = f.next();
    assert.equal(livePlan.outcome.reader?.runId, 'live-reader');
    assert.equal(livePlan.outcome.reader?.agentId, 'review-agent-live');
    assert.equal(livePlan.outcome.reader?.checkpoint, null);
    assert.equal(livePlan.activeRun?.runId, 'live-reader', 'the live reader is the active participant');
    assert.equal(livePlan.activeRun?.released, false);
    assert.match(livePlan.outcome.decision, /is the current reader at dddddddddddd with no verdict yet; that verdict is the outstanding decision/);
    assert.equal(livePlan.outcome.accepted?.runId, 'review-later', 'the applied verdict is not replaced by the live reader');
    assert.equal(livePlan.outcome.accepted?.currentHead, false, 'the changed head leaves that verdict as history');
  } finally { await f.close(); }
});

test('a refused retry effect returns the current choices to the coordinator', async () => {
  const f=fixture(); try {
    f.store.db.prepare('DELETE FROM runs WHERE id=?').run(f.reviewerRunId);
    f.store.update(f.submitted.id,{phase:'syncing',reason:'Transient sync failure',resolution:{...f.current().resolution,currentRunId:null,reviewerAgentId:null,mergedCommit:base,attention:true}});
    f.engine.resolution.recordStop(f.current(),'operator_needed','Transient sync failure',['restart','move']);
    await f.engine.resolution.recovery.route(f.current());
    const first=f.coordinatorRuns().at(-1)!;
    f.idle(first.agentId!);
    f.engine.resolution.complete({eventId:randomUUID(),taskId:f.submitted.id,runId:first.id,status:'recovered',summary:'Retry sync',coordinatorAction:{verb:'retry_effect',reason:'Retry the effect'},coordinatorGeneration:first.generation},f.tokens.get(first.id)!);
    await f.engine.resolution.recovery.pass(f.submitted.id);
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    const second=f.coordinatorRuns().at(-1)!;
    assert.notEqual(second.id,first.id);
    const snapshot=f.dispatches.find(d=>d.runId===second.id)?.context;
    assert.match(snapshot?.why.cause??'',/refused.*retry_effect/i);
    assert.ok(snapshot?.verbs.some(v=>v.verb==='restart'&&v.available));
    f.idle(second.agentId!);
    f.engine.resolution.complete({eventId:randomUUID(),taskId:f.submitted.id,runId:second.id,status:'recovered',summary:'Resume sync',coordinatorAction:{verb:'restart',reason:'Retry synchronization'},coordinatorGeneration:second.generation},f.tokens.get(second.id)!);
    await f.engine.resolution.recovery.pass(f.submitted.id);
    assert.equal(f.events('coordinator_action_applied').length,1,JSON.stringify(f.current().resolution.recovery));
  } finally { await f.close(); }
});

test('a coordinator reviewer restart or second choice enters review', async () => {
  const f=fixture(); try {
    f.store.db.prepare('DELETE FROM runs WHERE id=?').run(f.reviewerRunId);
    f.store.update(f.submitted.id,{phase:'awaiting_review',reason:'Review dispatch failed',resolution:{...f.current().resolution,currentRunId:null,reviewerAgentId:null,attention:true}});
    f.engine.resolution.recordStop(f.current(),'operator_needed','Review dispatch failed',['restart','move']);
    await f.engine.resolution.recovery.route(f.current());
    const first=f.coordinatorRuns().at(-1)!;
    f.idle(first.agentId!);
    f.engine.resolution.complete({eventId:randomUUID(),taskId:f.submitted.id,runId:first.id,status:'recovered',summary:'Restart review',coordinatorAction:{verb:'restart',role:'reviewer',reason:'Restart review'},coordinatorGeneration:first.generation},f.tokens.get(first.id)!);
    await f.engine.resolution.recovery.pass(f.submitted.id);
    if (!f.events('coordinator_action_applied').length) {
      await f.engine.resolution.recovery.route(f.current());
      await f.engine.quiesce();
      const second=f.coordinatorRuns().at(-1)!;
      assert.notEqual(second.id,first.id);
      assert.ok(f.dispatches.find(d=>d.runId===second.id)?.context?.verbs.some(v=>v.verb==='move'&&v.available&&v.args?.to==='review'));
      await f.coordinatorReport({verb:'move',to:'review',reason:'Start independent review'},second.id);
    }
    assert.equal(f.events('coordinator_action_applied').length,1);
    assert.ok(['awaiting_review','reviewing'].includes(f.current().phase));
  } finally { await f.close(); }
});

test('two refused coordinator choices reach the planner ladder', async () => {
  const f=fixture(); try {
    const first=await workerErrorEpisode(f);
    await f.coordinatorReport({verb:'retry_effect',reason:'Retry'},first.id);
    await f.engine.resolution.recovery.route(f.current()); await f.engine.quiesce();
    const second=f.coordinatorRuns().at(-1)!;
    assert.notEqual(second.id,first.id);
    await f.coordinatorReport({verb:'retry_effect',reason:'Retry again'},second.id);
    await f.engine.resolution.recovery.route(f.current());
    assert.equal(f.events('planner_escalation').length,1);
    const { plannerEscalations } = await import('../core/questions/blocker-ladder');
    assert.match(plannerEscalations(f.store.eventsAll(f.submitted.id))[0]!.cause,/^[0-9a-f]{64}$/);
  } finally { await f.close(); }
});


test('a refused choice survives a capacity wait before the second launch', async () => {
  const f=fixture(); try {
    const first=await workerErrorEpisode(f);
    f.idle(first.agentId!);
    f.engine.resolution.complete({eventId:randomUUID(),taskId:f.submitted.id,runId:first.id,status:'recovered',summary:'Retry effect',coordinatorAction:{verb:'retry_effect',reason:'Retry'},coordinatorGeneration:first.generation},f.tokens.get(first.id)!);
    await f.engine.resolution.recovery.pass(f.submitted.id);
    const original=f.engine.resolution.slotAdmissionReason.bind(f.engine.resolution);
    f.engine.resolution.slotAdmissionReason=()=> 'Waiting for capacity';
    await f.engine.resolution.recovery.route(f.current());
    assert.equal(f.current().resolution.recovery?.action?.status,'refused');
    f.engine.resolution.slotAdmissionReason=original;
    await f.engine.resolution.recovery.route(f.current());
    const second=f.coordinatorRuns().at(-1)!;
    assert.notEqual(second.id,first.id);
    const context=f.dispatches.find(d=>d.runId===second.id)?.context;
    assert.match(context?.why.cause??'',/refused.*retry_effect/i);
    assert.ok(context?.verbs.some(v=>v.verb==='restart'&&v.available));
  } finally { await f.close(); }
});

test('a coordinator refreshes its plan once after a stale version refusal', async () => {
  const f = fixture();
  try {
    const episode = await workerErrorEpisode(f);
    const original = f.engine.performTaskControl.bind(f.engine);
    let calls = 0;
    f.engine.performTaskControl = async (...args) => {
      if (++calls === 1) f.store.update(f.current().id, { reason: 'A concurrent bookkeeping update' });
      return original(...args);
    };
    await f.coordinatorReport({ verb: 'restart', role: 'worker', instruction: 'Finish the build fixes', reason: 'Continue the worker' }, episode.id);
    assert.equal(calls, 2, JSON.stringify(f.store.verbOutcomes('2000-01-01')));
    assert.equal(f.events('coordinator_action_version_retry').length, 1);
    assert.equal(f.events('coordinator_action_applied').length, 1);
    assert.equal(f.events('coordinator_action_refused').length, 0);
    assert.equal(workerTurns(f).length, 1);
  } finally { await f.close(); }
});

test('overlapping recovery passes claim one coordinator result', async () => {
 const f=fixture();try {
  const episode=await workerErrorEpisode(f);
  const run=f.store.run(episode.id)!; f.idle(run.agentId!);
  const completion:Completion={eventId:'recovery-overlap',taskId:f.submitted.id,runId:run.id,status:'recovered',summary:'Continue',coordinatorGeneration:run.generation,
   coordinatorAction:{verb:'restart',role:'worker',instruction:'Finish the build fixes',reason:'Continue'}};
  f.engine.resolution.complete(completion,f.tokens.get(run.id)!);
  const task=f.current(), binding=task.resolution.recovery!.action!, completed=f.store.run(run.id)!;
  const original=f.adapter.observe; let release!:()=>void, entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve}), seen=new Promise<void>(resolve=>{entered=resolve});
  let waited=false; f.adapter.observe=async id=>{if(!waited){waited=true;entered();await gate}return original(id)};
  const first=f.engine.applyCoordinatorAction(task,completed,binding);await seen;
  await f.engine.applyCoordinatorAction(task,completed,binding);
  release();await first;await f.engine.quiesce();
  assert.equal(f.events('run_result_applying').length,1);
  assert.equal(f.events('run_result_applied').filter(event=>event.detail===run.id).length,1);
  assert.equal(workerTurns(f).length,1);
 }finally{await f.close()}
});

test('an interrupted coordinator application stays uncertain without outcome evidence', async () => {
 const f=fixture();try {
  const episode=await workerErrorEpisode(f);
  const run=f.store.run(episode.id)!;f.idle(run.agentId!);
  const completion:Completion={eventId:'interrupted-recovery',taskId:f.submitted.id,runId:run.id,status:'recovered',summary:'Continue',coordinatorGeneration:run.generation,
   coordinatorAction:{verb:'restart',role:'worker',instruction:'Finish the build fixes',reason:'Continue'}};
  f.engine.resolution.complete(completion,f.tokens.get(run.id)!);
  const task=f.current(), binding=task.resolution.recovery!.action!, completed=f.store.run(run.id)!;
  f.store.event(task.id,'run_result_applying',JSON.stringify([task.id,run.id,completion.eventId]));
  await f.engine.applyCoordinatorAction(task,completed,binding);
  assert.equal(workerTurns(f).length,0);
  assert.match(f.current().reason,/uncertain owner-verb outcome/);
  f.store.transaction(()=>f.engine.resolution.recovery.settleFinishedRun(f.current(),f.store.run(run.id)!,'A later pass inspected it'));
  assert.equal(f.store.run(run.id)?.released,false);
  assert.equal(f.events('run_released_from_recorded_completion').filter(event=>event.detail===`recovery ${run.id}`).length,0);
  assert.equal(f.events('run_result_applied').filter(event=>event.detail===run.id).length,0);
 }finally{await f.close()}
});

test('a claimed recovery result settles from its durable verb outcome without replay', async () => {
 const f=fixture();try {
  const episode=await workerErrorEpisode(f), run=f.store.run(episode.id)!;f.idle(run.agentId!);
  const completion:Completion={eventId:'proved-recovery',taskId:f.submitted.id,runId:run.id,status:'recovered',summary:'Continued',coordinatorGeneration:run.generation,
   coordinatorAction:{verb:'restart',role:'worker',instruction:'Finish the build fixes',reason:'Continue'}};
  f.engine.resolution.complete(completion,f.tokens.get(run.id)!);
  const task=f.current(), binding=task.resolution.recovery!.action!, completed=f.store.run(run.id)!;
  f.store.event(task.id,'run_result_applying',JSON.stringify([task.id,run.id,completion.eventId]));
  f.store.recordVerbOutcome(task.id,'restart','applied','coordinator',{coordinatorRun:run.id},`coordinator:${completion.eventId}`);
  await f.engine.applyCoordinatorAction(task,completed,binding);
  assert.equal(workerTurns(f).length,0);
  assert.equal(f.store.run(run.id)?.released,true);
  assert.equal(f.events('run_result_applied').filter(event=>event.detail===run.id).length,1);
 }finally{await f.close()}
});
