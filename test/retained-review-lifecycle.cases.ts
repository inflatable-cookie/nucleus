import { profile } from './support/fakes';
import { test, weighted } from './support/sharded-test';
import { whileReaderInTurn } from './support/reader-in-turn';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, digest } from '../core/store/store';
import { Engine } from '../core/engine';
import { REVIEW_AGENT_CLOSED, REVIEW_BUDGET_EXHAUSTED } from '../core/review/review-continuation';
import {
  holdsOf, proofExecutionRecordSchema, REVIEW_CONTINUATION_LIMIT, reviewDeliveryAuthorizationSchema, reviewEntryRecordSchema, runSchema, submissionSchema, taskControlInputSchema, taskNextSchema,
  type Profile, type Run, type Task,
} from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import type { TimelineEntry } from '../core/recovery/stall';
import { toolTimelinePage } from './support/tool-timeline';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { externalOwnerRevisionReceiptSchema } from '../shared/contracts';
import { reviewContinuationLocalRefusal } from '../core/resolution';
import { reviewInProgress, reviewerIdentityAtHead } from '../core/review/review-continuation';
import { briefDigest } from '../core/planning/brief';
import {ownerRevisionFixture} from './support/review-entry-fixture';

/**
 * Tom's 2026-10-27 ruling ("Preserve the reader for everyone", decision
 * 029a631e): ordinary Queue verbs preserve valid unfinished review, resume a
 * positively owner-stopped delivered turn on the same reader exactly once, and
 * never buy a second send through a routine restart. Every scenario uses the
 * ordinary lifecycle: an authenticated checkpoint, the ordinary owner verbs, the
 * real continuation gate and delivery, and the recorded stop evidence.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40), otherHead = 'c'.repeat(40);
const CALLER = 'owner-thread';
/** A Queue-held brief, so a stop-backed resume can be bound to the brief its turn read. */
const BRIEF_V1 = 'Retained review lifecycle: read the diff and report findings.\n';
const BRIEF_V2 = 'Retained review lifecycle, amended: also read the proofs.\n';
const BRIEF_V3 = 'Retained review lifecycle, amended again: also read the release notes.\n';

const worker = profile('worker', 'test/worker'), reviewer = profile('reviewer', 'test/reviewer');
/** The declared external authors of a workerless review-entry head: concrete, unlike an unpinned Queue worker. */
const declaredAuthors = { models: ['xai/grok-4.6', 'xai/grok-4.7'], githubAuthor: 'external-author', authoringSystem: 'external-agent',
  attestedBy: 'operator', provenance: 'Provider records and author report' };

function fixture(options: { toolTimeline?: boolean; workerless?: boolean; reviewerProfile?: Profile; declaredModels?: string[] } = {}) {
  const reviewerProfile = options.reviewerProfile ?? reviewer;
  const backing=options.workerless?ownerRevisionFixture():null;
  const fixtureHead=backing?.oldHead??head, fixtureBase=backing?.planningCommit??base;
  const reviewerWorkspace='workspace';
  const dir = mkdtempSync(join(tmpdir(), 'ns-retained-review-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewerProfile.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Retained review lifecycle', repoPath: backing?.repo??'/repo',
    planningCommit: fixtureBase, brief: { text: BRIEF_V1, mediaType: 'text/markdown' }, originAgentId: 'origin' }), 'host', BRIEF_V1, fixtureBase);
  // A workerless review entry is the imported shape: an externally authored PR
  // whose only author evidence is its declaration, with no Queue worker at all.
  const reviewEntry = reviewEntryRecordSchema.parse({ operationId: 'c'.repeat(64), prNumber: 7, repository: 'example/repo',
    branch: 'feature/external', workspaceId: 'workspace', directory:backing?.workspace, verifiedHead: fixtureHead, verifiedBase: fixtureBase, planningCommit: fixtureBase,
    authority: 'Operator authorized independent review of the existing PR',
    authorDeclaration: { ...declaredAuthors, models: options.declaredModels ?? declaredAuthors.models },
    checkedAt: new Date().toISOString(), preserveWorkspace: true });
  store.update(submitted.id, {
    phase: 'reviewing', planningBase: fixtureBase, workspaceIntent: true, agentIntent: !options.workerless, workspaceId: 'workspace', directory: backing?.workspace??'/worktree',
    branch:'feature/external',repository:'example/repo',prHead: fixtureHead, prUrl: 'https://github.com/example/repo/pull/7', resumePrNumber: 7,
    ...(options.workerless
      ? { entrypoint: 'review', reviewEntry }
      : { agentId: 'worker-agent', runId: 'worker-run', profile: worker, workerModel: worker.model,
          completion: { taskId: submitted.id, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 } }),
  }, 'dispatched');
  const runId = backing?'11111111-1111-4111-8111-111111111111':'review-run';
  store.putRun(runSchema.parse({ id: runId, taskId: submitted.id, role: 'reviewer', generation: 1, head:fixtureHead, base:fixtureBase, agentId: 'review-agent',
    workspaceId: reviewerWorkspace, profile: reviewerProfile, status: 'running', createdAt: new Date().toISOString(),
    briefVersion: submitted.briefVersions.at(-1)?.version ?? null, lastObservedAt: null, active: false, idleSince: null, completion: null, released: false }));
  store.setCredential(runId, 'token');
  store.update(submitted.id, { resolution: { ...store.task(submitted.id).resolution, currentRunId: runId, reviewerAgentId: 'review-agent', reviewerProfile } });

  const states = new Map<string, AgentObservation>([
    ['worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: worker.model }],
    ['review-agent', { id: 'review-agent', workspaceId: reviewerWorkspace, status: 'idle', active: false, permissions: false, error: '', provider: 'test', model: reviewerProfile.model }],
  ]);
  const reviewerDeliveries: { runId: string; messageId: string; text: string }[] = [];
  const reviewerTimeline: { timestamp: string; item: Record<string, unknown> }[] = [];
  // A complete tool timeline by default: a stop-backed resume needs positive
  // owned-tool evidence (review 5672703363, finding 2).
  let toolEntries: TimelineEntry[] = [];
  const stops: string[] = [];
  const createdRuns: Run[] = [];
  const archived = new Set<string>();
  const adapter = {
    ...(backing?{reviewEntryGithubCommand:backing.buildAdapter().reviewEntryGithubCommand,
      inspectReviewEntry:backing.buildAdapter().inspectReviewEntry}:{}),
    profiles: async () => [worker, reviewerProfile], validate: async () => base,
    createWorkspace: async () => { throw new Error('fixtures do not create workspaces'); },
    findWorkspaces: async () => [], findAgents: async () => [], findRunAgents: async () => [],
    createAgent: async () => { throw new Error('fixtures do not create agents'); },
    observe: async (id: string) => states.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' },
    originAgent: async (id: string) => ({ id, workspaceId: 'workspace', title: id, archived: archived.has(id) }),
    archiveAgent: async (id: string) => { archived.add(id); }, notify: async () => {},
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/7', head: store.task(submitted.id).prHead ?? head }),
    verifyPrIdentity: async () => ({ url: 'https://github.com/example/repo/pull/7', head: store.task(submitted.id).prHead ?? head }),
    coveringEvidence: async (t: Task) => ({ head: t.prHead!, base: t.resolution.mergeBase ?? t.planningBase, wait: '' }),
    verifyCleanQueueWorktree: async () => {}, verifyReview: async () => {},
    createRun: async (_t: Task, r: Run, token: string) => { createdRuns.push(r); store.setCredential(r.id, token);
      const id = `agent-${r.id}`; states.set(id, { id, workspaceId: r.workspaceId, status: 'running', active: true, permissions: false, error: '' });
      return { id, workspaceId: r.workspaceId }; },
    sendRun: async (_t: Task, r: Run) => { createdRuns.push(r); },
    stopAgentTurn: async (id: string) => { stops.push(id); const observed = states.get(id);
      if (observed) states.set(id, { ...observed, status: 'idle', active: false, permissions: false, activeTurnId: undefined }); },
    continueReviewer: async (_task: Task, r: Run, messageId: string, text: string, allowed: () => Promise<boolean>, stillAllowed: () => boolean) => {
      const before = states.get(r.agentId!)!;
      if (before.status !== 'idle' || before.active || before.activeTurnId || before.permissions) return { sent: false as const, reason: 'reviewer not idle' };
      if (!await allowed()) return { sent: false as const, reason: 'authorization changed' };
      if (!stillAllowed()) return { sent: false as const, reason: 'reviewer or task fence changed' };
      reviewerDeliveries.push({ runId: r.id, messageId, text });
      reviewerTimeline.push({ timestamp: new Date().toISOString(), item: { type: 'user_message', messageId, text } });
      return { sent: true as const };
    },
    agentTimeline: async () => reviewerTimeline,
    ...(options.toolTimeline === false ? {} : { agentTimelinePage: async () => toolTimelinePage(toolEntries) }),
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 3_600_000);
  engine.profiles = [worker, reviewerProfile];
  const current = () => store.task(submitted.id);
  const run = (id = runId) => store.run(id)!;
  const events = (kind: string) => store.eventsAll(submitted.id).filter(event => event.kind === kind);
  const observe = (shape: Partial<AgentObservation>) => states.set('review-agent', { ...states.get('review-agent')!, ...shape });
  /** An authenticated reviewer checkpoint through the ordinary callback path. */
  const checkpoint = async (label = 'Reading the diff', ordinalLabel = label) => {
    // The reader reports from inside its own turn (see whileReaderInTurn).
    return whileReaderInTurn(engine, 'review-agent', () => reportCheckpoint(label, ordinalLabel));
  };
  const reportCheckpoint = async (label: string, ordinalLabel: string) => {
    const receipt = await engine.complete({ eventId: randomUUID(), taskId: submitted.id, runId, status: 'review_in_progress' as const, head:fixtureHead,
      summary: ordinalLabel, reviewResponsibility: 'reviewer' as const, checkpoint: { covered: [label], remaining: ['the rest'] } }, 'token') as
      { accepted: true; eventId: string; checkpoint: { ordinal: number; continued: boolean } };
    await engine.quiesce();
    return receipt;
  };
  const control = (input: Record<string, unknown>) =>
    engine.performTaskControl(taskControlInputSchema.parse({ taskId: submitted.id, version: current().version, caller: CALLER, reason: 'Owner continues the review', ...input }));
  /** An ordinary Queue-held brief amendment by the owner. */
  const amend = (text: string) => engine.amendBrief({ taskId: submitted.id, version: current().version, brief: text, reason: 'Owner amends the brief' });
  /** Replace the reviewer's tool timeline (complete coverage unless the fixture opted out). */
  const setTimeline = (entries: TimelineEntry[]) => { toolEntries = entries; };
  /** Release whatever dispatch hold stands (a release carries no reason). */
  const releaseDispatch = async () => {
    if (holdsOf(current()).dispatch) await control({ action: 'release', kind: 'dispatch', reason: undefined });
  };
  const holds = () => holdsOf(current());
  /** The same `next` view an owner and a coordinator read before acting. */
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, current())));
  const view = (verb: string) => {
    const found = next().verbs.find(entry => entry.verb === verb);
    if (!found) throw new Error(`no ${verb} view: ${JSON.stringify(next().verbs.map(entry => entry.verb))}`);
    return found;
  };
  /** The `move to=review` view: an offered one names its target, a refused one names it in the refusal. */
  const moveReviewView = () => next().verbs.find(entry => entry.verb === 'move' && ((entry.args as Record<string, unknown> | undefined)?.to === 'review'
    || /^move review: /.test(entry.refusal ?? '')))!;
  /** The owner's `stop` verb over a busy reviewer turn: the durable owner stop evidence. */
  const ownerStop = async (reason = 'Coordinator churn') => {
    observe({ status: 'running', active: true });
    await control({ action: 'stop', reason });
    observe({ status: 'idle', active: false, permissions: false });
    return events('owner_stop_sent').at(-1)!;
  };
  return { dir, store, engine, adapter, submitted, runId, current, run, events, observe, checkpoint, control, ownerStop, amend, setTimeline, holds, next, view, moveReviewView, releaseDispatch, reviewerDeliveries, reviewerTimeline, stops, createdRuns, states,fixtureHead,reviewerWorkspace,
    close: async () => { await engine.stop(); store.close(); backing?.close();rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * The documented stop-backed delivery identity: `ns-review-<digest of
 * task:run:head:ordinal:owner-stop:<event occurrence>>`. Kept as a local
 * derivation so the same lifecycle scenarios can also run against the parent
 * revision (falsification) without depending on the new export.
 */
const resumeDeliveryId = (taskId: string, runId: string, ordinal: number, eventId: number) =>
  `ns-review-${digest(`${taskId}:${runId}:${head}:${ordinal}:owner-stop:${eventId}`)}`;

const restartReviewer = (f: ReturnType<typeof fixture>, reason = 'Continue the retained review') =>
  f.control({ action: 'restart', role: 'reviewer', reason });

// ── move to=review preserves the reader ─────────────────────────────────────

test('fresh review refuses an unproven reader binding without cancelling or replacing it', async () => {
  for (const binding of ['agent', 'workspace'] as const) for (const busy of [false, true]) {
    const f = fixture(); try {
      await f.checkpoint('Reading the diff');
      f.observe({ status: busy ? 'running' : 'idle', active: busy, ...(busy ? { activeTurnId: 'reading-turn' } : {}) });
      const current = f.current();
      if (binding === 'agent') f.store.update(current.id, { resolution: { ...current.resolution, reviewerAgentId: 'unproven-reviewer' } });
      else {
        f.store.putRun({ ...f.run(), workspaceId: 'unproven-source-workspace' });
        f.observe({ workspaceId: 'unproven-source-workspace' });
      }
      const before = f.current(), run = f.run();
      const identity = reviewerIdentityAtHead(before, f.store, head);
      assert.equal(identity.kind, 'refused');
      assert.ok(!f.next().verbs.some(verb => verb.available && verb.args?.to === 'review'), 'next offers no replacement for a refused identity');
      for (const fresh of [false, true]) {
        await assert.rejects(f.control({ action: 'move', to: 'review', fresh, reason: 'Replace the stale review' }),
          /cannot be proven|cannot prove/);
        assert.deepEqual(f.current(), before);
        assert.deepEqual(f.run(), run);
        assert.deepEqual(f.stops, [], 'no live turn is cancelled');
        assert.deepEqual(f.createdRuns, []);
        assert.deepEqual(f.reviewerDeliveries, []);
      }
    } finally { await f.close(); }
  }
});

test('move to=review preserves and continues an awaiting checkpoint on the same reader', async () => {
  const f = fixture(); try {
    const receipt = await f.checkpoint('Reading the diff');
    assert.equal(receipt.checkpoint.ordinal, 1);
    const moveReview = f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'review',
      taskId: f.submitted.id, version: f.current().version, reason: 'Owner moves the review forward', caller: CALLER }));
    const moved = await moveReview;
    assert.equal(f.current().resolution.currentRunId, f.runId, 'the retained reader is preserved');
    assert.equal(f.store.run(f.runId)!.released, false);
    assert.equal(f.reviewerDeliveries.length, 1, 'its saved checkpoint is continued through the ordinary retained-restart delivery');
    assert.equal(f.reviewerDeliveries[0]!.runId, f.runId);
    assert.equal(f.run().reviewCheckpoints?.length, 1, 'no checkpoint is invented or renumbered');
    assert.equal(f.events('owner_control').length, 1, 'one owner control records the move');
    assert.equal(f.events('move_review_requested').length, 0, 'the move did not start a fresh review');
    assert.equal(moved.phase, 'reviewing');
  } finally { await f.close(); }
});

test('move to=review preserves a reader that is still reading, and a delivered turn sends nothing new', async () => {
  const f = fixture(); try {
    // Reading with no saved coverage yet: nothing is replaced mid-read.
    f.observe({ status: 'running', active: true });
    const reading = await f.control({ action: 'move', to: 'review', reason: 'Preserve the reading reviewer' });
    assert.equal(reading.resolution.currentRunId, f.runId);
    assert.deepEqual(f.stops, [], 'a reading turn is not stopped');
    assert.equal(f.reviewerDeliveries.length, 0);
    assert.equal(f.events('move_review_retained').length, 1);

    // A delivered continuation that has no verdict yet: the same reader keeps working.
    // Queue continues the idle reader's checkpoint itself (Tom, 2026-10-31).
    f.observe({ status: 'idle', active: false });
    await f.checkpoint('Reading the diff');
    await f.engine.wake(); await f.engine.quiesce();
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.events('review_auto_continued').length, 1);
    const before = f.current().version;
    const delivered = await f.control({ action: 'move', to: 'review', reason: 'Keep the reader on its delivered turn' });
    assert.equal(delivered.resolution.currentRunId, f.runId);
    assert.equal(f.reviewerDeliveries.length, 1, 'no second turn is sent for a delivered continuation without a verdict');
    assert.equal(f.events('move_review_retained').length, 2);
    assert.ok(delivered.version > before);
  } finally { await f.close(); }
});

test('move to=review refuses an unsettled delivery and a reader that cannot continue', async () => {
  const f = fixture(); try {
    f.observe({ status: 'running', active: true });
    await f.checkpoint('Reading the diff');
    // An unsettled delivery is inspect-only.
    f.store.putRun({ ...f.run(), reviewDeliveries: [reviewDeliveryAuthorizationSchema.parse({
      authorizationId: 'auth-reserved', operationId: 'operation-reserved', deliveryId: `ns-review-${'d'.repeat(64)}`,
      taskId: f.submitted.id, runId: f.runId, head, checkpointOrdinal: 1, taskVersion: f.current().version,
      briefVersion: null, briefDigest: null, reason: 'reserved', instruction: 'reserved',
      createdAt: new Date().toISOString(), status: 'reserved', evidence: '', observedAt: null })] });
    const unsettled = f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'review', taskId: f.submitted.id,
      version: f.current().version, reason: 'Move forward', caller: CALLER }));
    await assert.rejects(unsettled, /durable side effect[\s\S]*pending|unsettled|reserved/i);
    assert.equal(f.store.run(f.runId)!.released, false);
    assert.equal(f.current().resolution.currentRunId, f.runId);

    // A spent budget or a closed agent is explicit, never a silent replacement.
    f.store.putRun({ ...f.run(), reviewBudgetExhaustedAt: new Date().toISOString(), reviewDeliveries: [] });
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'review', taskId: f.submitted.id,
      version: f.current().version, reason: 'Move forward', caller: CALLER })), /restart role=reviewer fresh/);
    assert.equal(f.store.run(f.runId)!.released, false);

    f.store.putRun({ ...f.run(), reviewBudgetExhaustedAt: undefined, retainedAgentClosedAt: new Date().toISOString() });
    await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'move', to: 'review', taskId: f.submitted.id,
      version: f.current().version, reason: 'Move forward', caller: CALLER })), /restart role=reviewer fresh/);
    assert.equal(f.store.run(f.runId)!.released, false);
  } finally { await f.close(); }
});

// ── a workerless review entry keeps its recorded external authors ───────────

/**
 * The imported shape: an externally authored PR whose Queue task never had an
 * authoring worker. Its author evidence is the declaration (and any observed
 * later external revision), so the retained restart's independence guard must
 * read that evidence instead of manufacturing an unknown worker model.
 */
weighted(2)('a workerless review entry continues its retained reader from the recorded external authors', async () => {
  const f = fixture({ workerless: true }); try {
    const reading = f.current();
    assert.ok(reading.reviewEntry, 'the task is a genuine review entry');
    assert.equal(reading.agentId, null, 'the imported head has no Queue authoring worker');
    assert.equal(reading.profile, null);
    assert.equal(reading.workerModel, null);
    assert.deepEqual(reading.workerModels, []);
    const receipt = await f.checkpoint('Reading the external diff');
    assert.equal(receipt.checkpoint.ordinal, 1);
    assert.equal(f.store.runs(f.submitted.id).length, 1, 'one reviewer run, no author worker');

    // The shared plan offers the ordinary retained restart, and it applies.
    const view = f.view('restart');
    assert.equal(view.available, true, JSON.stringify(view));
    await restartReviewer(f, 'Continue the retained external review');

    assert.equal(f.reviewerDeliveries.length, 1, 'exactly one continuation was sent');
    assert.equal(f.reviewerDeliveries[0]!.runId, f.runId, 'the SAME reviewer run');
    assert.equal(f.reviewerDeliveries[0]!.messageId, f.run().reviewDeliveries![0]!.deliveryId);
    assert.equal(f.run().agentId, 'review-agent', 'the SAME reviewer agent');
    assert.equal(f.run().workspaceId, f.reviewerWorkspace, 'the SAME pinned workspace');
    assert.equal(f.run().head, f.fixtureHead, 'the SAME exact head');
    assert.equal(f.run().released, false, 'the reader keeps its lease');
    assert.equal(f.run().completion, null, 'a continuation adds no verdict');
    assert.equal(f.run().reviewCheckpoints?.length, 1, 'no checkpoint is invented or renumbered');
    assert.equal(f.current().resolution.currentRunId, f.runId);
    assert.equal(f.current().resolution.reviewerAgentId, 'review-agent');
    assert.equal(f.current().resolution.review, null, 'the continuation grants no review credit');
    assert.equal(f.current().phase, 'reviewing');
    assert.equal(f.current().agentId, null, 'no initial worker is manufactured');
    assert.equal(f.current().workerModel, null);
    assert.deepEqual(f.current().workerModels, []);
    assert.equal(f.current().reviewEntry?.authorDeclaration.models.join(','), declaredAuthors.models.join(','), 'the declaration stays exact');
    assert.equal(f.createdRuns.length, 0, 'no second reviewer, agent or workspace is created');
    assert.deepEqual(f.stops, [], 'nothing is displaced');
    assert.equal(f.events('owner_control').length, 1);

    // A same-intent replay reconciles the recorded delivery and sends nothing.
    const version = f.current().version;
    const replay = await restartReviewer(f, 'Continue the retained external review');
    assert.equal(replay.version, version, 'a replay changes nothing');
    assert.equal(f.reviewerDeliveries.length, 1, 'a replay never sends a second turn');
  } finally { await f.close(); }
});

weighted(2)('a stopped handover reader without checkpoint requires an explicit fresh restart',async()=>{
  const f=fixture({workerless:true});try{
    const original=f.run(),offer=f.view('restart');
    assert.equal(original.reviewCheckpoints?.length??0,0);
    assert.equal(offer.available,true);assert.equal((offer.args as {fresh?:boolean}).fresh,true);
    assert.match(offer.note??'',/new reader/);
    const before=f.current(),events=f.store.eventsAll(f.submitted.id).length;
    await assert.rejects(restartReviewer(f,'Continue same agent'),/restart role=reviewer fresh/);
    await assert.rejects(f.control({action:'restart',role:'reviewer',fresh:false,reason:'Continue same agent'}),/restart role=reviewer fresh/);
    assert.deepEqual(f.current(),before);assert.deepEqual(f.run(),original);
    assert.equal(f.store.eventsAll(f.submitted.id).length,events);
    assert.equal(f.createdRuns.length,0);assert.equal(f.reviewerDeliveries.length,0);
    assert.match(f.moveReviewView().note??'',/idle reader cannot be silently replaced/);
    await assert.rejects(f.control({action:'move',to:'review',reason:'Preserve the stopped reader'}),/restart role=reviewer fresh/);
    assert.equal(f.current().resolution.currentRunId,f.runId);
    assert.equal(f.run().released,false);assert.equal(f.createdRuns.length,0);
    const currentOffer=f.view('restart');assert.equal((currentOffer.args as {fresh?:boolean}).fresh,true);
    await f.control({action:'restart',role:'reviewer',fresh:true,reason:'Deliberately replace the stopped reader'});
    await f.engine.wake();await f.engine.wake();
    assert.equal(f.run().released,true);assert.ok(f.run().replacedAt);
    const replacements=f.store.runs(f.submitted.id).filter(run=>run.role==='reviewer'&&run.id!==f.runId);
    assert.equal(replacements.length,1,`${f.current().phase}: ${f.current().reason}`);assert.equal(f.createdRuns.length,1);
    assert.equal(replacements[0]!.workspaceId,'workspace');
    assert.equal(f.current().resolution.review,null);
  }finally{await f.close();}
});

weighted(2)('an idle task-workspace reader accepts callbacks and is replaced through the ordinary fresh restart',async()=>{
  const f=fixture({workerless:true});try{
    await f.checkpoint('Earlier reading');
    await f.checkpoint('New task-workspace progress');
    const before=f.run().reviewCheckpoints;
    await f.control({action:'restart',role:'reviewer',fresh:true,reason:'Replace the idle reader'});
    await f.engine.wake();await f.engine.wake();
    const old=f.run();assert.equal(old.released,true);assert.ok(old.replacedAt);assert.deepEqual(old.reviewCheckpoints,before);
    assert.equal(f.current().resolution.review,null);
    const replacement=f.store.runs(f.submitted.id).find(r=>r.role==='reviewer'&&r.id!==f.runId)!;
    assert.ok(replacement,`${f.current().phase}: ${f.current().reason}`);
    assert.equal(replacement.workspaceId,'workspace');
  }finally{await f.close();}
});

/** An authenticated observed owner revision, optionally naming its source model. */
const ownerRevision = (taskId: string, model?: string | null, observedReceipt = true) => {
  const at = new Date().toISOString();
  const observed = { at, agentId: 'owner-thread', workspaceId: 'workspace', status: 'idle' as const, active: false as const, permissions: false as const, tools: [] };
  return externalOwnerRevisionReceiptSchema.parse({
    at, operationId: null, actor: { agentId: 'owner-thread', role: 'project_owner' }, authorization: { kind: 'project_owner', note: null },
    reason: 'Owner published a later revision of the same head', previousHead: base, head,
    task: { id: taskId, prNumber: 7, repository: 'example/repo', branch: 'feature/external', workspaceId: 'workspace', directory: '/worktree' },
    brief: { digest: briefDigest(BRIEF_V1), version: 1 }, authorDeclaration: declaredAuthors, fence: null,
    proof: { localHead: head, pushedHead: head, prHead: head, prUrl: 'https://github.com/example/repo/pull/7', base },
    ...(observedReceipt ? { observations: { owner: observed, sourceOwner: { ...observed, model }, coordinator: null, sourceStartedAt: at, sourceCompletedAt: at } } : {}),
  });
};

/** A recorded author-side proof execution (Spec 055) on the task. */
const proofExecution = (taskId: string, options: { agentId: string; model: string }) => proofExecutionRecordSchema.parse({
  runId: `proof-run-${options.agentId}`, agentId: options.agentId, workspaceId: 'workspace',
  profile: { id: 'executor', name: 'executor', provider: 'test', model: options.model, notes: '', available: true, problem: '', supportedThinking: [] },
  selector: 'effigy test --plan', inputs: [], repository: 'example/repo', prNumber: 7, branch: 'feature/external', head,
  briefVersion: 1, briefDigest: briefDigest(BRIEF_V1), authorizedBy: { role: 'operator', caller: null, note: null },
  activatedAt: new Date().toISOString(), settledAt: new Date().toISOString(), status: 'passed', exitCode: 0, evidence: 'selector passed',
});

weighted(2)("workerless author evidence: Continue the colliding reviewer", async () => {
  // Colliding declared external author and reviewer: only the recorded owner
  // route may name that reviewer, and no request was made.
  {
    const f = fixture({ workerless: true, reviewerProfile: profile('reviewer', 'xai/grok-4.6') }); try {
      await f.checkpoint('Reading the external diff');
      await assert.rejects(restartReviewer(f, 'Continue the colliding reviewer'), /not independent of actual task authors/);
      assert.equal(f.reviewerDeliveries.length, 0);
      assert.equal(f.store.run(f.runId)!.released, false);
    } finally { await f.close(); }
  }
});

weighted(2)("workerless author evidence: Continue without author evidence", async () => {
  // Missing author evidence at all: a workerless task with no declaration.
  {
    const f = fixture({ workerless: true }); try {
      await f.checkpoint('Reading the external diff');
      f.store.update(f.submitted.id, { reviewEntry: null });
      await assert.rejects(restartReviewer(f, 'Continue without author evidence'), /independence is unknown/);
      assert.equal(f.reviewerDeliveries.length, 0);
    } finally { await f.close(); }
  }
});

weighted(2)("workerless author evidence: Continue past an opaque owner revision", async () => {
  // Opaque later contributor: an owner revision whose observed source model is
  // not recorded is unknown evidence, not an absent author.
  {
    const f = fixture({ workerless: true }); try {
      await f.checkpoint('Reading the external diff');
      f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, externalOwnerRevisions: [ownerRevision(f.submitted.id)] } });
      await assert.rejects(restartReviewer(f, 'Continue past an opaque owner revision'), /independence is unknown/);
      assert.equal(f.reviewerDeliveries.length, 0);
    } finally { await f.close(); }
  }
});

weighted(2)("workerless author evidence: Continue past an unknown Queue author", async () => {
  // A real Queue author whose current model is unrecorded stays unknown even
  // though the declared external authors are concrete.
  {
    const f = fixture({ workerless: true }); try {
      await f.checkpoint('Reading the external diff');
      f.store.update(f.submitted.id, { agentId: 'worker-agent', runId: 'worker-run' });
      await assert.rejects(restartReviewer(f, 'Continue past an unknown Queue author'), /independence is unknown/);
      assert.equal(f.reviewerDeliveries.length, 0);
    } finally { await f.close(); }
  }
});

weighted(2)("workerless author evidence: Continue past a later colliding contributor", async () => {
  // A later recorded contributor whose model collides with the reviewer.
  {
    const f = fixture({ workerless: true }); try {
      await f.checkpoint('Reading the external diff');
      f.store.putRun(runSchema.parse({ id: 'revision-run', taskId: f.submitted.id, role: 'revision', generation: 1, head, base, agentId: 'revision-agent',
        workspaceId: 'workspace', profile: reviewer, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null,
        active: false, idleSince: null, completion: null, released: true }));
      await assert.rejects(restartReviewer(f, 'Continue past a later colliding contributor'), /not independent of actual task authors/);
      assert.equal(f.reviewerDeliveries.length, 0);
    } finally { await f.close(); }
  }
});

weighted(2)("workerless author evidence: Continue past an unrecorded revision contributor", async () => {
  // A later bound revision contributor whose model was never recorded is opaque
  // author evidence, never an absent one, even beside concrete declarations.
  {
    const f = fixture({ workerless: true }); try {
      await f.checkpoint('Reading the external diff');
      f.store.putRun(runSchema.parse({ id: 'unrecorded-revision', taskId: f.submitted.id, role: 'revision', generation: 1, head, base, agentId: 'revision-agent',
        workspaceId: 'workspace', profile: null, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null,
        active: false, idleSince: null, completion: null, released: true }));
      await assert.rejects(restartReviewer(f, 'Continue past an unrecorded revision contributor'), /independence is unknown/);
      assert.equal(f.reviewerDeliveries.length, 0);
      assert.equal(f.store.run(f.runId)!.released, false);
    } finally { await f.close(); }
  }
});

weighted(2)("workerless author evidence: Continue past an opaque declared author", async () => {
  // The retained author's own revision run adds no unknown author: its model is
  // recorded on the task row for its agent.
  // A provider-qualified unknown declaration is opaque evidence, not a concrete
  // model: admission accepts `provider/unknown`, independence must not.
  {
    const f = fixture({ workerless: true, declaredModels: ['provider/unknown', 'xai/grok-4.7'] }); try {
      await f.checkpoint('Reading the external diff');
      await assert.rejects(restartReviewer(f, 'Continue past an opaque declared author'), /independence is unknown/);
      assert.equal(f.reviewerDeliveries.length, 0);
      assert.equal(f.store.run(f.runId)!.released, false);
    } finally { await f.close(); }
  }
});

weighted(2)("workerless author evidence: Continue past an unobserved owner revision", async () => {
  // A retained owner-revision receipt whose observation is absent still records
  // a later contributor whose model is unknown.
  {
    const f = fixture({ workerless: true }); try {
      await f.checkpoint('Reading the external diff');
      f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, externalOwnerRevisions: [ownerRevision(f.submitted.id, undefined, false)] } });
      await assert.rejects(restartReviewer(f, 'Continue past an unobserved owner revision'), /independence is unknown/);
      assert.equal(f.reviewerDeliveries.length, 0);
      assert.equal(f.store.run(f.runId)!.released, false);
    } finally { await f.close(); }
  }
});

weighted(2)("workerless author evidence: Continue past a blank observed model", async () => {
  // A whitespace-only observed contributor model is blank, not concrete.
  {
    const f = fixture({ workerless: true }); try {
      await f.checkpoint('Reading the external diff');
      f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, externalOwnerRevisions: [ownerRevision(f.submitted.id, '   ')] } });
      await assert.rejects(restartReviewer(f, 'Continue past a blank observed model'), /independence is unknown/);
      assert.equal(f.reviewerDeliveries.length, 0);
      assert.equal(f.store.run(f.runId)!.released, false);
    } finally { await f.close(); }
  }
});

weighted(1)("workerless author evidence: Continue past a blank worker model", async () => {
  // A whitespace-only recorded Queue worker model is blank too.
  {
    const f = fixture(); try {
      await f.checkpoint('Reading the diff');
      f.store.update(f.submitted.id, { workerModel: 'provider/   ', profile: { ...worker, model: 'provider/   ' } });
      await assert.rejects(restartReviewer(f, 'Continue past a blank worker model'), /independence is unknown/);
      assert.equal(f.reviewerDeliveries.length, 0);
      assert.equal(f.store.run(f.runId)!.released, false);
    } finally { await f.close(); }
  }
});

weighted(1)("workerless author evidence: Continue past an opaque worker model", async () => {
  // A Queue worker whose recorded model is `provider/unknown` is unknown too.
  {
    const f = fixture(); try {
      await f.checkpoint('Reading the diff');
      f.store.update(f.submitted.id, { workerModel: 'provider/unknown', profile: { ...worker, model: 'provider/unknown' } });
      await assert.rejects(restartReviewer(f, 'Continue past an opaque worker model'), /independence is unknown/);
      assert.equal(f.reviewerDeliveries.length, 0);
      assert.equal(f.store.run(f.runId)!.released, false);
    } finally { await f.close(); }
  }
});

weighted(2)("workerless author evidence: Continue past the proof executor model", async () => {
  // A recorded author-side proof executor (Spec 055) is author evidence for the
  // later reviewer: its model collision refuses, and its agent can never review.
  {
    const f = fixture({ workerless: true }); try {
      await f.checkpoint('Reading the external diff');
      f.store.update(f.submitted.id, { proofExecutions: [proofExecution(f.submitted.id, { agentId: 'executor-agent', model: reviewer.model })] });
      await assert.rejects(restartReviewer(f, 'Continue past the proof executor model'), /not independent of actual task authors/);
      assert.equal(f.reviewerDeliveries.length, 0);
      assert.equal(f.store.run(f.runId)!.released, false);
    } finally { await f.close(); }
  }
});

weighted(2)("workerless author evidence: Continue a proof executor agent as reviewer", async () => {
  {
    const f = fixture({ workerless: true }); try {
      await f.checkpoint('Reading the external diff');
      f.store.update(f.submitted.id, { proofExecutions: [proofExecution(f.submitted.id, { agentId: 'review-agent', model: 'test/executor' })] });
      await assert.rejects(restartReviewer(f, 'Continue a proof executor agent as reviewer'), /Original reviewer authored this task/);
      assert.equal(f.reviewerDeliveries.length, 0);
      assert.equal(f.store.run(f.runId)!.released, false);
    } finally { await f.close(); }
  }
});

weighted(1)("workerless author evidence: Continue past a prior author model", async () => {
  // A prior Queue author's recorded model is author evidence for the retained
  // reader beside the current one.
  {
    const f = fixture(); try {
      await f.checkpoint('Reading the diff');
      f.store.update(f.submitted.id, { retiredWorkers: [{ agentId: 'old-author', runId: 'old-run', profile: reviewer, reason: 'Replaced by the current worker' }] });
      await assert.rejects(restartReviewer(f, 'Continue past a prior author model'), /not independent of actual task authors/);
      assert.equal(f.reviewerDeliveries.length, 0);
      assert.equal(f.store.run(f.runId)!.released, false);
    } finally { await f.close(); }
  }
});

weighted(2)("workerless author evidence: Continue an unproven reviewer runtime", async () => {
  // An unknown or drifted reviewer runtime is not the retained reader.
  {
    const f = fixture({ workerless: true }); try {
      await f.checkpoint('Reading the external diff');
      f.observe({ model: undefined });
      await assert.rejects(restartReviewer(f, 'Continue an unproven reviewer runtime'), /unknown or changed/);
      assert.equal(f.reviewerDeliveries.length, 0);
      f.observe({ model: 'test/other' });
      await assert.rejects(restartReviewer(f, 'Continue a drifted reviewer runtime'), /unknown or changed/);
      assert.equal(f.reviewerDeliveries.length, 0);
      assert.equal(f.store.run(f.runId)!.released, false);
    } finally { await f.close(); }
  }
});

test('a retained author\'s own revision history never manufactures an unknown author', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    // The author's own revision run records no run profile; the task row still
    // records that agent's model, so the evidence is known, not opaque.
    f.store.putRun(runSchema.parse({ id: 'own-revision', taskId: f.submitted.id, role: 'revision', generation: 1, head, base, agentId: 'worker-agent',
      workspaceId: 'workspace', profile: null, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: false, idleSince: null, completion: null, released: true }));
    await restartReviewer(f, 'Continue past the author\'s own revision history');
    assert.equal(f.reviewerDeliveries.length, 1, 'the recorded author model still proves independence');
    assert.equal(f.store.run(f.runId)!.agentId, 'review-agent', 'the same reader continues');
  } finally { await f.close(); }
});

weighted(2)('a fresh reviewer is never dispatched past an unknown current Queue author', async () => {
  const f = fixture({ workerless: true }); try {
    await f.checkpoint('Reading the external diff');
    // A real Queue author whose current model was never recorded, beside the
    // concrete declared external authors: the head's author is unknown.
    f.store.update(f.submitted.id, { agentId: 'unrecorded-author', runId: 'unrecorded-run' });
    // The retained continuation refuses, and so does the deliberate fresh route:
    // selection admits no reviewer while the current author is unknown.
    await assert.rejects(restartReviewer(f, 'Continue the retained external review'), /independence is unknown/);
    const fresh = await f.control({ action: 'restart', role: 'reviewer', fresh: true, reason: 'Deliberate fresh reviewer' });
    assert.equal(fresh.phase, 'awaiting_review');
    assert.equal(fresh.resolution.reviewerAgentId, null);
    await f.engine.wake();
    assert.equal(f.createdRuns.length, 0, 'no fresh reviewer is launched');
    assert.equal(f.reviewerDeliveries.length, 0, 'the retained reader receives nothing');
    assert.match(f.current().reason, /No eligible independent reviewer profile/);
  } finally { await f.close(); }
});

// ── one stop-backed resume on the same reader ───────────────────────────────

test('a delivered turn stopped by the owner resumes exactly once, and a replay sends nothing', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    await restartReviewer(f, 'Continue the saved checkpoint');
    assert.equal(f.reviewerDeliveries.length, 1);
    const first = f.run().reviewDeliveries![0]!;
    const checkpointBefore = structuredClone(f.run().reviewCheckpoints![0]);

    // The owner stops that delivered turn through the ordinary stop verb.
    const stop = await f.ownerStop('The reviewer wedged on its delivered turn');
    assert.equal(JSON.parse(stop.detail).verb, 'stop');
    assert.equal(f.current().resolution.stop?.reason, 'held', 'the owner stop is the visible held wait');

    // The reader and its checkpoint are still the task's; the stop is the held wait.
    assert.equal(f.current().resolution.currentRunId, f.runId);

    const resumed = await restartReviewer(f, 'Resume the stopped delivered turn');
    assert.equal(f.reviewerDeliveries.length, 2, 'one new continuation effect was sent');
    assert.equal(f.reviewerDeliveries[1]!.runId, f.runId, 'it resumed the same reader');
    const second = f.run().reviewDeliveries!.at(-1)!;
    assert.equal(second.status, 'delivered');
    assert.equal(second.checkpointOrdinal, first.checkpointOrdinal);
    assert.notEqual(second.deliveryId, first.deliveryId, 'the resume has its own durable identity');
    assert.equal(second.deliveryId, resumeDeliveryId(f.submitted.id, f.runId, first.checkpointOrdinal, stop.id),
      'the stop occurrence is the resume identity');
    // The product's own derivation agrees with the documented identity.
    const continuationModule = await import('../core/review/review-continuation') as { reviewDeliveryId?: (input: { taskId: string; runId: string; head: string; checkpointOrdinal: number }, stop?: { eventId: number } | null) => string };
    if (continuationModule.reviewDeliveryId)
      assert.equal(continuationModule.reviewDeliveryId({ taskId: f.submitted.id, runId: f.runId, head, checkpointOrdinal: first.checkpointOrdinal }, { eventId: stop.id }), second.deliveryId);
    // The original receipt, checkpoint and delivery are untouched history.
    assert.equal(f.run().reviewDeliveries![0]!.status, 'delivered');
    assert.equal(f.run().reviewDeliveries![0]!.evidence, first.evidence);
    assert.deepEqual(f.run().reviewCheckpoints![0], checkpointBefore);
    assert.equal(resumed.resolution.currentRunId, f.runId);

    // Replaying the same restart reconciles the recorded delivery and sends nothing.
    const version = f.current().version;
    const replay = await restartReviewer(f, 'Resume the stopped delivered turn');
    assert.equal(f.reviewerDeliveries.length, 2, 'a replay never sends a second turn');
    assert.equal(replay.version, version, 'a replay changes nothing');
  } finally { await f.close(); }
});

test('only a positively confirmed owner stop of that turn authorizes the resume', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    await restartReviewer(f, 'Continue the saved checkpoint');
    assert.equal(f.reviewerDeliveries.length, 1);
    const delivery = f.run().reviewDeliveries![0]!;

    // No stop at all: the delivered continuation is spent.
    await assert.rejects(restartReviewer(f, 'Resume without a stop'), /already has its delivered continuation/);
    assert.equal(f.reviewerDeliveries.length, 1);

    // A displacement stop is not an owner stop of the delivered turn.
    f.store.event(f.submitted.id, 'owner_stop_sent', JSON.stringify({ verb: 'move review', runId: f.runId, role: 'reviewer',
      agentId: 'review-agent', workspaceId: 'workspace', effectId: 'ns-owner-stop-move', status: 'sent' }));
    await assert.rejects(restartReviewer(f, 'Resume after a displacement'), /only an explicit owner stop|already has its delivered continuation/);
    assert.equal(f.reviewerDeliveries.length, 1);

    // A stop recorded for another agent proves nothing about this turn.
    f.store.event(f.submitted.id, 'owner_stop_sent', JSON.stringify({ verb: 'stop', runId: f.runId, role: 'reviewer',
      agentId: 'someone-else', workspaceId: 'workspace', effectId: 'foreign', status: 'sent' }));
    await assert.rejects(restartReviewer(f, 'Resume after a foreign stop'), /not the delivered reviewer/);
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.run().reviewDeliveries?.length, 1, 'the original delivery is never rewritten');

    // An uncertain owner cancellation is inspect-only.
    f.store.event(f.submitted.id, 'owner_stop_uncertain', JSON.stringify({ verb: 'stop', runId: f.runId, role: 'reviewer',
      agentId: 'review-agent', workspaceId: 'workspace', effectId: 'ns-owner-stop-uncertain', status: 'uncertain' }));
    await assert.rejects(restartReviewer(f, 'Resume after an uncertain stop'), /uncertain/);
    assert.equal(f.reviewerDeliveries.length, 1);

    assert.equal(delivery.status, 'delivered', 'the original delivery is never rewritten by a refusal');
  } finally { await f.close(); }
});

test('the stop-backed resume still needs a matching idle reader, the same identity and the exact head', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    await restartReviewer(f, 'Continue the saved checkpoint');
    await f.ownerStop('The reviewer wedged on its delivered turn');

    // A live turn, an active turn id or a pending permission refuses.
    for (const busy of [{ status: 'running' as const, active: true }, { status: 'idle' as const, active: false, activeTurnId: 'reading' },
      { status: 'idle' as const, active: false, permissions: true }]) {
      f.observe({ activeTurnId: undefined, permissions: false, ...busy });
      await assert.rejects(restartReviewer(f, 'Resume the stopped turn'), /active|permission|not idle|no delivery/i);
      assert.equal(f.reviewerDeliveries.length, 1);
    }
    f.observe({ status: 'idle', active: false, activeTurnId: undefined, permissions: false });

    // A changed reviewer identity is not the retained reader.
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, reviewerAgentId: 'someone-else' } });
    await assert.rejects(restartReviewer(f, 'Resume the stopped turn'), /identity/i);
    assert.equal(f.reviewerDeliveries.length, 1);
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution, reviewerAgentId: 'review-agent' } });

    // A changed reviewer workspace is not the retained reader either.
    f.store.putRun({ ...f.run(), workspaceId: 'other-workspace' });
    await assert.rejects(restartReviewer(f, 'Resume the stopped turn'), /workspace|identity/i);
    assert.equal(f.reviewerDeliveries.length, 1);
    f.store.putRun({ ...f.run(), workspaceId: 'workspace' });

    // A moved exact head cannot carry the saved reading.
    f.store.update(f.submitted.id, { prHead: otherHead });
    await assert.rejects(restartReviewer(f, 'Resume the stopped turn'), /head|exact recorded PR head/i);
    assert.equal(f.reviewerDeliveries.length, 1);
    f.store.update(f.submitted.id, { prHead: head });

    // A spent budget or a closed reader keeps its own explicit exits.
    f.store.putRun({ ...f.run(), reviewBudgetExhaustedAt: new Date().toISOString() });
    await assert.rejects(restartReviewer(f, 'Resume the stopped turn'), new RegExp(REVIEW_BUDGET_EXHAUSTED.slice(0, 40)));
    f.store.putRun({ ...f.run(), reviewBudgetExhaustedAt: undefined, retainedAgentClosedAt: new Date().toISOString() });
    await assert.rejects(restartReviewer(f, 'Resume the stopped turn'), new RegExp(REVIEW_AGENT_CLOSED.slice(0, 40)));
    assert.equal(f.reviewerDeliveries.length, 1);

    // With the reader restored, the one authorized resume lands.
    f.store.putRun({ ...f.run(), retainedAgentClosedAt: undefined });
    await restartReviewer(f, 'Resume the stopped turn');
    assert.equal(f.reviewerDeliveries.length, 2);
  } finally { await f.close(); }
});

test('a crash after the stop-backed reservation reconciles without a resend', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    await restartReviewer(f, 'Continue the saved checkpoint');
    const stop = await f.ownerStop('The reviewer wedged on its delivered turn');
    const deliveryId = resumeDeliveryId(f.submitted.id, f.runId, 1, stop.id);
    // The reservation is durable and its send outcome unknown: no evidence on the timeline.
    f.store.putRun({ ...f.run(), reviewDeliveries: [...(f.run().reviewDeliveries ?? []), reviewDeliveryAuthorizationSchema.parse({
      authorizationId: `review-auth-${digest(JSON.stringify([f.submitted.id, f.runId, head, 1, stop.id, 'Resume the stopped delivered turn',
        'Continue the existing task under its current approved instruction source and within its approved scope.']))}`,
      operationId: 'operation-crash', deliveryId, taskId: f.submitted.id, runId: f.runId, head,
      checkpointOrdinal: 1, taskVersion: f.current().version, briefVersion: null, briefDigest: null, reason: 'Resume the stopped delivered turn',
      instruction: 'Continue the existing task under its current approved instruction source and within its approved scope.',
      createdAt: new Date().toISOString(), status: 'reserved', evidence: '', observedAt: null })] });
    const before = f.reviewerDeliveries.length;
    await assert.rejects(restartReviewer(f, 'Resume the stopped delivered turn'), /remains uncertain|inspect/i);
    assert.equal(f.reviewerDeliveries.length, before, 'an unknown send is never resent');
    assert.equal(f.run().reviewDeliveries?.at(-1)?.status, 'uncertain', 'the durable hold is retained for inspection');
    assert.equal(f.run().reviewDeliveries?.at(-1)?.deliveryId, deliveryId);
  } finally { await f.close(); }
});

// ── the recorded checkpoint-6 shape, a second stop, and a changed brief ─────

test('the recorded checkpoint-6 shape: six delivered continuations, one owner stop, exactly one resumed effect', async () => {
  const f = fixture(); try {
    // The recorded live case (papercut 62213296) is checkpoint 6 on the same
    // reader at one unchanged head, its continuation delivered, then an owner
    // stop. Queue's default continuation limit is six, so this is the real shape.
    for (let ordinal = 1; ordinal <= REVIEW_CONTINUATION_LIMIT; ordinal++) {
      const receipt = await f.checkpoint(`Reading section ${ordinal}`, `Reading section ${ordinal}`);
      assert.equal(receipt.checkpoint.ordinal, ordinal);
      f.observe({ status: 'idle', active: false, permissions: false });
      await restartReviewer(f, `Continue from section ${ordinal}`);
      assert.equal(f.reviewerDeliveries.length, ordinal, `checkpoint ${ordinal} reached exactly one continuation`);
    }
    const delivered = f.run().reviewDeliveries!.at(-1)!;
    // Genuinely captured pre-resume evidence: the full delivery and checkpoint
    // records and the owner-only checkpoint file, compared after the resume.
    const deliveriesBefore = structuredClone(f.run().reviewDeliveries!);
    const checkpointsBefore = structuredClone(f.run().reviewCheckpoints!);
    const checkpointBytes = readFileSync(checkpointsBefore.at(-1)!.path, 'utf8');

    const stop = await f.ownerStop('The reviewer wedged on checkpoint six');
    const stopDetail = JSON.parse(stop.detail) as { verb: string; agentId: string; workspaceId: string };
    assert.equal(stopDetail.verb, 'stop');

    await restartReviewer(f, 'Resume the stopped checkpoint-six turn');
    assert.equal(f.reviewerDeliveries.length, REVIEW_CONTINUATION_LIMIT + 1, 'exactly one new effect was sent');
    const resumed = f.run().reviewDeliveries!.at(-1)!;
    assert.equal(resumed.status, 'delivered');
    assert.equal(resumed.checkpointOrdinal, REVIEW_CONTINUATION_LIMIT);
    assert.equal(resumed.deliveryId, resumeDeliveryId(f.submitted.id, f.runId, REVIEW_CONTINUATION_LIMIT, stop.id),
      'the stop occurrence is the resume identity');
    assert.notEqual(resumed.deliveryId, delivered.deliveryId);

    // The captured pre-resume evidence is untouched: every original delivery and
    // checkpoint record, their JSON bytes, and the owner-only checkpoint file.
    assert.deepEqual(f.run().reviewDeliveries!.slice(0, deliveriesBefore.length), deliveriesBefore, 'all six original deliveries are unchanged');
    assert.equal(JSON.stringify(f.run().reviewDeliveries!.slice(0, deliveriesBefore.length)), JSON.stringify(deliveriesBefore));
    assert.deepEqual(f.run().reviewCheckpoints, checkpointsBefore, 'every original checkpoint is unchanged');
    assert.equal(JSON.stringify(f.run().reviewCheckpoints), JSON.stringify(checkpointsBefore));
    assert.equal(readFileSync(checkpointsBefore.at(-1)!.path, 'utf8'), checkpointBytes, 'the checkpoint file is never rewritten');
    assert.equal(f.run().reviewCheckpoints?.length, REVIEW_CONTINUATION_LIMIT);
    assert.equal(f.current().resolution.currentRunId, f.runId, 'the reader is the same reader');
    assert.equal(f.stops.filter(agent => agent === 'review-agent').length, 1, 'the one owner stop cancelled one turn');

    // A replay of the same resume sends nothing and changes nothing.
    const version = f.current().version;
    await restartReviewer(f, 'Resume the stopped checkpoint-six turn');
    assert.equal(f.reviewerDeliveries.length, REVIEW_CONTINUATION_LIMIT + 1);
    assert.equal(f.current().version, version);
  } finally { await f.close(); }
});

test('a later delivery supersedes the earlier stopped intent, which can send nothing more', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    await restartReviewer(f, 'Continue the saved checkpoint');
    // The stopped intent: the owner stops that delivered turn and resumes it once.
    const stopA = await f.ownerStop('The reviewer wedged on its delivered turn');
    await restartReviewer(f, 'Resume after stop A');
    assert.equal(f.reviewerDeliveries.length, 2);
    const stoppedIntent = f.run().reviewDeliveries!.at(-1)!;
    assert.equal(stoppedIntent.deliveryId, resumeDeliveryId(f.submitted.id, f.runId, 1, stopA.id));

    // A LATER delivery follows: a new authenticated checkpoint gets its own
    // ordinary continuation, which is now the reviewer's latest delivered turn.
    await f.checkpoint('Reading the next section');
    f.observe({ status: 'idle', active: false, permissions: false });
    await restartReviewer(f, 'Continue the new checkpoint');
    assert.equal(f.reviewerDeliveries.length, 3);
    const laterDelivery = f.run().reviewDeliveries!.at(-1)!;
    assert.equal(laterDelivery.checkpointOrdinal, 2);

    // Replaying the earlier stopped intent after that later delivery sends
    // nothing: it cannot reach its own spent delivery across the newer turn, and
    // it never rewrites or re-sends the later one.
    const deliveriesBefore = structuredClone(f.run().reviewDeliveries!);
    const checkpointsBefore = structuredClone(f.run().reviewCheckpoints!);
    const version = f.current().version;
    await assert.rejects(restartReviewer(f, 'Resume after stop A'),
      /already has its delivered continuation|different durable operator authorization|no second turn/i);
    assert.equal(f.reviewerDeliveries.length, 3, 'the stale intent sent no turn');
    assert.deepEqual(f.run().reviewDeliveries, deliveriesBefore, 'every recorded delivery is unchanged');
    assert.deepEqual(f.run().reviewCheckpoints, checkpointsBefore, 'every recorded checkpoint is unchanged');
    assert.equal(JSON.stringify(f.run().reviewDeliveries), JSON.stringify(deliveriesBefore));
    assert.equal(f.current().version, version, 'a refused stale intent changes nothing');
    assert.equal(f.current().resolution.currentRunId, f.runId, 'the reader is unchanged');
    assert.equal(f.store.run(f.runId)!.released, false);
    assert.equal(f.stops.filter(agent => agent === 'review-agent').length, 1, 'no cancellation was made for the stale intent');
  } finally { await f.close(); }
});

test('a second confirmed owner stop authorizes its own single resumed effect', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    await restartReviewer(f, 'Continue the saved checkpoint');
    const firstDelivery = f.run().reviewDeliveries!.at(-1)!;

    const stopA = await f.ownerStop('First wedge');
    await restartReviewer(f, 'Resume after the first stop');
    const resumeA = f.run().reviewDeliveries!.at(-1)!;
    assert.equal(resumeA.deliveryId, resumeDeliveryId(f.submitted.id, f.runId, 1, stopA.id));

    // A second, later owner stop is a new explicit act: it authorizes its own
    // effect rather than reconciling or refusing against the first one.
    f.observe({ status: 'running', active: true });
    const stopB = await f.ownerStop('Second wedge');
    f.observe({ status: 'idle', active: false, permissions: false });
    assert.notEqual(stopB.id, stopA.id);
    await restartReviewer(f, 'Resume after the second stop');
    assert.equal(f.reviewerDeliveries.length, 3, 'the second stop sent exactly one new effect');
    const resumeB = f.run().reviewDeliveries!.at(-1)!;
    assert.equal(resumeB.status, 'delivered');
    assert.equal(resumeB.deliveryId, resumeDeliveryId(f.submitted.id, f.runId, 1, stopB.id));

    // Replaying B's intent is inspect-only; a different intent for the same spent
    // stop never reaches back to the first stop's delivery.
    const version = f.current().version;
    await restartReviewer(f, 'Resume after the second stop');
    assert.equal(f.reviewerDeliveries.length, 3);
    assert.equal(f.current().version, version);
    await assert.rejects(restartReviewer(f, 'A third intent for the spent stop'), /already has its delivered continuation|different durable operator authorization/);
    assert.equal(f.reviewerDeliveries.length, 3, 'no turn was sent');
    // A's delivery stays history; the reader and the checkpoint are unchanged.
    assert.equal(f.run().reviewDeliveries!.find(item => item.deliveryId === resumeA.deliveryId)!.status, 'delivered');
    assert.equal(f.run().reviewDeliveries!.find(item => item.deliveryId === firstDelivery.deliveryId)!.status, 'delivered');
    assert.equal(f.current().resolution.currentRunId, f.runId);
  } finally { await f.close(); }
});

test('an amended brief is still carried to an awaiting checkpoint but never across an owner stop', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    // Ordinary awaiting-checkpoint authority: an amendment is carried and re-pins
    // the run to the brief it read (Tom, 2026-10-18).
    f.amend(BRIEF_V2);
    await restartReviewer(f, 'Continue under the amended brief');
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.run().briefVersion, 2, 'the delivered turn read the amended brief');
    assert.equal(f.run().reviewDeliveries!.at(-1)!.briefVersion, 2);

    // The delivered turn is stopped, then the brief is amended again. That is a
    // changed target for a stop-backed resume: it refuses and names the
    // deliberate fresh replacement, without sending anything.
    await f.ownerStop('The reviewer wedged on its delivered turn');
    f.amend(BRIEF_V3);
    // Next/apply parity: the owner's own stop hold yields to their restart, so
    // admission (and its brief gate) runs immediately — the view must run the same
    // gate and refuse, never advertise the same-reader restart the apply refuses.
    const refusedView = f.view('restart');
    assert.equal(refusedView.available, false, JSON.stringify(refusedView));
    assert.match(refusedView.refusal!, /brief changed after the delivered continuation[\s\S]*restart role=reviewer fresh/);
    const before = f.reviewerDeliveries.length;
    await assert.rejects(restartReviewer(f, 'Resume the stopped turn under the new brief'),
      /brief changed after the delivered continuation[\s\S]*restart role=reviewer fresh/);
    assert.equal(f.reviewerDeliveries.length, before, 'no turn was sent under the amended brief');
    assert.equal(f.store.run(f.runId)!.released, false, 'the reader keeps its lease and checkpoint');

    // The deliberate replacement is the exit, and it is explicit.
    await f.control({ action: 'restart', role: 'reviewer', fresh: true, reason: 'Replace the stopped reader at the amended brief' });
    assert.equal(f.current().phase, 'awaiting_review');
    assert.equal(f.store.run(f.runId)!.released, true);
    assert.ok(f.store.run(f.runId)!.replacedAt);
  } finally { await f.close(); }
});

// ── durable ordering, tool evidence, later events, holds, legacy records ────

test('an older stop, even at the delivery\'s own millisecond, never authorizes a resume', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    // The owner stops the original reading turn before any continuation exists.
    const older = await f.ownerStop('Stop the original reading turn');
    // The awaiting checkpoint is then continued the ordinary way.
    await restartReviewer(f, 'Continue the awaiting checkpoint');
    assert.equal(f.reviewerDeliveries.length, 1);
    const delivery = f.run().reviewDeliveries!.at(-1)!;
    assert.ok(delivery.observedAt);
    // The older stop now carries the same millisecond as the delivery, as a real
    // same-millisecond record would. Durable event order still places it before
    // the delivery's own recorded outcome, so it cannot authorize anything.
    f.store.db.prepare('UPDATE events SET at=? WHERE id=?').run(delivery.observedAt, older.id);
    await assert.rejects(restartReviewer(f, 'Resume the older stop'), /already has its delivered continuation|ambiguous/i);
    assert.equal(f.reviewerDeliveries.length, 1, 'the older stop bought no delivery');
    assert.equal(f.run().reviewDeliveries?.length, 1);

    // A stop genuinely recorded after the delivered turn still authorizes its own.
    f.observe({ status: 'running', active: true });
    const later = await f.ownerStop('A later wedge');
    f.observe({ status: 'idle', active: false, permissions: false });
    assert.notEqual(later.id, older.id);
    await restartReviewer(f, 'Resume after the later stop');
    assert.equal(f.reviewerDeliveries.length, 2);
  } finally { await f.close(); }
});

test('records that cannot prove their order refuse the resume instead of inferring authority', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    const older = await f.ownerStop('Stop before the continuation');
    await restartReviewer(f, 'Continue the awaiting checkpoint');
    const delivery = f.run().reviewDeliveries!.at(-1)!;
    // A legacy record with no delivery outcome event loses the durable ordering
    // anchor. With an equal timestamp the order is unknowable, so Queue refuses
    // rather than reading equality as "after".
    f.store.db.prepare("DELETE FROM events WHERE kind LIKE 'review_delivery_%' AND detail LIKE ?").run(`%${delivery.deliveryId}%`);
    f.store.db.prepare('UPDATE events SET at=? WHERE id=?').run(delivery.observedAt, older.id);
    await assert.rejects(restartReviewer(f, 'Resume the older stop'), /ambiguous order|ambiguous|cannot be shown to follow/i);
    assert.equal(f.reviewerDeliveries.length, 1, 'no turn was sent');
  } finally { await f.close(); }
});

weighted(2)('a stop-backed resume needs positive owned-tool evidence', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    await restartReviewer(f, 'Continue the saved checkpoint');
    await f.ownerStop('The reviewer wedged');

    // A live tool on the stopped turn refuses before any send.
    f.setTimeline([{ timestamp: new Date().toISOString(),
      item: { type: 'tool_call', callId: 'shell-1', name: 'exec', status: 'running', detail: { type: 'shell', command: 'npm test' } } }]);
    await assert.rejects(restartReviewer(f, 'Resume the stopped turn'), /live tool|no live tool/i);
    assert.equal(f.reviewerDeliveries.length, 1);

    // Complete evidence with no live tool lets the one authorized resume land.
    f.setTimeline([]);
    await restartReviewer(f, 'Resume the stopped turn');
    assert.equal(f.reviewerDeliveries.length, 2);
  } finally { await f.close(); }

  // An adapter that offers no tool timeline cannot prove the condition: it
  // refuses rather than treating missing evidence as clear.
  const blind = fixture({ toolTimeline: false }); try {
    await blind.checkpoint('Reading the diff');
    await restartReviewer(blind, 'Continue the saved checkpoint');
    await blind.ownerStop('The reviewer wedged');
    await assert.rejects(restartReviewer(blind, 'Resume the stopped turn'), /tool evidence is unavailable|no live tool/i);
    assert.equal(blind.reviewerDeliveries.length, 1, 'no turn was sent without tool evidence');
  } finally { await blind.close(); }
});

test('a later checkpoint or verdict supersedes the stopped intent', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    await restartReviewer(f, 'Continue the saved checkpoint');
    await f.ownerStop('The reviewer wedged');
    // A later authenticated checkpoint is new unfinished work: the continuation
    // it gets is the ordinary checkpoint one, not a stop-backed resume.
    await f.checkpoint('Reading the next section');
    f.observe({ status: 'idle', active: false, permissions: false });
    await restartReviewer(f, 'Continue the new checkpoint');
    assert.equal(f.reviewerDeliveries.length, 2);
    assert.equal(f.run().reviewDeliveries!.at(-1)!.deliveryId, `ns-review-${digest(`${f.submitted.id}:${f.runId}:${head}:2`)}`,
      'the new checkpoint carries its own plain identity');
    // A later authenticated verdict ends the fence: nothing more is sent.
    f.store.putRun({ ...f.run(), completion: { taskId: f.submitted.id, runId: f.runId, eventId: 'late-verdict', status: 'changes_required',
      summary: 'One finding', head } as never });
    await assert.rejects(restartReviewer(f, 'Resume after the verdict'),
      /completed|released|current reviewer|No stopped, stalled, idle, checkpointed, blocked or errored reviewer run needs a restart/i);
    assert.equal(f.reviewerDeliveries.length, 2, 'the verdict superseded the stopped intent');
  } finally { await f.close(); }
});

test('a parent-format reserved continuation is inspected and reconciled, never reauthorized', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    const deliveryId = `ns-review-${digest(`${f.submitted.id}:${f.runId}:${head}:1`)}`;
    const reason = 'Continue the awaiting checkpoint';
    const instruction = 'Continue the existing task under its current approved instruction source and within its approved scope.';
    // The parent revision wrote this reservation with no stop field in its
    // authorization identity; it must still be recognised and inspected.
    f.store.putRun({ ...f.run(), reviewDeliveries: [reviewDeliveryAuthorizationSchema.parse({
      authorizationId: `review-auth-${digest(JSON.stringify([f.submitted.id, f.runId, head, 1, reason, instruction]))}`,
      operationId: 'parent-operation', deliveryId, taskId: f.submitted.id, runId: f.runId, head, checkpointOrdinal: 1,
      taskVersion: f.current().version, briefVersion: null, briefDigest: null, reason, instruction,
      createdAt: new Date().toISOString(), status: 'reserved', evidence: '', observedAt: null })] });
    // Task 620 (PR 868) reads delivery evidence from the complete projected
    // timeline page, so the parent-format turn rides the page (setTimeline),
    // not the legacy tail the older evidence path read.
    f.setTimeline([{ timestamp: new Date().toISOString(), item: { type: 'user_message', messageId: deliveryId, text: 'parent turn' } }]);
    const resumed = await restartReviewer(f, reason);
    assert.equal(f.reviewerDeliveries.length, 0, 'the recorded turn was reconciled, not sent again');
    assert.equal(f.run().reviewDeliveries?.at(-1)?.status, 'delivered');
    assert.equal(f.run().reviewDeliveries?.at(-1)?.deliveryId, deliveryId);
    assert.equal(resumed.resolution.currentRunId, f.runId);
  } finally { await f.close(); }
});

test('owner stop yields, an operator hold defers, and pause allows a bound restart', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    await restartReviewer(f, 'Continue the saved checkpoint');
    await f.ownerStop('The reviewer wedged');
    // The owner's own stop hold yields to the owner's restart: it applies now.
    await restartReviewer(f, 'Resume after the owner stop');
    assert.equal(f.reviewerDeliveries.length, 2);
    assert.equal(f.holds().dispatch, undefined, 'the owner stop hold was released by the owner\'s own restart');

    // An operator dispatch hold stands first, so the owner's later stop leaves it
    // in place: the resume is recorded, sends nothing, and applies exactly once
    // after the operator releases it.
    await f.control({ action: 'hold', kind: 'dispatch', reason: 'Operator maintenance' });
    await f.ownerStop('Second wedge');
    const deferred = await restartReviewer(f, 'Resume under the operator hold');
    assert.equal(f.reviewerDeliveries.length, 2, 'nothing was sent while the operator hold stands');
    assert.equal(deferred.resolution.deferredVerb?.why, 'held');
    assert.equal(deferred.resolution.deferredVerb?.target?.runId, f.runId);
    // A release takes no reason: the hold's own record is its authority text.
    await f.control({ action: 'release', kind: 'dispatch', reason: undefined });
    await f.engine.wake();
    await f.engine.quiesce();
    assert.equal(f.reviewerDeliveries.length, 3, 'the deferred resume applied exactly once');

    // Pause allows the already-bound reviewer to settle in flight.
    f.observe({ status: 'running', active: true });
    await f.ownerStop('Third wedge');
    f.observe({ status: 'idle', active: false, permissions: false });
    f.store.setMeta('paused', true);
    const pausedView = f.view('restart');
    assert.equal(pausedView.available, true, JSON.stringify(pausedView));
    const pausedApply = await f.control({ action: 'restart', role: 'reviewer', reason: 'Resume while paused' });
    assert.equal(f.reviewerDeliveries.length, 4, 'the bound reviewer continues while paused');
    assert.equal(pausedApply.resolution.deferredVerb, null);
    f.store.setMeta('paused', false);
    await f.engine.wake();
    await f.engine.quiesce();
    assert.equal(f.reviewerDeliveries.length, 4, 'unpausing sends no second continuation');
  } finally { await f.close(); }
});

test('next and apply agree on the stop-backed resume: owner stop, operator hold and the stalled fence', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    await restartReviewer(f, 'Continue the saved checkpoint');
    const ownerStopped = await f.ownerStop('The reviewer wedged');

    // Owner stop: the restart view offers the same reader, and applying it does
    // exactly what the view said — one new delivery on the same run.
    const offered = f.view('restart');
    assert.equal(offered.available, true, JSON.stringify(offered));
    assert.equal((offered.args as Record<string, unknown>).fresh, undefined, 'the offered control continues the same reader');
    await f.control({ action: 'restart', role: 'reviewer', reason: 'Resume the stopped turn' });
    assert.equal(f.reviewerDeliveries.length, 2);
    assert.equal(f.current().resolution.currentRunId, f.runId);
    assert.equal(f.run().reviewDeliveries?.at(-1)!.deliveryId,
      resumeDeliveryId(f.submitted.id, f.runId, 1, ownerStopped.id), 'the applied control used the stop occurrence the view described');
    // The spent stop is no longer offered; the same intent replays idempotently
    // (no send), and a new intent refuses.
    const spent = f.view('restart');
    assert.equal(spent.available, false, JSON.stringify(spent));
    const replayed = await f.control({ action: 'restart', role: 'reviewer', reason: 'Resume the stopped turn' });
    assert.equal(f.reviewerDeliveries.length, 2, 'the same intent is a replay, never a second send');
    assert.equal(replayed.resolution.currentRunId, f.runId);
    await assert.rejects(f.control({ action: 'restart', role: 'reviewer', reason: 'A new intent for the spent stop' }),
      /already has its delivered continuation|different durable operator authorization/i);
    assert.equal(f.reviewerDeliveries.length, 2);

    // Operator hold: both views keep offering the same reader as a deferred
    // delivery, and applying it sends nothing until the operator releases it.
    await f.control({ action: 'hold', kind: 'dispatch', reason: 'Operator maintenance' });
    await f.ownerStop('Second wedge');
    const heldView = f.view('restart');
    assert.equal(heldView.available, true, JSON.stringify(heldView));
    const deferred = await f.control({ action: 'restart', role: 'reviewer', reason: 'Resume under the operator hold' });
    assert.equal(f.reviewerDeliveries.length, 2, 'the offered control sent nothing while held');
    assert.equal(deferred.resolution.deferredVerb?.why, 'held');
    assert.equal(deferred.resolution.deferredVerb?.target?.runId, f.runId);
    await f.control({ action: 'release', kind: 'dispatch', reason: undefined });
    await f.engine.wake();
    await f.engine.quiesce();
    assert.equal(f.reviewerDeliveries.length, 3, 'the deferred control applied exactly once');
    assert.equal(f.reviewerDeliveries.at(-1)!.runId, f.runId);
  } finally { await f.close(); }
});

test('a stalled-turn fence refuses the resumed delivery in both the view and the applying control', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    await restartReviewer(f, 'Continue the saved checkpoint');
    await f.ownerStop('The reviewer wedged');
    await f.releaseDispatch();
    // An unresolved stalled-turn stop is a fence the continuation gate refuses.
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution,
      stalledTurnStop: { runId: f.runId, role: 'reviewer', agentId: 'review-agent', workspaceId: 'workspace', turnId: 'turn-1',
        effectId: 'effect-1', status: 'sent', attempts: 1, requestedAt: new Date().toISOString(), observedInactiveAt: null, detail: '' } } });
    const view = f.view('restart');
    assert.equal(view.available, false, JSON.stringify(view));
    assert.match(view.refusal!, /incident|recovery fence/i);
    await assert.rejects(f.control({ action: 'restart', role: 'reviewer', reason: 'Resume the stopped turn' }),
      /incident|recovery fence/i);
    assert.equal(f.reviewerDeliveries.length, 1, 'no turn was sent across the fence');
  } finally { await f.close(); }
});

test('a preserving move to=review is offered only where its delegated continuation applies', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    f.observe({ status: 'idle', active: false, permissions: false });
    // Without a fence both views offer the move and it continues the reader.
    const offered = f.moveReviewView();
    assert.equal(offered.available, true, JSON.stringify(offered));
    assert.match(offered.note!, /preserves the valid reader/);
    await f.control({ action: 'move', to: 'review', reason: 'Move the review forward' });
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.current().resolution.currentRunId, f.runId);

    // A new awaiting checkpoint plus a stalled-turn fence: the delegated
    // continuation is refused by its own gate, so the move view must refuse too
    // instead of advertising a continuation that cannot apply.
    await f.ownerStop('The reviewer wedged');
    await f.releaseDispatch();
    await f.checkpoint('Reading the next section');
    f.observe({ status: 'idle', active: false, permissions: false });
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution,
      stalledTurnStop: { runId: f.runId, role: 'reviewer', agentId: 'review-agent', workspaceId: 'workspace', turnId: 'turn-1',
        effectId: 'effect-1', status: 'sent', attempts: 1, requestedAt: new Date().toISOString(), observedInactiveAt: null, detail: '' } } });
    const fenced = f.moveReviewView();
    assert.equal(fenced.available, false, JSON.stringify(fenced));
    assert.match(fenced.refusal!, /move review: .*incident|recovery fence/i);
    await assert.rejects(f.control({ action: 'move', to: 'review', reason: 'Move across the fence' }), /incident|recovery fence/i);
    assert.equal(f.reviewerDeliveries.length, 1, 'the move sent nothing across the fence');
    assert.equal(f.current().resolution.currentRunId, f.runId, 'the reader and its checkpoint are preserved');
  } finally { await f.close(); }
});

test('a maximal hold reason cannot truncate the charged count and work basis away', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    for (let index = 0; index < 3; index++) f.store.putRun(runSchema.parse({
      id: `charged-long-${index}`, taskId: f.submitted.id, role: 'recovery', generation: 1, head, base, agentId: `coordinator-long-${index}`,
      workspaceId: 'workspace', profile: null, status: 'finished', createdAt: new Date(Date.now() + index).toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: true }));
    const holdReason = `Operator maintenance window: ${'z'.repeat(4000)}`.slice(0, 4000);
    f.store.update(f.submitted.id, { held: true, holds: { dispatch: { owner: 'operator', reason: holdReason,
      at: new Date().toISOString(), generation: f.current().coordinatorGeneration, until: null } } });
    const stop = f.next().stop!;
    assert.equal(stop.kind, 'hold');
    assert.equal(stop.owner, 'operator', 'the hold owner stays truthful');
    assert.equal(stop.detail.startsWith('Operator maintenance window:'), true, 'the hold reason leads the text');
    assert.match(stop.detail, /Coordinator recovery: 3 of 3 launches are charged to the current work/,
      'the charged count survives a maximal accepted hold reason');
    assert.match(stop.detail, /coverage checkpoint 1/);
    assert.ok(stop.detail.length <= 2000);
  } finally { await f.close(); }
});

test('a held stop still shows the charged recovery count and its work basis', async () => {
  const f = fixture(); try {
    await f.checkpoint('Reading the diff');
    // Three coordinator launches charged to this work, then a dispatch hold.
    for (let index = 0; index < 3; index++) f.store.putRun(runSchema.parse({
      id: `charged-${index}`, taskId: f.submitted.id, role: 'recovery', generation: 1, head, base, agentId: `coordinator-${index}`,
      workspaceId: 'workspace', profile: null, status: 'finished', createdAt: new Date(Date.now() + index).toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: true }));
    f.store.update(f.submitted.id, { held: true, holds: { dispatch: { owner: 'operator', reason: 'Operator maintenance',
      at: new Date().toISOString(), generation: f.current().coordinatorGeneration, until: null } } });
    const stop = f.next().stop!;
    assert.equal(stop.kind, 'hold');
    assert.equal(stop.detail.startsWith('Operator maintenance'), true, 'the hold keeps its own reason first');
    assert.match(stop.detail, /Coordinator recovery: 3 of 3 launches are charged to the current work/);
    assert.match(stop.detail, new RegExp(`head ${head}`));
    assert.match(stop.detail, /coverage checkpoint 1/);
    assert.equal(stop.owner, 'operator', 'the hold owner stays truthful');
    assert.match(stop.evidence ?? '', /dispatch hold generation/);
  } finally { await f.close(); }
});
