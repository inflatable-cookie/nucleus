import { test } from './support/sharded-test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownerRevisionFixture, runGit } from './support/review-entry-fixture';
import { OPERATOR_BOARD_CALLER, submissionSchema, taskControlInputSchema, type Run, type Profile } from '../shared/contracts';
import { Reports } from '../core/intake/report';
import { digest } from '../core/store/store';
import { reviewPublicationBody } from '../core/forge/index';
import { blockingRecoveryEffects } from '../core/recovery/recovery-effects';
import type { ResolutionAdapter } from '../core/resolution';
import { ordinaryReviewSource, ordinaryReviewDelta, REVIEW_PROMPT_INLINE_BUDGET } from '../core/review/ordinary-review';
import { toolTimelinePage } from './support/tool-timeline';
import { runPrompt } from '../core/dispatch/prompts';
import { currentBrief } from '../core/planning/brief';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';

function fixture() {
  const f = ownerRevisionFixture();
  let store = f.store;
  const worker: Profile = { ...f.reviewer, id: 'worker', model: 'gpt-6.1-terra' };
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Ordinary delta review',
    repoPath: f.repo, planningCommit: f.planningCommit, brief: { text: 'Review feature changes.', mediaType: 'text/markdown' }, originAgentId: 'origin' }), 'host', 'Review feature changes.', f.planningCommit);
  store.setMeta('paused', false);
  store.setMeta('pool', [{ profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] }, { profileId: f.reviewer.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] }]);
  store.update(task.id, { phase: 'awaiting_review', branch: 'feature/external', workspaceId: 'workspace', directory: f.workspace,
    agentId: 'worker', runId: 'worker-run', profile: worker, workerModel: worker.model, workerModels: [worker.model],
    workspaceIntent: true, agentIntent: true, prHead: f.oldHead, prUrl: 'https://github.com/example/repo/pull/41', resumePrNumber: 41,
    completion: { taskId: task.id, runId: 'worker-run', eventId: 'ready', status: 'ready_for_review', summary: 'Ready', prNumber: 41, head: f.oldHead } });
  f.states.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', provider: worker.provider, model: worker.model });
  const sends: Run[] = [];
  let reviewPublications = 0;
  const make = (f.buildAdapter() as ReturnType<typeof f.buildAdapter> & ResolutionAdapter).createRun;

  const faults = { unknownTools: false, staleCovering: false, mergeNeedsApproval: false, blockOrdinarySend: false };
  const overrides: Parameters<typeof f.buildEngine>[0] = {
    verifyPr: async () => ({ url: store.task(task.id).prUrl!, head: f.state.prSha }),
    verifyPrIdentity: async () => ({ url: store.task(task.id).prUrl!, head: f.state.prSha,
      repository: 'example/repo', headRepository: 'example/repo', crossRepository: false }),
    verifyResume: async () => runGit(f.workspace, 'rev-parse', 'HEAD'),
    publishReview: async () => { reviewPublications++; return 101; },
    mergeGate: async () => {
      // The real forge refuses the merge gate until a review approves the exact head.
      if (faults.mergeNeedsApproval) throw new Error('The recorded review does not approve merging');
      return { head: faults.staleCovering ? f.oldHead : f.state.prSha, base: runGit(f.repo, 'rev-parse', 'main'), wait: '' };
    },
    coveringEvidence: async () => ({ head: faults.staleCovering ? f.oldHead : f.state.prSha, base: runGit(f.repo, 'rev-parse', 'main'), wait: '' }),
    agentTimelinePage: async () => faults.unknownTools ? null : toolTimelinePage([]),
    continueReviewer: async (t, run, _id, _text, allowed, stillAllowed) => {
      assert.equal(await allowed(), true); assert.equal(stillAllowed(), true);
      await ordinaryReviewSource(t, run.head, true); sends.push(run); return { sent: true };
    },
    createRun: async (t, run, token) => {
      const created = await make!(t, run, token);
      const actual = run.profile!;
      f.states.set(created.id, { id: created.id, workspaceId: run.workspaceId, status: 'running', active: true, permissions: false, error: '', provider: actual.provider, model: actual.model });
      return created;
    },
    sendRun: async (t, run, token, _context, _owner, guard) => {
      if (run.role !== 'reviewer') { f.tokens.set(run.id, token); return; }
      assert.ok(guard, 'ordinary retained round has final send guard');
      if(run.ordinaryDetached&&faults.blockOrdinarySend){
        faults.blockOrdinarySend=false;
        store.putNotice({id:'attention-race',taskId:task.id,agentId:'origin',recipientAgentId:'origin',workspaceId:null,
          sources:[],originEntry:true,kind:'attention',status:'uncertain',error:'delivery unknown',text:'Queue needs attention'});
      }
      assert.equal(await guard.allowed(), true);
      assert.equal(guard.stillAllowed(), true);
      await ordinaryReviewSource(t, run.head, true);
      f.tokens.set(run.id, token); sends.push(run);
      f.states.set(run.agentId!, { ...f.states.get(run.agentId!)!, status: 'running', active: true });
    },
  };
  let { engine, adapter } = f.buildEngine(overrides);
  engine.profiles = [f.reviewer, worker];
  const current = () => store.run(store.task(task.id).resolution.currentRunId!)!;
  const idle = (run: Run) => f.states.set(run.agentId!, { id: run.agentId!, workspaceId: run.workspaceId, status: 'idle', active: false, permissions: false, error: '', provider: run.profile!.provider, model: run.profile!.model });
  const report = async (run: Run, status: 'changes_required' | 'ready_to_merge' | 'blocked', extra = {}) => {
    idle(run);
    const result = await new Reports(engine).report({ taskId: task.id, runId: run.id, eventId: randomUUID(), status,
      head: run.head, summary: status === 'changes_required' ? 'Fix feature' : 'Source examined', reviewText: 'Earlier finding: fix feature',
      ...(status === 'changes_required' ? { reviewResponsibility: 'author' as const } : {}), ...extra }, f.tokens.get(run.id)!);
    assert.equal((result as {accepted:boolean}).accepted, true, JSON.stringify(result));
    await engine.wake(); await engine.wake();
  };
  const restart = async () => {
    await engine.stop(); f.reopen(); store = f.store;
    ({ engine, adapter } = f.buildEngine(overrides)); engine.profiles = [f.reviewer, worker];
    await engine.wake();
  };
  return { ...f, get store() { return store; }, task, get engine() { return engine; }, get adapter() { return adapter; }, sends, get reviewPublications() { return reviewPublications; }, current, report, idle, restart, faults };
}

async function pendingVerdict(status: 'ready_to_merge' | 'changes_required' = 'ready_to_merge') {
  const f = fixture();
  await f.engine.wake();
  const run = f.current();
  await f.report(run, status);
  const storedRun = f.store.run(run.id)!;
  const { reviewId: _reviewId, reviewCommentId: _reviewCommentId, ...completion } = storedRun.completion!;
  f.store.putRun({ ...storedRun, completion });
  f.store.deleteMeta(`reviewPublication:${run.id}`);
  const task = f.store.task(f.task.id);
  const completed = f.store.eventsAll(task.id).find(event => event.kind === 'run_completion' && event.detail === `${run.role}: ${completion.summary}`)!;
  const createdAt = new Date(Date.parse(completed.at) + 1000).toISOString();
  const incident = { id: 'apply-incident', role: 'reviewer' as const, runId: run.id, fingerprint: 'a'.repeat(64), attempt: 0,
    cause: 'workspace_state', detail: 'Review application interrupted', action: '' as const, status: 'resolved' as const,
    createdAt, updatedAt: createdAt };
  f.store.update(task.id, { phase: 'reviewing', reason: 'Review application interrupted', resolution: {
    ...task.resolution, currentRunId: run.id, review: null, reviews: task.resolution.reviews.filter(review => review.runId !== run.id),
    attention: true, incident, recoveryActive: false,
    recovery: { id: 'apply-recovery', key: incident.fingerprint, generation: 1, runId: null, agentId: null,
      status: 'resolved', summary: 'Recovery action did not settle the review', idleSince: null, incidentId: incident.id },
    stop: { reason: 'operator_needed', detail: 'Review application interrupted', since: new Date(Date.parse(createdAt) + 1000).toISOString(), suggestedVerbs: ['move'] },
  } }, 'test_review_application_lost');
  f.store.db.prepare("DELETE FROM events WHERE taskId=? AND kind IN ('review_result_applied','review_reapplied','run_result_applied') AND detail=?").run(task.id, run.id);
  return { f, run, incident };
}

test('ordinary public changes-required lifecycle retains the reader with a new exact-head credential, delta and clean author return', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current(); assert.ok(first);
    await f.report(first, 'changes_required');
    // Let the ordinary author continuation reserve its authenticated revision.
    await f.engine.wake(); const revision = f.current(); assert.ok(revision, f.store.task(f.task.id).reason); assert.equal(revision.role, 'revision', f.store.task(f.task.id).reason);
    const head = f.pushRevision();
    f.idle(revision);
    const response = await new Reports(f.engine).report({ taskId: f.task.id, runId: revision.id, eventId: randomUUID(), status: 'ready_for_review', summary: 'Fixed feature', prNumber: 41, head }, f.tokens.get(revision.id)!);
    assert.equal((response as {accepted:boolean}).accepted, true);
    await f.engine.wake(); await f.engine.wake(); await f.engine.wake();
    const second = f.current(); assert.equal(second.role, 'reviewer', f.store.task(f.task.id).reason);
    assert.equal(second.agentId, first.agentId, JSON.stringify(f.store.eventsAll(f.task.id).filter(e => e.kind.includes('reviewer_')))); assert.equal(second.workspaceId, first.workspaceId);
    assert.notEqual(second.id, first.id); assert.notEqual(f.tokens.get(second.id), f.tokens.get(first.id));
    assert.equal(second.priorRunId, first.id); assert.equal(second.priorHead, first.head); assert.equal(second.head, head);
    assert.match(second.reviewDelta!, /Earlier finding: fix feature/); assert.match(second.reviewDelta!, /revision/);
    assert.doesNotMatch(second.reviewDelta!, /owner revised source/);
    assert.doesNotMatch(second.reviewDelta!, /^diff --git /m); assert.doesNotMatch(second.reviewDelta!, /^@@ /m);
    assert.equal(runGit(f.workspace, 'branch', '--show-current'), '');
    assert.match(runPrompt(f.store.task(f.task.id), second, '/helper', '/ticket', true), /Judge the delta/);
    const sentCount = f.sends.length;
    await f.restart(); assert.equal(f.current().id, second.id); assert.equal(f.sends.length, sentCount);
    await f.report(second, 'changes_required');
    assert.equal(runGit(f.workspace, 'branch', '--show-current'), 'feature/external');
    assert.equal(runGit(f.workspace, 'rev-parse', 'HEAD'), head);
    assert.equal(f.store.run(first.id)!.completion!.head, first.head);
  } finally { f.close(); }
});

test('a released authenticated review with a lost application is reapplied once at its exact head', async () => {
  const f = fixture();
  try {
    await f.engine.wake();
    const run = f.current();
    await f.report(run, 'ready_to_merge');
    assert.equal(f.store.task(f.task.id).resolution.review?.runId, run.id);
    assert.equal(f.store.eventsAll(f.task.id).filter(event => event.kind === 'review_result_applied' && event.detail === run.id).length, 1);

    // Recreate the persisted state left by an application race: the accepted
    // callback and released run remain, but the task-side application did not.
    const task = f.store.task(f.task.id);
    assert.equal(task.resolution.reviewerAgentId, run.agentId, 'the task still retains this reviewer');
    const storedRun = f.store.run(run.id)!;
    const { reviewId: _publishedReviewId, reviewCommentId: _publishedCommentId, ...unpublishedCompletion } = storedRun.completion!;
    f.store.putRun({ ...storedRun, completion: unpublishedCompletion });
    f.store.deleteMeta(`reviewPublication:${run.id}`);
    assert.equal(f.store.run(run.id)!.completion!.reviewId, undefined);
    assert.equal(f.store.run(run.id)!.completion!.reviewCommentId, undefined);
    assert.equal(f.store.getMeta(`reviewPublication:${run.id}`), undefined);
    const receipt = f.store.db.prepare('SELECT hash,response FROM receipts WHERE id=? AND task=? AND run=?')
      .get(unpublishedCompletion.eventId, task.id, run.id) as { hash: string; response: string } | undefined;
    assert.equal(receipt?.hash, digest(JSON.stringify(unpublishedCompletion)), 'the re-applied result retains its authentic accepted receipt');
    assert.equal(JSON.parse(receipt!.response).accepted, true);
    f.store.update(task.id, { phase: 'reviewing', reason: 'Review application was interrupted',
      resolution: { ...task.resolution, currentRunId: null, review: null,
        reviews: task.resolution.reviews.filter(review => review.runId !== run.id) } }, 'test_review_application_lost');
    f.store.db.prepare("DELETE FROM events WHERE taskId=? AND kind IN ('review_result_applied','review_reapplied','run_result_applied') AND detail=?")
      .run(task.id, run.id);

    await f.engine.wake();
    let applied = f.store.task(task.id);
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'review_reapplied' && event.detail === run.id).length, 1,
      'the exact released reviewer result is applied once');
    const publication = f.store.getMeta<{ commentId?: number; reviewId?: number }>(`reviewPublication:${run.id}`);
    assert.equal(f.reviewPublications, 2, 'the unpublished authenticated result is published during re-application');
    assert.ok(publication?.commentId === 101 || publication?.reviewId === 101, 're-application retains the publication receipt');
    assert.equal(applied.resolution.review?.runId, run.id, 'the exact stored review is bound after publication');
    await f.engine.wake();
    applied = f.store.task(task.id);
    assert.equal(applied.resolution.currentRunId, null);
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'review_reapplied' && event.detail === run.id).length, 1);
  } finally { f.close(); }
});

test('a published verdict survives transient application failures and settles its incident on retry', async () => {
  const f = fixture();
  try {
    await f.engine.wake();
    const run = f.current();
    await f.report(run, 'ready_to_merge');
    const task = f.store.task(f.task.id), publication = f.store.eventsAll(task.id).find(event => event.kind === 'review_published')!;
    assert.ok(publication);
    const storedRun = f.store.run(run.id)!;
    f.store.update(task.id, { phase: 'needs_attention', reason: 'Command failed: git status --porcelain --untracked-files=all',
      resolution: { ...task.resolution, currentRunId: run.id, review: null,
        reviews: task.resolution.reviews.filter(review => review.runId !== run.id), attention: true,
        incident: { id: 'apply-fault', role: 'reviewer', runId: run.id, fingerprint: 'apply-fault', attempt: 0,
          cause: 'workspace', detail: 'Command failed: git status --porcelain --untracked-files=all', action: '', status: 'escalated',
          createdAt: new Date(Date.parse(publication.at) + 1000).toISOString(), updatedAt: new Date().toISOString() },
        recovery: { id: 'apply-recovery', key: 'apply-fault', generation: 1, runId: null, agentId: null,
          status: 'escalated', summary: 'Review application interrupted', idleSince: null, incidentId: 'apply-fault' },
        recoveryActive: false, mergeIntent: false, integrationTurn: null,
        stop: { reason: 'operator_needed', detail: 'Review application interrupted',
          since: new Date().toISOString(), suggestedVerbs: ['move'] } } }, 'test_application_interrupted');
    f.store.db.prepare("DELETE FROM events WHERE taskId=? AND kind IN ('review_result_applied','review_reapplied','run_result_applied') AND detail=?").run(task.id, run.id);
    let attempts = 0;
    f.adapter.verifyReview = async () => { attempts++; throw Error('Command failed: git status --porcelain --untracked-files=all'); };
    const recoveriesBefore = f.store.runs(task.id).filter(item => item.role === 'recovery').length;
    await f.engine.wake(); await f.engine.wake();
    assert.equal(attempts, 2, 'the persisted application retries while the transient failure remains');
    assert.equal(f.store.task(task.id).resolution.attention, true);
    assert.equal(f.store.runs(task.id).filter(item => item.role === 'recovery').length, recoveriesBefore,
      'retries reuse the existing attention episode instead of opening another coordinator');
    f.adapter.verifyReview = async () => { attempts++; };
    await f.engine.wake();
    const applied = f.store.task(task.id);
    assert.equal(applied.resolution.review?.runId, run.id);
    assert.ok(['verifying', 'merging', 'closing'].includes(applied.phase), 'the task advances past review');
    assert.equal(applied.resolution.attention, false);
    assert.notEqual(applied.resolution.stop?.reason, 'operator_needed');
    assert.equal(applied.resolution.incident?.status, 'resolved');
    assert.equal(applied.resolution.recovery?.status, 'resolved');
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'review_result_applied' && event.detail === run.id).length, 1);
    await f.engine.wake();
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'review_result_applied' && event.detail === run.id).length, 1);
    assert.ok(storedRun.released);
  } finally { f.close(); }
});

test('move to review applies a released pending verdict instead of accepting a no-op', async () => {
  const f = fixture();
  try {
    await f.engine.wake();
    const run = f.current();
    await f.report(run, 'ready_to_merge');
    const task = f.store.task(f.task.id);
    f.store.update(task.id, { phase: 'reviewing', reason: 'Review application was interrupted',
      resolution: { ...task.resolution, currentRunId: null, review: null,
        reviews: task.resolution.reviews.filter(review => review.runId !== run.id), mergeIntent: false,
        integrationTurn: null } }, 'test_review_application_lost');
    f.store.db.prepare("DELETE FROM events WHERE taskId=? AND kind IN ('review_result_applied','review_reapplied','run_result_applied') AND detail=?").run(task.id, run.id);
    const result = await f.engine.performTaskControl({ taskId: task.id, version: f.store.task(task.id).version,
      action: 'move', to: 'review', reason: 'Resume the outstanding accepted verdict' });
    assert.equal(result.resolution.review?.runId, run.id);
    assert.equal(result.phase, 'verifying');
    assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'review_result_applied' && event.detail === run.id).length, 1);
  } finally { f.close(); }
});

test('a changed PR head or fresh reviewer binding keeps the released verdict from reapplying', async () => {
  const pending = async () => {
    const f = fixture();
    await f.engine.wake();
    const run = f.current();
    await f.report(run, 'ready_to_merge');
    const task = f.store.task(f.task.id);
    f.store.update(task.id, { phase: 'reviewing', reason: 'Review application remains pending',
      resolution: { ...task.resolution, currentRunId: null, review: null,
        reviews: task.resolution.reviews.filter(review => review.runId !== run.id), integrationTurn: null, mergeIntent: false } }, 'test_review_application_pending');
    f.store.db.prepare("DELETE FROM events WHERE taskId=? AND kind IN ('review_result_applied','review_reapplied','run_result_applied') AND detail=?").run(task.id, run.id);
    return { f, run };
  };

  const changedHead = await pending();
  try {
    const task = changedHead.f.store.task(changedHead.f.task.id);
    changedHead.f.store.update(task.id, { prHead: 'b'.repeat(40) }, 'test_review_head_changed');
    assert.equal(await changedHead.f.engine.resolution.reapplyPendingReview(changedHead.f.store.task(task.id)), 'none');
    assert.equal(changedHead.f.store.eventsAll(task.id).some(event => event.kind === 'review_result_applied'
      && event.detail === changedHead.run.id), false);
  } finally { changedHead.f.close(); }

  const freshReviewer = await pending();
  try {
    const task = freshReviewer.f.store.task(freshReviewer.f.task.id);
    freshReviewer.f.store.update(task.id, { resolution: { ...task.resolution,
      reviewerAgentId: 'fresh-reviewer', reviewerProfile: null } }, 'test_fresh_reviewer_transition');
    assert.equal(await freshReviewer.f.engine.resolution.reapplyPendingReview(freshReviewer.f.store.task(task.id)), 'none');
    assert.equal(freshReviewer.f.store.eventsAll(task.id).some(event => event.kind === 'review_result_applied'
      && event.detail === freshReviewer.run.id), false);
  } finally { freshReviewer.f.close(); }
});

test('retained verdicts replay after settled or refused recovery and only their own planner escalation', async () => {
  for (const scenario of [
    { name: 'resolved incident', status: 'ready_to_merge' as const },
    { name: 'refused coordinator action', status: 'ready_to_merge' as const, refused: true },
    { name: 'escalated incident with blocked recovery', status: 'ready_to_merge' as const, escalated: true },
    { name: 'changes-required verdict', status: 'changes_required' as const },
  ]) {
    const { f, run, incident } = await pendingVerdict(scenario.status);
    try {
      const task = f.store.task(f.task.id);
      const action = scenario.refused ? { eventId: 'coordinator-report', runId: 'coordinator-run',
        reportStatus: 'recovered' as const, summary: 'Recovered', status: 'refused' as const,
        reason: 'The coordinator action was refused' } : null;
      const currentIncident = { ...incident, status: scenario.escalated ? 'escalated' as const : incident.status };
      f.store.update(task.id, { resolution: { ...task.resolution, incident: currentIncident, recovery: {
        ...task.resolution.recovery!, status: scenario.escalated ? 'uncertain' : 'resolved', action,
      } } }, 'test_recovery_settled_or_refused');
      if (scenario.escalated) {
        const escalationId = 'same-incident-escalation';
        f.store.event(task.id, 'planner_escalation', `${escalationId}: cause ${incident.fingerprint}; run worker; question ${'b'.repeat(64)} (12 chars); options Continue | Hold`);
      }
      const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(task.id)));
      assert.equal(next.verbs.some(verb => verb.verb === 'retry_effect' && verb.available), false,
        'an absent publication intent is replayable by lifecycle, not a retry_effect call that refuses');
      const replay = await f.engine.resolution.reapplyPendingReview(f.store.task(task.id));
      assert.equal(replay, 'applied', `${scenario.name}: ${JSON.stringify({ phase: task.phase,
        reviewerAgentId: task.resolution.reviewerAgentId, currentRunId: task.resolution.currentRunId,
        incident, laterReviewers: f.store.runs(task.id).filter(item => item.role === 'reviewer').map(item => item.id) })}`);
      const applied = f.store.task(task.id);
      assert.equal(applied.resolution.review?.runId, run.id, scenario.name);
      assert.equal(applied.resolution.attention, false, scenario.name);
      assert.notEqual(applied.resolution.stop?.reason, 'operator_needed', scenario.name);
      assert.equal(applied.resolution.recovery?.status, 'resolved', scenario.name);
      assert.equal(f.store.eventsAll(task.id).filter(event => event.kind === 'review_reapplied' && event.detail === run.id).length, 1, scenario.name);
      assert.equal(f.reviewPublications, 2, `${scenario.name}: the missing publication is sent once during replay`);
    } finally { f.close(); }
  }
});

test('uncertain publication, owner stop, later reviewer and unrelated planner escalation keep verdict parked', async () => {
  const uncertain = await pendingVerdict();
  try {
    uncertain.f.store.setMeta(`reviewPublication:${uncertain.run.id}`, { hash: 'uncertain-without-id' });
    assert.equal(await uncertain.f.engine.resolution.reapplyPendingReview(uncertain.f.store.task(uncertain.f.task.id)), 'blocked');
  } finally { uncertain.f.close(); }

  const ownerStopped = await pendingVerdict();
  try {
    ownerStopped.f.store.event(ownerStopped.f.task.id, 'owner_stopped', 'reviewer run was stopped by owner');
    assert.equal(await ownerStopped.f.engine.resolution.reapplyPendingReview(ownerStopped.f.store.task(ownerStopped.f.task.id)), 'blocked');
  } finally { ownerStopped.f.close(); }

  const laterReviewer = await pendingVerdict();
  try {
    const later = { ...laterReviewer.f.store.run(laterReviewer.run.id)!, id: 'later-reviewer-run', createdAt: new Date().toISOString() };
    laterReviewer.f.store.putRun(later);
    assert.equal(await laterReviewer.f.engine.resolution.reapplyPendingReview(laterReviewer.f.store.task(laterReviewer.f.task.id)), 'none');
  } finally { laterReviewer.f.close(); }

  const otherEscalation = await pendingVerdict();
  try {
    const id = 'unrelated-planner-escalation';
    otherEscalation.f.store.event(otherEscalation.f.task.id, 'planner_escalation', `${id}: cause ${'c'.repeat(64)}; run worker; question ${'d'.repeat(64)} (12 chars); options Continue | Hold`);
    assert.equal(await otherEscalation.f.engine.resolution.reapplyPendingReview(otherEscalation.f.store.task(otherEscalation.f.task.id)), 'blocked');
  } finally { otherEscalation.f.close(); }
});

test('a superseded uncertain publication merges through its ordinary turn; the other uncertain shapes still block', async () => {
  // The live shape (task 666): run A's publication intent stayed uncertain with
  // no positive publication ID, the owner restarted the reviewer, and the later
  // run applied its own published verdict at the same head. The merge turn must
  // not wait for A, `next` must not offer a retry that would refuse, and A must
  // never be republished.
  const superseded = await pendingVerdict('ready_to_merge');
  try {
    const { f, run } = superseded;
    // The fixture's forge stays uncertain after its no-op merge; complete the
    // merge with the real fast-forward the ordinary turn asks the forge for.
    f.adapter.merged = async t => {
      const current = f.store.task(t.id);
      if (!current.resolution.mergeHead) return { merged: false, commit: null, head: f.state.prSha, base: current.baseBranch };
      runGit(f.repo, 'fetch', 'origin', 'feature/external');
      runGit(f.repo, 'merge', '--ff-only', 'origin/feature/external');
      return { merged: true, head: current.resolution.mergeHead, base: current.baseBranch, commit: runGit(f.repo, 'rev-parse', 'HEAD') };
    };
    f.adapter.syncMain = async () => f.planningCommit;
    f.store.setMeta(`reviewPublication:${run.id}`, { hash: 'a'.repeat(64) });
    const task = f.store.task(f.task.id);
    const earlier = f.store.run(run.id)!;
    const laterCompletion = { ...earlier.completion!, eventId: 'later-review-event', runId: 'later-review-run', reviewId: 101 };
    const later: Run = { ...earlier, id: 'later-review-run',
      createdAt: new Date(Date.parse(earlier.createdAt) + 60000).toISOString(), completion: laterCompletion };
    f.store.putRun(later);
    f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(laterCompletion.eventId, task.id, later.id,
      digest(JSON.stringify(laterCompletion)), JSON.stringify({ accepted: true, eventId: laterCompletion.eventId }));
    f.store.setMeta(`reviewPublication:${later.id}`,
      { hash: digest(reviewPublicationBody(task, later, 'ready_to_merge', laterCompletion.reviewText!, laterCompletion.verdicts ?? [])), reviewId: 101 });
    f.store.event(task.id, 'review_result_applied', later.id);
    f.store.update(task.id, { phase: 'verifying', reason: 'Source examined', resolution: {
      ...task.resolution, currentRunId: null, review: laterCompletion, attention: false, stop: null } }, 'test_later_review_applied');

    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(task.id)));
    assert.equal(next.verbs.some(verb => verb.verb === 'retry_effect'
      && (verb.args as { effect?: string } | undefined)?.effect === `review_publication.${run.id}`), false,
      'a superseded publication is not an offered retry');
    assert.equal(next.verbs.some(verb => verb.verb === 'retry_effect' && verb.available), false,
      'the superseded shape leaves no owner-retryable effect at all');

    for (let i = 0; i < 12; i++) {
      await f.engine.wake();
      if (f.store.task(task.id).resolution.mergedCommit) break;
    }
    const merged = f.store.task(task.id);
    assert.ok(merged.resolution.mergedCommit, JSON.stringify({ phase: merged.phase, reason: merged.reason }));
    assert.equal(merged.resolution.review?.runId, later.id, 'the later applied verdict is the merge evidence');
    assert.equal(f.reviewPublications, 1, 'the superseded publication is never republished');
    assert.deepEqual(blockingRecoveryEffects(f.store, merged, { kinds: ['publication'] }), []);
  } finally { superseded.f.close(); }

  // Without a later applied verdict the uncertain publication keeps blocking:
  // the projection still names it and `next` keeps offering the owner retry
  // that can actually act on it (the #658 rule).
  const parked = await pendingVerdict('ready_to_merge');
  try {
    const { f, run } = parked;
    f.store.setMeta(`reviewPublication:${run.id}`, { hash: 'a'.repeat(64) });
    // The live row never reached merge intent (the gate fenced before intent);
    // the fixture's rewind leaves the report-time attempt behind, so clear it.
    const task = f.store.task(f.task.id);
    f.store.update(task.id, { resolution: { ...task.resolution, mergeIntent: false, mergeHead: null,
      integrationTurn: null } }, 'test_live_shape');
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(task.id)));
    const offer = next.verbs.find(verb => verb.verb === 'retry_effect'
      && (verb.args as { effect?: string } | undefined)?.effect === `review_publication.${run.id}`);
    assert.ok(offer, JSON.stringify(next.verbs.map(verb => [verb.verb, verb.available, verb.refusal ?? null])));
    assert.equal(offer!.available, true, 'the uncertain publication stays an owner-retryable effect');
    const blocking = blockingRecoveryEffects(f.store, task, { kinds: ['publication'], runId: run.id });
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0]!.state, 'uncertain');
  } finally { parked.f.close(); }
});

test('ordinary review custody ignores its concurrent dispatch hold and waiting writes during the final proof', async () => {
  const f = fixture();
  try {
    await f.engine.wake();
    const run = f.current();
    let bumped = false;
    f.state.onObserve = agentId => {
      if (agentId !== run.agentId || bumped) return;
      bumped = true;
      const task = f.store.task(f.task.id);
      f.store.update(task.id, { held: true, holdGeneration: 1, holds: { dispatch: {
        owner: 'operator', reason: 'Planner dispatch fence', at: new Date().toISOString(), generation: 1, until: null,
      } } });
      f.engine.resolution.waiting(f.store.task(task.id), 'Dispatch held; release to continue', 'held');
    };

    await f.report(run, 'ready_to_merge');
    assert.equal(bumped, true, 'the dispatch hold and task_waiting record landed during custody proof');
    assert.equal(f.store.task(f.task.id).resolution.review?.runId, run.id);
    assert.equal(f.store.eventsAll(f.task.id).filter(event => event.kind === 'review_result_applied' && event.detail === run.id).length, 1);
    assert.equal(f.store.task(f.task.id).resolution.attention, false);
  } finally { f.close(); }
});

test('ordinary review custody still refuses a concurrent PR head change', async () => {
  const f = fixture();
  try {
    await f.engine.wake();
    const first = f.current();
    await f.report(first, 'changes_required');
    await f.engine.wake();
    const revision = f.current();
    const head = f.pushRevision();
    f.idle(revision);
    const response = await new Reports(f.engine).report({ taskId: f.task.id, runId: revision.id, eventId: randomUUID(),
      status: 'ready_for_review', summary: 'Fixed feature', prNumber: 41, head }, f.tokens.get(revision.id)!);
    assert.equal((response as {accepted:boolean}).accepted, true);
    await f.engine.wake(); await f.engine.wake(); await f.engine.wake();
    const run = f.current();
    assert.equal(run.ordinaryDetached, true);
    f.store.update(f.task.id, { prHead: f.planningCommit });

    await f.report(run, 'ready_to_merge');
    assert.equal(f.store.task(f.task.id).resolution.review?.runId, undefined,
      'the stored review is not bound to a different PR head');
    assert.equal(f.store.eventsAll(f.task.id).some(event => event.kind === 'review_result_applied' && event.detail === run.id), false);
  } finally { f.close(); }
});

test('an ordinary review blocked by a late durable effect waits with its identity and does not start recovery', async () => {
  const f=fixture();
  try {
    await f.engine.wake(); const first=f.current();
    await f.report(first,'changes_required');
    await f.engine.wake(); const revision=f.current();
    const head=f.pushRevision(); f.idle(revision); f.faults.blockOrdinarySend=true;
    const response=await new Reports(f.engine).report({taskId:f.task.id,runId:revision.id,eventId:randomUUID(),status:'ready_for_review',
      summary:'Fixed feature',prNumber:41,head},f.tokens.get(revision.id)!);
    assert.equal((response as {accepted:boolean}).accepted,true);
    await f.engine.wake(); await f.engine.wake();
    const task=f.store.task(f.task.id);
    assert.match(task.reason,/attention-notice attention-race is uncertain/);
    assert.equal(task.resolution.recoveryActive,false);
    assert.equal(task.resolution.currentRunId,null);
    assert.equal(f.store.runs(task.id).filter(run=>!run.released).length,0);
    const runCount = f.store.runs(task.id).length;
    for (let i = 0; i < 3; i++) await f.engine.wake();
    assert.equal(f.store.runs(task.id).length, runCount, 'unchanged effect does not create more reviewer runs');
  } finally { f.close(); }
});

test('ordinary source approval parks once without a coordinator and duplicate reports preserve the receipt', async () => {
  const f = fixture();
  try {
    const project = f.store.ensureProject(f.repo, 'example/repo');
    f.store.setProjectPlanner({ key: project.key, agentId: f.owner, setBy: 'test', note: 'Fixture project planner' });
    await f.engine.wake(); const run = f.current();
    await f.report(run, 'blocked', { reviewResponsibility: 'environment', sourceApproved: true, awaitingProofs: [{ proof: 'native-proof', route: 'external' }] });
    for (let n = 0; n < 3; n++) await f.engine.wake();
    const task = f.store.task(f.task.id);
    assert.equal(task.resolution.stop?.reason, 'awaiting_proof', task.reason);
    assert.equal(task.resolution.review?.sourceApproved, true);
    assert.equal(f.store.runs(task.id).length, 1);
    assert.equal(f.store.notices(task.id).filter(n => n.kind === 'attention').length, 1);
    assert.equal(f.store.notices(task.id).find(n => n.kind === 'attention')!.recipientAgentId, f.owner);
    assert.equal(task.resolution.currentRunId, null);
  } finally { f.close(); }
});

test('a passed declared proof settles a prose proof wait, while failed and other-head proofs do not', async () => {
  const f = fixture();
  try {
    const selector = 'native-proof';
    f.store.update(f.task.id, { proofExecution: { selector, inputs: [], role: 'author' } });
    await f.engine.wake(); const reviewer = f.current();
    await f.report(reviewer, 'blocked', { reviewResponsibility: 'environment', sourceApproved: true,
      awaitingProofs: [{ proof: selector, route: 'external' }] });
    for (let n = 0; n < 3; n++) await f.engine.wake();
    const approved = f.store.task(f.task.id);
    f.store.update(f.task.id, { resolution: { ...approved.resolution,
      review: { ...approved.resolution.review!, awaitingProofs: [{ proof: 'Run native-proof once at the approved head using the Queue proof route', route: 'external' }] } } });
    const makeProof = (id: string, head: string, status: 'passed' | 'failed') => {
      const runId = `proof-${id}`;
      const createdAt = new Date(Date.parse(reviewer.createdAt) + 1000).toISOString();
      const completion = { eventId: `event-${id}`, taskId: f.task.id, runId, status: 'proof_executed' as const,
        summary: `Proof ${status}`, head, prNumber: 41,
        proofResult: { selector, status, exitCode: status === 'passed' ? 0 : 1, evidence: 'proof receipt' } };
      f.store.putRun({ ...reviewer, id: runId, role: 'executor', generation: reviewer.generation + 1,
        agentId: `proof-agent-${id}`, head, createdAt, status: 'finished', released: true, completion } as Run);
      const brief = currentBrief(approved);
      const receipt = { runId, agentId: `proof-agent-${id}`, workspaceId: reviewer.workspaceId, profile: reviewer.profile,
        operationId: null, selector, inputs: [], repository: approved.repository, prNumber: 41, branch: approved.branch,
        head, briefVersion: brief?.version ?? null, briefDigest: brief?.digest ?? null,
        authorizedBy: { role: 'project_owner' as const, caller: null, note: null }, activatedAt: createdAt,
        settledAt: new Date(Date.parse(createdAt) + 1000).toISOString(), status, historical: false, exitCode: status === 'passed' ? 0 : 1, evidence: 'proof receipt' };
      f.store.update(f.task.id, { proofExecutions: [...f.store.task(f.task.id).proofExecutions, receipt] });
    };

    makeProof('failed', reviewer.head, 'failed');
    makeProof('old-head', f.planningCommit, 'passed');
    await f.engine.wake();
    assert.equal(f.store.task(f.task.id).resolution.stop?.reason, 'awaiting_proof');
    assert.equal(f.store.task(f.task.id).resolution.currentRunId, null);

    makeProof('passed', reviewer.head, 'passed');
    await f.engine.wake(); await f.engine.wake();
    const task = f.store.task(f.task.id);
    const evidenceTurn = f.current();
    assert.notEqual(task.resolution.stop?.reason, 'awaiting_proof', task.reason);
    assert.ok(evidenceTurn && evidenceTurn.role === 'reviewer', task.reason);
    assert.equal(evidenceTurn.proofOnly, true);
    assert.match(evidenceTurn.reviewDelta ?? '', /Judge only arriving proof evidence/);
    assert.equal(evidenceTurn.head, reviewer.head);
    assert.equal(task.resolution.currentRunId, evidenceTurn.id);
    assert.ok(f.store.eventsAll(task.id).some(event => event.kind === 'proof_review_ready'));
  } finally { f.close(); }
});

test('a review prompt of any delta size carries references and never diff text', async () => {
  const f = fixture();
  try {
    const prior = { id: 'prior', head: f.oldHead, base: f.planningCommit,
      completion: { summary: 'Read source', reviewText: 'Earlier finding: keep the API shape' } } as Run;
    const referenceForm = (delta: string, head: string, priorHead = prior.head) => {
      assert.ok(delta.length < REVIEW_PROMPT_INLINE_BUDGET, `reference prompt is ${delta.length} characters`);
      assert.match(delta, /Diff stat:/);
      assert.match(delta, /Changed files:/);
      assert.ok(delta.includes(priorHead) && delta.includes(head), 'the exact prior and new SHAs travel');
      assert.match(delta, /git diff --no-ext-diff --no-color/);
      assert.match(delta, /git range-diff --no-color/);
      assert.match(delta, /Earlier finding: keep the API shape/);
      assert.doesNotMatch(delta, /Range-diff:\n/);
      assert.doesNotMatch(delta, /Delta:\n/);
      assert.doesNotMatch(delta, /^diff --git /m);
      assert.doesNotMatch(delta, /^@@ /m);
      assert.doesNotMatch(delta, /^\\+\\+\\+ /m);
    };
    // A small ordinary delta: the same reference form as a huge one.
    writeFileSync(join(f.workspace, 'feature.txt'), 'small delta\n'); runGit(f.workspace, 'add', '.'); runGit(f.workspace, 'commit', '-m', 'small delta');
    const smallHead = runGit(f.workspace, 'rev-parse', 'HEAD');
    const small = await ordinaryReviewDelta(f.store.task(f.task.id), prior, smallHead, f.planningCommit);
    referenceForm(small, smallHead);
    assert.match(small, /feature\.txt/);
    // Change part of the generated blob while keeping the patch similar enough
    // for range-diff to pair the commits; its patch-of-patches exceeds 1 MiB.
    const generatedPath = join(f.workspace, 'big.txt');
    const generated = (change: boolean) => `${Array.from({ length: 2200 }, (_, line) => `${String(line).padStart(4, '0')}-${(change && line >= 1500 ? 'y' : 'x').repeat(1024)}`).join('\n')}\n`;
    writeFileSync(generatedPath, generated(false));
    runGit(f.workspace, 'add', 'big.txt'); runGit(f.workspace, 'commit', '-m', 'regenerate bindings');
    const priorGeneratedHead = runGit(f.workspace, 'rev-parse', 'HEAD');
    writeFileSync(generatedPath, generated(true));
    runGit(f.workspace, 'add', 'big.txt'); runGit(f.workspace, 'commit', '--amend', '--no-edit');
    const generatedHead = runGit(f.workspace, 'rev-parse', 'HEAD');
    const rangeDiff = execFileSync('git', ['-C', f.workspace, 'range-diff', '--no-color',
      `${f.planningCommit}..${priorGeneratedHead}`, `${f.planningCommit}..${generatedHead}`],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.ok(Buffer.byteLength(rangeDiff) > 1024 * 1024,
      `the fixture range-diff exceeds the old child buffer (${Buffer.byteLength(rangeDiff)} bytes)`);
    const generatedPrior = { ...prior, head: priorGeneratedHead };
    const big = await ordinaryReviewDelta(f.store.task(f.task.id), generatedPrior, generatedHead, f.planningCommit);
    referenceForm(big, generatedHead, priorGeneratedHead);
    assert.match(big, /big\.txt/);
    assert.doesNotMatch(big, /Pure rebase confirmation/, 'the changed generated patch is not a pure rebase');
    assert.ok(!big.includes('x'.repeat(256)) && !big.includes('y'.repeat(256)), 'no generated content travels in the prompt');
  } finally { f.close(); }
});

test('ordinary checkout refuses dirty source and detects a pure rebase from actual range-diff', async () => {
  const f = fixture();
  try {
    const prior = { id: 'prior', head: f.oldHead, base: f.planningCommit, completion: { summary: 'Read source' } } as Run;
    await ordinaryReviewSource(f.store.task(f.task.id), f.oldHead, false);
    writeFileSync(join(f.repo, 'base-change.txt'), 'base movement\n'); runGit(f.repo, 'add', '.'); runGit(f.repo, 'commit', '-m', 'move base');
    const base = runGit(f.repo, 'rev-parse', 'HEAD');
    runGit(f.workspace, 'rebase', 'main'); const head = runGit(f.workspace, 'rev-parse', 'HEAD');
    assert.match(await ordinaryReviewDelta(f.store.task(f.task.id), prior, head, base), /Pure rebase confirmation/);
    writeFileSync(join(f.workspace, 'feature.txt'), 'dirty');
    await assert.rejects(() => ordinaryReviewSource(f.store.task(f.task.id), head, false), /dirty/);
  } finally { f.close(); }
});


test('an owner-activated same-head executor settlement starts exactly one proof-only round with no source credit minted', async () => {
  const f = fixture();
  try {
    f.store.update(f.task.id, { proofExecution: { selector: 'native-proof', inputs: [], role: 'author' } });
    await f.engine.wake(); const first = f.current();
    await f.report(first, 'blocked', { reviewResponsibility: 'environment', sourceApproved: true,
      awaitingProofs: [{ proof: 'Run native-proof once at the approved head via the Queue proof route', route: 'external' }] });
    await f.restart();
    await f.engine.performTaskControl({ taskId: f.task.id, version: f.store.task(f.task.id).version, action: 'proof', reason: 'Run the declared proof', caller: 'owner', relayed: true, note: 'Operator authorizes the one declared proof' });
    await f.engine.wake(); const executor = f.current(); assert.equal(executor.role, 'executor', f.store.task(f.task.id).reason);
    f.idle(executor);
    const result = await new Reports(f.engine).report({ taskId: f.task.id, runId: executor.id, eventId: randomUUID(), head: executor.head,
      status: 'proof_executed', summary: 'Declared proof passed', proofResult: { selector: 'native-proof', status: 'passed', exitCode: 0, evidence: 'Isolated proof evidence' } }, f.tokens.get(executor.id)!);
    assert.equal((result as {accepted:boolean}).accepted, true);
    await f.engine.wake(); await f.engine.wake(); await f.engine.wake();
    const review = f.current(); assert.ok(review, JSON.stringify({ reason: f.store.task(f.task.id).reason, proofs: f.store.task(f.task.id).proofExecutions, runs: f.store.runs(f.task.id).map(r => [r.role, r.released, r.status]), events:f.store.eventsAll(f.task.id).slice(-8) }));
    assert.equal(review.role, 'reviewer'); assert.equal(review.proofOnly, true); assert.equal(review.head, first.head);
    assert.equal(review.agentId, first.agentId); assert.notEqual(review.id, first.id);
    assert.equal(f.store.task(f.task.id).resolution.review?.sourceApproved, true);
    assert.notEqual(f.store.task(f.task.id).resolution.stop?.reason, 'awaiting_proof');
    const count = f.store.runs(f.task.id).length;
    await Promise.all([f.engine.wake(), f.engine.wake()]);
    assert.equal(f.store.runs(f.task.id).length, count);
    assert.equal(f.store.task(f.task.id).resolution.mergedCommit, null);
    await f.report(review, 'changes_required');
    assert.equal(f.store.task(f.task.id).resolution.review?.status, 'changes_required');
    assert.equal(f.store.run(first.id)!.completion!.sourceApproved, true);
  } finally { f.close(); }
});

test('a failed settled author proof returns the responsible task to its retained worker with the receipt', async () => {
  const f = fixture();
  try {
    f.store.update(f.task.id, { proofExecution: { selector: 'native-proof', inputs: [], role: 'author' } });
    await f.engine.wake(); const reviewer = f.current();
    await f.report(reviewer, 'blocked', { reviewResponsibility: 'environment', sourceApproved: true,
      awaitingProofs: [{ proof: 'Run native-proof once at the approved head via the Queue proof route', route: 'external' }] });
    await f.restart();
    await f.engine.performTaskControl({ taskId: f.task.id, version: f.store.task(f.task.id).version, action: 'proof',
      reason: 'Run the declared proof', caller: 'owner', relayed: true, note: 'Operator authorizes the one declared proof' });
    await f.engine.wake(); const executor = f.current(); assert.equal(executor.role, 'executor');
    f.idle(executor);
    const result = await new Reports(f.engine).report({ taskId: f.task.id, runId: executor.id, eventId: randomUUID(), head: executor.head,
      status: 'proof_executed', summary: '4 cases failed', proofResult: { selector: 'native-proof', status: 'failed', exitCode: 1,
        evidence: 'case alpha failed; case beta failed' } }, f.tokens.get(executor.id)!);
    assert.equal((result as {accepted:boolean}).accepted, true);
    await f.engine.wake(); await f.engine.wake();
    const task = f.store.task(f.task.id);
    assert.equal(task.phase, 'changes_requested', task.reason);
    assert.equal(task.resolution.review?.sourceApproved, true, 'the retained review record stays bound');
    assert.notEqual(task.resolution.stop?.reason, 'awaiting_proof');
    const revision = f.current(); assert.ok(revision, task.reason); assert.equal(revision.role, 'revision');
    assert.match(revision.instruction!, /case alpha failed/);
    assert.match(revision.instruction!, /case beta failed/);
    assert.match(revision.instruction!, new RegExp(executor.id));
  } finally { f.close(); }
});

async function authorRevision(f: ReturnType<typeof fixture>, number: number) {
  await f.engine.wake(); const revision = f.current();
  assert.ok(revision, f.store.task(f.task.id).reason); assert.equal(revision.role, 'revision');
  const head = f.pushRevision(`revision ${number}`); f.idle(revision);
  const result = await new Reports(f.engine).report({ taskId: f.task.id, runId: revision.id, eventId: randomUUID(),
    status: 'ready_for_review', summary: `Fixed revision ${number}`, prNumber: 41, head }, f.tokens.get(revision.id)!);
  assert.equal((result as {accepted:boolean}).accepted, true);
  await f.engine.wake(); await f.engine.wake(); await f.engine.wake();
  return f.current();
}

test('the fourth consecutive retained round uses a fresh independent reviewer without resetting the author budget', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); let reviewer = f.current(); const original = reviewer.agentId;
    for (let n = 1; n <= 4; n++) {
      await f.report(reviewer, 'changes_required');
      reviewer = await authorRevision(f, n);
      assert.ok(reviewer, f.store.task(f.task.id).reason);
      assert.equal(reviewer.role, 'reviewer');
      if (n < 4) { assert.equal(reviewer.agentId, original); assert.equal(reviewer.retainedRounds, n); }
      else { assert.notEqual(reviewer.agentId, original); assert.equal(reviewer.retainedRounds, 0); }
    }
    assert.equal(f.store.task(f.task.id).resolution.revisionRuns, 4);
  } finally { f.close(); }
});

test('a closed reviewer falls back through the ordinary fresh factory and preserves the source history', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current(); await f.report(first, 'changes_required');
    f.states.set(first.agentId!, { ...f.states.get(first.agentId!)!, status: 'closed' });
    const review = await authorRevision(f, 1);
    assert.ok(review, f.store.task(f.task.id).reason);
    assert.notEqual(review.agentId, first.agentId); assert.equal(review.head, f.workspaceHead());
    assert.equal(f.store.run(first.id)!.head, f.oldHead);
  } finally { f.close(); }
});

test('an errored reviewer with no live turn falls back through the ordinary fresh factory and preserves the source history', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current(); await f.report(first, 'changes_required');
    // Queue #601: the provider wave left the finished reviewer's agent errored
    // with no active turn and no pending permission. It cannot write, so the
    // retained reviewer's next round must not wait on it — custody admits it
    // like a closed participant and the round goes fresh.
    f.states.set(first.agentId!, { ...f.states.get(first.agentId!)!, status: 'error', error: 'Connection error' });
    const review = await authorRevision(f, 1);
    assert.ok(review, f.store.task(f.task.id).reason);
    assert.notEqual(review.agentId, first.agentId); assert.equal(review.head, f.workspaceHead());
    assert.equal(f.store.run(first.id)!.head, f.oldHead);
  } finally { f.close(); }
});

for (const busy of ['permission', 'active turn', 'active flag'] as const) {
  test(`an errored reviewer holding a ${busy} still blocks the ordinary next round`, async () => {
    const f = fixture();
    try {
      await f.engine.wake(); const first = f.current(); await f.report(first, 'changes_required');
      // A dead session with nothing outstanding is inactive; one still holding
      // a turn or a permission question still owns the checkout.
      f.states.set(first.agentId!, { ...f.states.get(first.agentId!)!, status: 'error', error: 'Connection error',
        ...(busy === 'permission' ? { permissions: true } : busy === 'active turn' ? { activeTurnId: 'turn-live' } : { active: true }) });
      await authorRevision(f, 1);
      assert.equal(f.sends.filter(run => run.role === 'reviewer').length, 0, busy);
      assert.match(f.store.task(f.task.id).reason, /Ordinary review participant is not idle/, busy);
    } finally { f.close(); }
  });
}

test('a checkout dirtied during an awaited observation refuses the new round without stashing or sending', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current(); await f.report(first, 'changes_required');
    f.state.onObserve = () => {
      if (f.workspaceHead() !== f.oldHead) writeFileSync(join(f.workspace, 'feature.txt'), 'concurrent edits\n');
    };
    const review = await authorRevision(f, 1);
    assert.equal(f.sends.filter(run => run.role === 'reviewer').length, 0);
    assert.match(f.store.task(f.task.id).reason, /dirty|changed/);
    assert.equal(runGit(f.workspace, 'branch', '--show-current'), 'feature/external');
    assert.match(runGit(f.workspace, 'status', '--porcelain'), /feature.txt/);
    assert.equal(runGit(f.workspace, 'for-each-ref', 'refs/stash'), '');
    assert.ok(!review || review.status !== 'running');
  } finally { f.close(); }
});

test('head movement invalidates source approval and cannot turn arriving old-head evidence into merge credit', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current();
    await f.report(first, 'blocked', { reviewResponsibility: 'environment', sourceApproved: true, awaitingProofs: [{ proof: 'native-proof', route: 'external' }] });
    const head = f.pushRevision(); await f.engine.wake();
    const task = f.store.task(f.task.id);
    assert.equal(task.resolution.review, null);
    assert.equal(task.phase, 'changes_requested', 'the author must authenticate readiness at the moved head');
    assert.equal(task.resolution.currentRunId, f.current().id);
    assert.equal(f.current().role, 'revision', 'a stale-head reviewer must not launch');
    assert.equal(f.current().head, head, 'the author continuation is bound to the current PR head');
    assert.equal(f.store.run(first.id)!.completion!.head, f.oldHead);
    assert.notEqual(head, f.oldHead); assert.equal(task.resolution.mergedCommit, null);
  } finally { f.close(); }
});


test('a retained new-head round checkpoints and automatically continues the same run once before its genuine verdict', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current(); await f.report(first, 'changes_required');
    const second = await authorRevision(f, 1); f.idle(second);
    const input = { taskId: f.task.id, runId: second.id, eventId: randomUUID(), head: second.head,
      status: 'review_in_progress' as const, summary: 'Delta read; proof remains', reviewResponsibility: 'reviewer' as const,
      checkpoint: { covered: ['Delta and earlier findings'], remaining: ['Targeted proof'] } };
    const report = () => new Reports(f.engine).report(input, f.tokens.get(second.id)!);
    await report(); await f.engine.wake(); await f.engine.wake();
    const sends = f.sends.length; await report(); await f.engine.wake();
    assert.equal(f.current().id, second.id); assert.equal(f.sends.length, sends);
    assert.equal(f.store.run(second.id)!.reviewDeliveries?.filter(d => d.status === 'delivered').length, 1);
    await f.report(second, 'changes_required');
    assert.equal(runGit(f.workspace, 'branch', '--show-current'), 'feature/external');
  } finally { f.close(); }
});

test('unknown tools refuse the ordinary new-head send while preserving the earlier verdict and checkout', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current(); await f.report(first, 'changes_required');
    f.faults.unknownTools = true; await authorRevision(f, 1);
    assert.equal(f.sends.length, 0);
    assert.match(f.store.task(f.task.id).reason, /unknown tools|inconclusive/);
    assert.equal(f.store.run(first.id)!.completion!.status, 'changes_required');
    assert.equal(runGit(f.workspace, 'branch', '--show-current'), 'feature/external');
  } finally { f.close(); }
});


test('a genuine rebase author report receives base movement and covering evidence, then a genuine verdict at the new head', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current(); await f.report(first, 'changes_required');
    await f.engine.wake(); const revision = f.current(); assert.equal(revision.role, 'revision');
    writeFileSync(join(f.repo, 'base-movement.txt'), 'New base\n'); runGit(f.repo, 'add', '.'); runGit(f.repo, 'commit', '-m', 'advance base');
    const base = runGit(f.repo, 'rev-parse', 'main'); runGit(f.workspace, 'rebase', 'main');
    const head = f.workspaceHead(); runGit(f.workspace, 'push', '--force-with-lease', 'origin', 'feature/external'); f.state.prSha = head;
    f.idle(revision);
    await new Reports(f.engine).report({ taskId: f.task.id, runId: revision.id, eventId: randomUUID(), status: 'ready_for_review', summary: 'Rebased source', head, prNumber: 41 }, f.tokens.get(revision.id)!);
    await f.engine.wake(); await f.engine.wake(); await f.engine.wake();
    const review = f.current(); assert.ok(review, f.store.task(f.task.id).reason);
    assert.equal(review.head, head); assert.equal(review.base, base); assert.notEqual(review.id, first.id);
    assert.match(review.reviewDelta!, /Pure rebase confirmation/); assert.match(review.reviewDelta!, /Covering evidence at/);
    assert.ok(review.reviewDelta!.includes(base));
    await f.report(review, 'changes_required');
    assert.equal(f.store.task(f.task.id).resolution.review?.head, head);
    assert.equal(f.store.task(f.task.id).resolution.mergedCommit, null);
  } finally { f.close(); }
});

test('an explicit fresh restart after a retained round restores author placement and uses a new reviewer', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current(); await f.report(first, 'changes_required');
    const second = await authorRevision(f, 1);
    await f.report(second, 'blocked', { reviewResponsibility: 'environment' });
    await f.engine.performTaskControl({ taskId: f.task.id, version: f.store.task(f.task.id).version, action: 'restart', role: 'reviewer', fresh: true, reason: 'Owner requests a fresh reviewer' });
    await f.engine.wake(); await f.engine.wake();
    const review = f.current(); assert.ok(review, f.store.task(f.task.id).reason);
    assert.notEqual(review.agentId, second.agentId); assert.equal(review.head, second.head);
    assert.equal(f.store.run(second.id)!.completion!.status, 'blocked');
    assert.equal(runGit(f.workspace, 'branch', '--show-current'), 'feature/external');
  } finally { f.close(); }
});


test('a launch owns its reservation across concurrent observation and released-run telemetry refresh', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current(); await f.report(first, 'changes_required');
    const earlier = f.store.run(first.id)!.completion;
    const observations: Promise<void>[] = []; let observed = false;
    f.state.onObserve = () => {
      const run = f.current();
      if (!observed && run?.role === 'reviewer' && run.status === 'intent' && run.head !== f.oldHead) {
        observed = true;
        const prior = f.store.run(first.id)!;
        f.store.putRun({ ...prior, lastObservedAt: new Date().toISOString(), active: false, idleSince: new Date().toISOString() });
        observations.push(f.engine.resolution.observe());
      }
    };
    const review = await authorRevision(f, 1); await Promise.all(observations);
    assert.equal(observed, true); assert.ok(review, f.store.task(f.task.id).reason);
    assert.equal(review.status, 'running'); assert.equal(review.agentId, first.agentId);
    assert.equal(f.sends.filter(run => run.role === 'reviewer').length, 1);
    assert.deepEqual(f.store.run(first.id)!.completion, earlier);
    assert.notEqual(f.store.task(f.task.id).resolution.incident?.runId, review.id, 'historical resolved incidents remain; this launch opens none');
  } finally { f.close(); }
});

test('covering evidence from the earlier head refuses a new-head round without granting review credit', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current(); await f.report(first, 'changes_required');
    f.faults.staleCovering = true; await authorRevision(f, 1);
    assert.match(f.store.task(f.task.id).reason, /Covering evidence belongs to a different review head/);
    assert.equal(f.sends.filter(run => run.role === 'reviewer').length, 0);
    assert.equal(f.store.task(f.task.id).resolution.mergedCommit, null);
    assert.equal(f.store.run(first.id)!.completion!.head, first.head);
  } finally { f.close(); }
});

test('a subsequent round launches its reviewer while the merge gate still requires an approval', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current(); await f.report(first, 'changes_required');
    f.store.setMeta(`reviewPublication:${first.id}`, { hash: 'a'.repeat(64) });
    // Effigy #520: the old-head review asked for changes, so no review approves merging yet.
    f.faults.mergeNeedsApproval = true;
    await authorRevision(f, 1);
    const second = f.current();
    assert.ok(second, f.store.task(f.task.id).reason);
    assert.equal(second.role, 'reviewer', f.store.task(f.task.id).reason);
    assert.notEqual(second.head, first.head);
    assert.ok(f.store.getMeta(`reviewPublication:${first.id}`), 'old intent stays recorded');
    assert.deepEqual(blockingRecoveryEffects(f.store, f.store.task(f.task.id), { kinds: ['publication'], runId: first.id }), []);
    assert.equal(second.priorRunId, first.id);
    assert.doesNotMatch(f.store.task(f.task.id).reason, /does not approve merging/);
    assert.equal(f.store.task(f.task.id).resolution.mergedCommit, null, 'covering evidence grants no merge credit');
  } finally { f.close(); }
});

test('an owner return to the author supersedes the source-approval proof wait and launches the revision', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const run = f.current();
    await f.report(run, 'blocked', { reviewResponsibility: 'environment', sourceApproved: true, awaitingProofs: [{ proof: 'native-proof', route: 'external' }] });
    for (let n = 0; n < 3; n++) await f.engine.wake();
    assert.equal(f.store.task(f.task.id).resolution.stop?.reason, 'awaiting_proof');
    // Project-C #211: the proof attempt failed, so the owner returns the work to the author.
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.task.id, version: f.store.task(f.task.id).version,
      action: 'move', to: 'work', instruction: 'Repair the fixture gate the proof exposed', reason: 'Proof failed; author repair', caller: OPERATOR_BOARD_CALLER }));
    for (let n = 0; n < 3; n++) await f.engine.wake();
    const revision = f.store.runs(f.task.id).findLast(item => item.role === 'revision');
    assert.ok(revision, `author revision launched: ${f.store.task(f.task.id).reason}`);
    assert.match(revision.instruction ?? '', /Repair the fixture gate/);
    assert.notEqual(f.store.task(f.task.id).resolution.stop?.reason, 'awaiting_proof');
    assert.equal(f.store.run(run.id)!.completion!.sourceApproved, true, 'the approval stays recorded');
    assert.equal(f.store.task(f.task.id).resolution.mergedCommit, null);
  } finally { f.close(); }
});

test('an operator source acceptance of the approved head supersedes the proof wait and enters verification', async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const run = f.current();
    await f.report(run, 'blocked', { reviewResponsibility: 'environment', sourceApproved: true, awaitingProofs: [{ proof: 'post-merge-proof', route: 'external' }] });
    for (let n = 0; n < 3; n++) await f.engine.wake();
    assert.equal(f.store.task(f.task.id).resolution.stop?.reason, 'awaiting_proof');
    // Queue #520: the named proof can only exist after the merge, so the operator accepts the head.
    await f.engine.performTaskControl(taskControlInputSchema.parse({ taskId: f.task.id, version: f.store.task(f.task.id).version,
      action: 'move', to: 'merge', head: f.store.task(f.task.id).prHead, qualification: 'Accept; proof deferred to after the roll',
      reason: 'Post-merge proof cannot gate the merge', caller: OPERATOR_BOARD_CALLER }));
    for (let n = 0; n < 3; n++) await f.engine.wake();
    const task = f.store.task(f.task.id);
    assert.notEqual(task.resolution.stop?.reason, 'awaiting_proof', task.reason);
    assert.doesNotMatch(task.reason, /awaiting proof/);
    assert.equal(f.store.run(run.id)!.completion!.sourceApproved, true, 'the reviewer record stays as reported');
  } finally { f.close(); }
});

for (const action of ['restart', 'route', 'uncertain', 'route-uncertain', 'route-delayed-stop'] as const) test(`exhausted detached reviewer replacement releases ownership: ${action}`, async () => {
  const f = fixture();
  try {
    await f.engine.wake(); const first = f.current(); await f.report(first, 'changes_required');
    const old = await authorRevision(f, 1);
    assert.equal(old.ordinaryDetached, true);
    f.idle(old);
    const records = Array.from({ length: 6 }, (_, index) => ({ ordinal: index + 1,
      checkpoint: { covered: [`part ${index + 1}`], remaining: ['finish'] }, head: old.head,
      at: new Date().toISOString(), runId: old.id, path: join(f.root, `checkpoint-${index + 1}.json`) }));
    f.store.putRun({ ...f.store.run(old.id)!, reviewCheckpoints: records, reviewBudgetExhaustedAt: new Date().toISOString() });
    f.adapter.stopAgentTurn = async () => {};
    const delayedStop = action === 'route-delayed-stop';
    if (delayedStop) f.states.set(old.agentId!, { ...f.states.get(old.agentId!)!, status: 'running', active: true });
    const uncertain = action.endsWith('uncertain');
    let archived = false, attempts = 0;
    f.adapter.originAgent = async id => ({ id, workspaceId: old.workspaceId!, title: id, archived: id === old.agentId && archived });
    f.adapter.archiveAgent = async id => { assert.equal(id, old.agentId); attempts++; if (uncertain) throw Error('connection lost'); archived = true; };
    const control = action.startsWith('route')
      ? { action: 'route' as const, role: 'reviewer' as const, profileId: old.profile!.id, now: true, reason: 'Replace exhausted reviewer' }
      : { action: 'restart' as const, role: 'reviewer' as const, fresh: true, reason: 'Replace exhausted reviewer' };
    const restart = () => f.engine.performTaskControl({ ...control, taskId: f.task.id, version: f.store.task(f.task.id).version });
    if (delayedStop) {
      await restart();
      assert.match(f.store.task(f.task.id).reason, /archive is not confirmed/);
      assert.equal(attempts, 0, 'the stop reply does not prove inactivity');
      const archiveKey = f.store.threadArchiveKey(old.agentId!, old.hostId)!;
      assert.equal(f.store.getMeta<{ status: string }>(archiveKey)?.status, 'ready', 'the pending replacement is durable before inactivity');
      await f.engine.resolution.observe();
      assert.equal(attempts, 0, 'an active reviewer is never archived');
      assert.equal(f.store.run(old.id)!.released, false);
      assert.equal(f.store.task(f.task.id).resolution.currentRunId, old.id);
      f.idle(old);
      await f.engine.resolution.observe();
      assert.equal(f.store.task(f.task.id).profileRequests?.reviewer?.profileId, old.profile!.id);
    } else if (uncertain) {
      await restart();
      assert.match(f.store.task(f.task.id).reason, /archive is not confirmed/);
      assert.equal(f.store.run(old.id)!.released, false);
      await f.engine.resolution.observe();
      assert.equal(f.store.run(old.id)!.released, false);
      assert.equal(f.store.task(f.task.id).resolution.currentRunId, old.id);
      assert.equal(attempts, 1, 'unknown delivery is observation-only');
      if (action === 'route-uncertain') assert.equal(f.store.task(f.task.id).profileRequests?.reviewer?.profileId, old.profile!.id);
      archived = true;
      await f.engine.resolution.observe();
    } else await restart();
    assert.equal(attempts, 1);
    assert.equal(f.store.run(old.id)!.released, true);
    assert.equal(f.store.run(old.id)!.status, 'superseded');
    assert.deepEqual(f.store.run(old.id)!.reviewCheckpoints, records);
    assert.throws(() => f.store.authenticate(old.id, f.tokens.get(old.id)!));
    await f.engine.wake(); await f.engine.wake();
    const replacement = f.current(); assert.ok(replacement, f.store.task(f.task.id).reason);
    assert.equal(replacement.role, 'reviewer'); assert.notEqual(replacement.agentId, old.agentId);
    await f.report(replacement, 'changes_required');
    await f.engine.wake();
    assert.equal(f.current().role, 'revision', f.store.task(f.task.id).reason);
    assert.equal(runGit(f.workspace, 'branch', '--show-current'), 'feature/external');
  } finally { f.close(); }
});
