/**
 * Table tests for the daemon's pure decisions (lane `nucleus-simplify`, row F1,
 * phase 7). Each function answers from store facts the effectful caller has
 * already read, and the caller then applies exactly what the answer names:
 *
 * - `operationFailureSettlement` — how one failed durable operation settles.
 * - `coordinatorActionPlan` — the owner verb a coordinator report asks for, or
 *   the refusal naming why it no longer applies.
 * - `recoverySettlementPatch` — what settling an accepted report changes.
 * - `advanceFailureDisposition` — how one failed lifecycle pass settles.
 * - `noticeSettlement` — what one pending notice settles as before it is sent.
 * - `unavailableGroupNames` — the subscription groups a selection must avoid now.
 *
 * Current behaviour is the spec: every row states today's answer, including the
 * strings a stored record keeps. Bug 7's fix is pinned here (a task waiting on
 * `awaiting_proof` keeps its notice); no open map bug is touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinatorAction, Notice, RecoveryActionBinding, Task, TaskNextVerb } from '../shared/contracts';
import { advanceFailureDisposition, type AdvanceFailureDisposition } from '../core/resolution';
import { NO_ORIGIN_THREAD_WAIT } from '../core/questions/origin';
import { noticeSettlement, type NoticeSettlement } from '../core/questions/notices';
import { operationFailureSettlement, type OperationFailureSettlement } from '../core/planning/operations';
import { coordinatorActionPlan, recoverySettlementPatch, type CoordinatorActionPlan, type RecoverySettlementPatch } from '../core/recovery/coordinator-report';
import { digest } from '../core/store/store';
import { unavailableGroupNames } from '../shared/pool';

// ---------------------------------------------------------------------------
// operationFailureSettlement
// ---------------------------------------------------------------------------

type OperationFacts = Parameters<typeof operationFailureSettlement>[0];
const operationFacts = (over: Partial<OperationFacts> = {}): OperationFacts => ({
  committed: false, submissionDeferrable: false, validationUnavailable: false,
  parkedRestartProven: false, typedRefusalProven: false, typedPreSendRefusal: false,
  preSendBoundaryStarted: false, ownedToolRetryRefused: false, effectChangedSinceIntent: false,
  hasEffect: true, message: 'Task changed; refresh before retrying',
  ...over,
});
const unasked = () => { throw new Error('deferGitTransient is asked only for a submission or review entry'); };

test('operationFailureSettlement: a committed result keeps its own settlement', () => {
  const rows: Array<{ name: string; facts: Partial<OperationFacts>; expect: OperationFailureSettlement }> = [
    { name: 'the handler committed its result and effect',
      facts: { committed: true },
      expect: { kind: 'already_committed' } },
    { name: 'a submission whose git transient is paced defers to it',
      facts: { submissionDeferrable: true },
      expect: { kind: 'defer_git_transient' } },
    { name: 'a submission whose validation could not be read defers it',
      facts: { submissionDeferrable: true, validationUnavailable: true },
      expect: { kind: 'defer_validation' } },
    { name: 'a submission failure that is neither defers nothing',
      facts: { submissionDeferrable: true, message: 'Task changed; refresh before retrying' },
      expect: { kind: 'settle', receipt: null, state: 'failed', effect: 'reconciled' } },
  ];
  for (const row of rows) {
    const defer = row.expect.kind === 'defer_git_transient' ? () => true : () => false;
    assert.deepEqual(operationFailureSettlement(operationFacts(row.facts), defer), row.expect, row.name);
  }
});

test('operationFailureSettlement: Queue proves its own pre-send refusal, and only prose decides an unknown send', () => {
  const rows: Array<{ name: string; facts: Partial<OperationFacts>; expect: OperationFailureSettlement }> = [
    { name: 'a typed refusal with no receipt leaves a definite failure',
      facts: { typedPreSendRefusal: true, message: 'Cannot move the task: its PR is unmerged' },
      expect: { kind: 'settle', receipt: null, state: 'failed', effect: 'reconciled' } },
    { name: 'a parked restart records its rollback receipt',
      facts: { typedPreSendRefusal: true, parkedRestartProven: true },
      expect: { kind: 'settle', receipt: 'parked_restart', state: 'failed', effect: 'reconciled' } },
    { name: 'any other typed pre-send refusal records the refusal receipt',
      facts: { typedPreSendRefusal: true, typedRefusalProven: true },
      expect: { kind: 'settle', receipt: 'typed_refusal', state: 'failed', effect: 'reconciled' } },
    { name: 'a crossed send boundary without a proof stays uncertain (bug 20 class)',
      facts: { preSendBoundaryStarted: true, message: 'Cannot move the task' },
      expect: { kind: 'settle', receipt: null, state: 'needs_attention', effect: 'uncertain' } },
    { name: 'a crossed send boundary that Queue refused stays definite',
      facts: { preSendBoundaryStarted: true, typedPreSendRefusal: true, message: 'its delivery is unknown' },
      expect: { kind: 'settle', receipt: null, state: 'failed', effect: 'reconciled' } },
    { name: 'an unexplained failure whose prose reads uncertain needs attention',
      facts: { message: 'transport socket closed' },
      expect: { kind: 'settle', receipt: null, state: 'needs_attention', effect: 'uncertain' } },
    { name: 'an owned-tool hold is definite whatever its prose says',
      facts: { ownedToolRetryRefused: true, message: 'Owned-tool hold xy remains: its delivery is unknown' },
      expect: { kind: 'settle', receipt: null, state: 'failed', effect: 'reconciled' } },
    { name: 'a source promotion proved not to have inserted is a definite refusal, not an uncertain effect',
      facts: { sourcePromotionAbsent: true, message: 'Origin host is unknown or ambiguous' },
      expect: { kind: 'settle', receipt: null, state: 'failed', effect: 'reconciled' } },
    { name: 'an effect the settled record already replaced is kept',
      facts: { preSendBoundaryStarted: true, effectChangedSinceIntent: true },
      expect: { kind: 'settle', receipt: null, state: 'needs_attention', effect: 'keep' } },
    { name: 'an operation with no effect settles without one',
      facts: { hasEffect: false, message: 'no effect to reconcile' },
      expect: { kind: 'settle', receipt: null, state: 'failed', effect: null } },
  ];
  for (const row of rows) assert.deepEqual(operationFailureSettlement(operationFacts(row.facts), unasked), row.expect, row.name);
});

// ---------------------------------------------------------------------------
// coordinatorActionPlan and recoverySettlementPatch
// ---------------------------------------------------------------------------

const verbView = (verb: string, over: Partial<TaskNextVerb> = {}): TaskNextVerb =>
  ({ verb, action: verb, available: true, args: { taskId: 'task', version: 7 }, ...over });
const coordinatorAction = (over: Record<string, unknown>): CoordinatorAction => ({ verb: 'move', to: 'review', reason: 'route it', ...over }) as CoordinatorAction;
const planFacts = (over: Partial<Parameters<typeof coordinatorActionPlan>[0]> = {}) => ({
  action: coordinatorAction({}), views: [verbView('move')], stopReason: null,
  routeCost: null, usage: 'normal' as const, verbRegistered: true, ...over,
});

test('coordinatorActionPlan: it applies the reported verb’s own view, or names why not', () => {
  const rows: Array<{ name: string; facts: Parameters<typeof coordinatorActionPlan>[0]; expect: CoordinatorActionPlan }> = [
    { name: 'a move keeps its view arguments and the report’s reason',
      facts: planFacts({ views: [verbView('move', { args: { taskId: 'task', version: 7, to: 'review' } })],
        action: coordinatorAction({ instruction: 'look again', fresh: true }) }),
      expect: { ok: true, args: { taskId: 'task', version: 7, to: 'review', reason: 'route it', instruction: 'look again', fresh: true } } },
    { name: 'an unavailable verb names the view’s refusal',
      facts: planFacts({ views: [verbView('move', { available: false, args: undefined, refusal: 'A PR is required before moving to merge' })],
        action: coordinatorAction({ to: 'merge' }) }),
      expect: { ok: false, refusal: 'The reported move does not apply to the task now: A PR is required before moving to merge' } },
    { name: 'the task’s current stop is quoted',
      facts: planFacts({ views: [verbView('move', { available: false, args: undefined, refusal: 'A PR is required' })], stopReason: 'blocked' }),
      expect: { ok: false, refusal: 'The reported move does not apply to the task now (stop blocked): A PR is required' } },
    { name: 'same refusals are named once',
      facts: planFacts({ views: [verbView('move', { available: false, args: undefined, refusal: 'A PR is required' }),
        verbView('move', { available: false, args: undefined, refusal: 'A PR is required' })] }),
      expect: { ok: false, refusal: 'The reported move does not apply to the task now: A PR is required' } },
    { name: 'a route binds the role the view derived',
      facts: planFacts({ views: [verbView('route', { args: { taskId: 'task', version: 7, role: 'worker', profileId: 'terra' } })],
        action: coordinatorAction({ verb: 'route', role: 'worker', profileId: 'sol', now: true }) }),
      expect: { ok: true, args: { taskId: 'task', version: 7, reason: 'route it', role: 'worker', profileId: 'sol', now: true } } },
    { name: 'a route whose role the task does not offer does not apply',
      facts: planFacts({ views: [verbView('route', { args: { taskId: 'task', version: 7, role: 'reviewer', profileId: 'terra' } })],
        action: coordinatorAction({ verb: 'route', role: 'worker', profileId: 'sol' }) }),
      expect: { ok: false, refusal: 'The reported route does not apply to the task now' } },
    { name: 'a route above the operator’s usage level waits or reports cannot (Spec 052)',
      facts: planFacts({ views: [verbView('route', { args: { taskId: 'task', version: 7, role: 'worker', profileId: 'sol' } })],
        action: coordinatorAction({ verb: 'route', role: 'worker', profileId: 'sol' }), routeCost: 'very_high', usage: 'normal' }),
      expect: { ok: false, refusal: 'A coordinator cannot route to sol: its very_high cost is above the operator\'s normal usage level. Wait out an availability block or use an equivalent-cost profile, and report an environment block (a missing tool or stack) as cannot' } },
    { name: 'a route to a frontier profile below Maximum waits or reports cannot (Spec 052, Tom 2026-11-09)',
      facts: planFacts({ views: [verbView('route', { args: { taskId: 'task', version: 7, role: 'worker', profileId: 'opus' } })],
        action: coordinatorAction({ verb: 'route', role: 'worker', profileId: 'opus' }), routeCost: 'high', routeCapability: 'frontier', usage: 'high' }),
      expect: { ok: false, refusal: 'A coordinator cannot route to opus: it is rated frontier, which is request-only below Maximum. Use a profile within the high usage level, and report an environment block (a missing tool or stack) as cannot' } },
    { name: 'a restart role must be the stopped role',
      facts: planFacts({ views: [verbView('restart', { args: { taskId: 'task', version: 7, role: 'worker' } })],
        action: coordinatorAction({ verb: 'restart', role: 'reviewer' }) }),
      expect: { ok: false, refusal: 'restart reviewer does not match the stopped role worker' } },
    { name: 'a retry_effect carries the effect the report names',
      facts: planFacts({ views: [verbView('retry_effect', { args: { taskId: 'task', version: 7, effect: 'merge_intent' } })],
        action: coordinatorAction({ verb: 'retry_effect', effect: 'merge_intent' }) }),
      expect: { ok: true, args: { taskId: 'task', version: 7, reason: 'route it', effect: 'merge_intent' } } },
    { name: 'a verb the registry does not hold refuses',
      facts: planFacts({ views: [verbView('move', { args: { taskId: 'task', version: 7, to: 'review' } })], verbRegistered: false }),
      expect: { ok: false, refusal: 'The move owner verb is not registered' } },
  ];
  for (const row of rows) assert.deepEqual(coordinatorActionPlan(row.facts), row.expect, row.name);
});

const recoveryTask = (resolution: Record<string, unknown> = {}, reason = 'stopped'): Task =>
  ({ id: 'task', reason, resolution: { recovery: null, incident: null, stop: null, ...resolution } }) as unknown as Task;
const stop = (reason: string, since: string, detail = '') =>
  ({ reason, since, detail, suggestedVerbs: ['restart'] }) as unknown as NonNullable<Task['resolution']['stop']>;
const episode = (over: Record<string, unknown> = {}) => ({ id: 'recovery-1', key: '', generation: 1, runId: 'run-1',
  agentId: null, status: 'running', summary: '', idleSince: null, incidentId: null, ...over }) as unknown as NonNullable<Task['resolution']['recovery']>;
const incident = (over: Record<string, unknown> = {}) => ({ id: 'incident-1', role: 'reviewer', runId: 'run-1',
  fingerprint: 'fingerprint', attempt: 1, cause: 'missing_callback', detail: '', status: 'reconciling', updatedAt: '2026-11-07T09:00:00.000Z', ...over }) as unknown as NonNullable<Task['resolution']['incident']>;
const binding = (over: Record<string, unknown> = {}) => ({
  eventId: 'event-1', runId: 'run-1', reportStatus: 'recovered', summary: 'the reviewer was replaced',
  status: 'pending', coordinatorAction: { verb: 'restart', reason: 'it stopped' }, ...over,
}) as unknown as RecoveryActionBinding;

test('recoverySettlementPatch: an accepted report resolves its episode, and a refused one leaves its reason', () => {
  const since = '2026-11-07T10:00:00.000Z';
  const openEpisode = episode({ key: digest(`stop:reviewer_stopped:${since}`), action: { eventId: 'event-1' } });
  const rows: Array<{ name: string; facts: Parameters<typeof recoverySettlementPatch>[0]; expect: RecoverySettlementPatch }> = [
    { name: 'an episode another run took over settles as its event alone',
      facts: { status: 'applied', binding: binding(), action: coordinatorAction({ verb: 'restart' }),
        runId: 'run-2', task: recoveryTask({ recovery: openEpisode }), at: since },
      expect: { kind: 'event_only', event: 'coordinator_action_applied' } },
    { name: 'a report whose episode is gone settles as its event alone',
      facts: { status: 'refused', reason: 'stale', binding: binding(), action: coordinatorAction({ verb: 'restart' }),
        runId: 'run-1', task: recoveryTask(), at: since },
      expect: { kind: 'event_only', event: 'coordinator_action_refused' } },
    { name: 'an applied report resolves the episode, its action and the recovered incident',
      facts: { status: 'applied', binding: binding(), action: coordinatorAction({ verb: 'restart' }), runId: 'run-1',
        task: recoveryTask({ recovery: { ...openEpisode, incidentId: 'incident-1' }, stop: stop('reviewer_stopped', since),
          incident: incident() }), at: since },
      expect: { kind: 'patch', event: 'coordinator_action_applied',
        changes: { recovery: { ...openEpisode, incidentId: 'incident-1', status: 'resolved', summary: 'the reviewer was replaced',
            action: { ...binding(), status: 'applied' } },
          incident: { ...incident(), status: 'resolved', detail: 'Recovery reported the trigger settled: the reviewer was replaced', updatedAt: since },
          recoveryActive: false, stop: null },
        patch: {} } },
    { name: 'a refused report lands its reason on the stop it answers',
      facts: { status: 'refused', reason: 'The reported restart does not apply to the task now', binding: binding(),
        action: coordinatorAction({ verb: 'restart' }), runId: 'run-1',
        task: recoveryTask({ recovery: openEpisode, stop: stop('reviewer_stopped', since) }, 'reviewer stopped'), at: since },
      expect: { kind: 'patch', event: 'coordinator_action_refused',
        changes: { recovery: { ...openEpisode, status: 'resolved', summary: 'the reviewer was replaced',
            action: { ...binding(), status: 'refused', reason: 'The reported restart does not apply to the task now' } },
          incident: null, recoveryActive: false,
          stop: { ...stop('reviewer_stopped', since), detail: 'The reported restart does not apply to the task now — the reviewer was replaced' } },
        patch: { reason: 'The reported restart does not apply to the task now — the reviewer was replaced' } } },
    { name: 'a refusal for a stop the episode no longer owns leaves the stop as it is',
      facts: { status: 'refused', reason: 'The task moved on since the coordinator was asked (its results, head, phase, run or routes changed)',
        binding: binding(), action: coordinatorAction({ verb: 'restart' }), runId: 'run-1',
        task: recoveryTask({ recovery: openEpisode, stop: stop('other_stop', since, 'something else') }, 'something else'), at: since },
      expect: { kind: 'patch', event: 'coordinator_action_refused',
        changes: { recovery: { ...openEpisode, status: 'resolved', summary: 'the reviewer was replaced',
            action: { ...binding(), status: 'refused', reason: 'The task moved on since the coordinator was asked (its results, head, phase, run or routes changed)' } },
          incident: null, recoveryActive: false, stop: stop('other_stop', since, 'something else') },
        patch: {} } },
    { name: 'a coordinator that reported cannot escalates its own reason onto the stop',
      facts: { status: 'refused', binding: binding(), action: coordinatorAction({ verb: 'cannot', reason: 'the toolchain is missing' }),
        runId: 'run-1', task: recoveryTask({ recovery: openEpisode, stop: stop('reviewer_stopped', since) }, 'other'), at: since },
      expect: { kind: 'patch', event: 'coordinator_action_refused',
        changes: { recovery: { ...openEpisode, status: 'resolved', summary: 'the reviewer was replaced',
            action: { ...binding(), status: 'refused', reason: 'Coordinator report no longer matches the current task stop' } },
          incident: null, recoveryActive: false,
          stop: { ...stop('reviewer_stopped', since), detail: 'the toolchain is missing — the reviewer was replaced' } },
        patch: { reason: 'the toolchain is missing — the reviewer was replaced' } } },
  ];
  for (const row of rows) assert.deepEqual(recoverySettlementPatch(row.facts), row.expect, row.name);
});

// ---------------------------------------------------------------------------
// advanceFailureDisposition
// ---------------------------------------------------------------------------

type AdvanceFacts = Parameters<typeof advanceFailureDisposition>[0];
const advanceFacts = (over: Partial<AdvanceFacts> = {}): AdvanceFacts => ({
  message: 'boom', errorText: 'Error: boom', successor: null, mergeIntent: false, mergedCommit: null,
  mergeResponseOutcome: 'pending', mergedIdentityDiffers: false, uncertainCurrentSend: false, transientSendFault: false,
  forgeOutage: false, gitReadTimeout: false, loginSessionFault: false, ...over,
});

test('advanceFailureDisposition: one failed pass settles in today’s order', () => {
  const rows: Array<{ name: string; facts: AdvanceFacts; gitTransient: boolean; expect: AdvanceFailureDisposition; asked?: boolean }> = [
    { name: 'a newer attempt that took over supersedes this one', facts: advanceFacts({ successor: 'run-2' }),
      gitTransient: true, expect: { kind: 'superseded_attempt', successor: 'run-2' }, asked: false },
    { name: 'a recorded merge intent skips the git-transient handler',
      facts: advanceFacts({ mergeIntent: true, mergeResponseOutcome: 'pending' }), gitTransient: true,
      expect: { kind: 'merge_response_uncertain', detail: 'Initial guarded merge response is uncertain: Error: boom' }, asked: false },
    { name: 'a transient git fault is paced by its own handler', facts: advanceFacts(),
      gitTransient: true, expect: { kind: 'git_transient' } },
    { name: 'an uncertain send with a known transient fault waits, never retries (bug 4 class)',
      facts: advanceFacts({ uncertainCurrentSend: true, transientSendFault: true, message: 'socket closed' }), gitTransient: false,
      expect: { kind: 'wait', reason: 'Transient run delivery fault; reconciling the existing run before any retry: socket closed', stop: 'external_unavailable' } },
    { name: 'a forge outage waits as an external unavailability', facts: advanceFacts({ forgeOutage: true, message: 'forge down' }),
      gitTransient: false, expect: { kind: 'wait', reason: 'forge down', stop: 'external_unavailable' } },
    { name: 'a forge outage during an uncounted merge keeps its merge uncertainty',
      facts: advanceFacts({ forgeOutage: true, mergeIntent: true }), gitTransient: false,
      expect: { kind: 'merge_response_uncertain', detail: 'Initial guarded merge response is uncertain: Error: boom' } },
    { name: 'a git read timeout waits as an external unavailability', facts: advanceFacts({ gitReadTimeout: true, message: 'git read timed out' }),
      gitTransient: false, expect: { kind: 'wait', reason: 'git read timed out', stop: 'external_unavailable' } },
    { name: 'an operator session fault is environmental', facts: advanceFacts({ loginSessionFault: true }),
      gitTransient: false, expect: { kind: 'environment' } },
    { name: 'a merged PR that differs from the approved task needs the owner',
      facts: advanceFacts({ mergeIntent: true, mergedIdentityDiffers: true, message: 'Merged PR identity differs from the approved task' }), gitTransient: false,
      expect: { kind: 'attention', reason: 'Merged PR identity differs from the approved task' } },
    // Only an `Error` with that exact message is the identity fault; the original
    // rule named the class, so any other throw keeps its own disposition.
    { name: 'a non-Error throw with that prose is not the identity fault',
      facts: advanceFacts({ mergeIntent: true, message: 'Merged PR identity differs from the approved task' }), gitTransient: false,
      expect: { kind: 'merge_response_uncertain', detail: 'Initial guarded merge response is uncertain: Error: boom' } },
    { name: 'an already uncertain merge keeps reconciling', facts: advanceFacts({ mergeIntent: true, mergeResponseOutcome: 'uncertain' }),
      gitTransient: false, expect: { kind: 'wait', reason: 'Merge response is uncertain; GitHub reconciliation continues within the bounded proof window', stop: 'lifecycle' } },
    { name: 'anything else needs the owner', facts: advanceFacts({ message: 'unexpected' }), gitTransient: false,
      expect: { kind: 'attention', reason: 'unexpected' } },
  ];
  for (const row of rows) {
    let asked = false;
    const decision = advanceFailureDisposition(row.facts, () => { asked = true; return row.gitTransient; });
    assert.deepEqual(decision, row.expect, row.name);
    if (row.asked === false) assert.equal(asked, false, `${row.name}: the git-transient handler is not consulted`);
  }
});

// ---------------------------------------------------------------------------
// noticeSettlement
// ---------------------------------------------------------------------------

type NoticeFacts = Parameters<typeof noticeSettlement>[0];
const notice = (over: Partial<Notice> = {}): Pick<Notice, 'id' | 'kind' | 'status' | 'agentId' | 'originEntry' | 'error'> =>
  ({ id: 'attention:task', kind: 'attention', status: 'pending', agentId: 'owner', originEntry: true, error: '', ...over });
const noticeFacts = (over: Partial<NoticeFacts> = {}): NoticeFacts => ({
  notice: notice(), taskRemoved: false, disposition: 'none', originUnreachable: false, target: 'owner',
  currentNoticeId: 'attention:task', supportsCoordinatorRecovery: true, coordinatorNeedsOwner: false,
  awaitingProof: false, closeoutHookHold: false, sshAuthExhausted: false, recoveryEscalated: false,
  completionCohort: null, ...over,
});

test('noticeSettlement: one pending notice’s ordinary settlement, in today’s order', () => {
  const rows: Array<{ name: string; facts: NoticeFacts; expect: NoticeSettlement }> = [
    { name: 'a removed task’s notice is skipped', facts: noticeFacts({ taskRemoved: true }),
      expect: { kind: 'skip' } },
    { name: 'a task mid-disposition is skipped', facts: noticeFacts({ disposition: 'active' }),
      expect: { kind: 'skip' } },
    { name: 'a completed disposition supersedes its notices', facts: noticeFacts({ disposition: 'complete' }),
      expect: { kind: 'superseded', error: 'Task disposition completed before notice settlement' } },
    { name: 'an unreachable origin with no planner is skipped', facts: noticeFacts({ originUnreachable: true }),
      expect: { kind: 'skip' } },
    { name: 'a completion entry with its own recipient is not skipped for the origin',
      facts: noticeFacts({ originUnreachable: true, notice: notice({ id: 'completion:task', kind: 'completion', originEntry: false }), currentNoticeId: 'completion:task' }),
      expect: { kind: 'send', recipient: 'owner', escalation: false } },
    { name: 'a settled cohort entry coalesces the pending completion notice',
      facts: noticeFacts({ notice: notice({ id: 'completion:task', kind: 'completion' }), currentNoticeId: 'completion:task',
        completionCohort: { settled: true, firstPendingId: 'completion:task' }, recoveryEscalated: true }),
      expect: { kind: 'superseded', error: 'Completion coalesced because multiple cohort entries resolve to owner',
        coalesced: { agentId: 'owner', event: 'completion_notice_coalesced' } } },
    { name: 'only the first pending cohort entry survives', facts: noticeFacts({ notice: notice({ id: 'completion:task', kind: 'completion' }),
        currentNoticeId: 'completion:task', completionCohort: { settled: false, firstPendingId: 'completion:other' } }),
      expect: { kind: 'superseded', error: 'Completion coalesced because multiple cohort entries resolve to owner',
        coalesced: { agentId: 'owner', event: 'completion_notice_coalesced' } } },
    { name: 'the first pending cohort entry settles itself', facts: noticeFacts({ notice: notice({ id: 'completion:task', kind: 'completion' }),
        currentNoticeId: 'completion:task', completionCohort: { settled: false, firstPendingId: 'completion:task' } }),
      expect: { kind: 'send', recipient: 'owner', escalation: false } },
    // A pending retarget settles in the same pass: the caller re-points the
    // notice and asks again, so only an interrupted notice stops here.
    { name: 'a pending notice follows its recipient when the owner changed',
      facts: noticeFacts({ target: 'new-owner' }),
      expect: { kind: 'retarget', agentId: 'new-owner' } },
    { name: 'an interrupted notice whose recipient moved never resends',
      facts: noticeFacts({ target: 'new-owner', notice: notice({ status: 'intent' }) }),
      expect: { kind: 'uncertain', error: 'Origin changed after delivery intent; inspect old thread before resending' } },
    { name: 'a coordinator-recovery stop supersedes a superseded attention notice',
      facts: noticeFacts(),
      expect: { kind: 'superseded' } },
    { name: 'a proof wait keeps its notice (bug 7)', facts: noticeFacts({ awaitingProof: true }),
      expect: { kind: 'send', recipient: 'owner', escalation: false } },
    { name: 'a closeout hook hold keeps its notice', facts: noticeFacts({ closeoutHookHold: true }),
      expect: { kind: 'send', recipient: 'owner', escalation: false } },
    { name: 'an ssh-exhausted reason keeps its notice', facts: noticeFacts({ sshAuthExhausted: true }),
      expect: { kind: 'send', recipient: 'owner', escalation: false } },
    { name: 'an escalated episode delivers as an escalation', facts: noticeFacts({ recoveryEscalated: true, coordinatorNeedsOwner: true }),
      expect: { kind: 'send', recipient: 'owner', escalation: true } },
    { name: 'a refused coordinator action keeps its notice', facts: noticeFacts({ coordinatorNeedsOwner: true }),
      expect: { kind: 'send', recipient: 'owner', escalation: false } },
    { name: 'an attention notice the task no longer derives is superseded',
      facts: noticeFacts({ supportsCoordinatorRecovery: false, currentNoticeId: 'attention:other' }),
      expect: { kind: 'superseded' } },
    { name: 'a prerequisite notice is never superseded for its id',
      facts: noticeFacts({ notice: notice({ kind: 'prerequisite' }), supportsCoordinatorRecovery: false, currentNoticeId: 'attention:other' }),
      expect: { kind: 'send', recipient: 'owner', escalation: false } },
    { name: 'an interrupted attention notice settles uncertain',
      facts: noticeFacts({ notice: notice({ status: 'intent' }), coordinatorNeedsOwner: true }),
      expect: { kind: 'uncertain', error: 'Restart during delivery; inspect origin thread before resending' } },
    { name: 'an interrupted completion notice settles uncertain',
      facts: noticeFacts({ notice: notice({ id: 'completion:task', kind: 'completion', status: 'intent' }), currentNoticeId: 'completion:task' }),
      expect: { kind: 'uncertain', error: 'Restart during delivery; inspect recipient thread before resending' } },
    { name: 'a notice with no thread waits and stays visible',
      facts: noticeFacts({ target: null, notice: notice({ agentId: '' }), coordinatorNeedsOwner: true }),
      expect: { kind: 'wait', error: NO_ORIGIN_THREAD_WAIT } },
  ];
  for (const row of rows) assert.deepEqual(noticeSettlement(row.facts), row.expect, row.name);
});

// ---------------------------------------------------------------------------
// unavailableGroupNames
// ---------------------------------------------------------------------------

test('unavailableGroupNames reads the typed availability rows once', () => {
  const at = Date.parse('2026-11-14T12:00:00.000Z');
  const rows = [
    { group: 'paused', unavailable: true, reason: 'paused', retryAt: null },
    { group: 'cooling', unavailable: true, reason: 'rate limit', retryAt: '2026-11-14T13:00:00.000Z' },
    { group: 'recovered', unavailable: true, reason: 'rate limit', retryAt: '2026-11-14T11:00:00.000Z' },
    { group: 'healthy', unavailable: false, reason: '', retryAt: null },
  ];
  assert.deepEqual([...unavailableGroupNames(rows, at)].sort(), ['cooling', 'paused'],
    'a group past its retry time is selectable again');
  assert.deepEqual([...unavailableGroupNames(rows, Date.parse('2026-11-14T13:00:00.000Z'))].sort(), ['paused'],
    'the retry time itself is the first selectable instant');
});

test('source promotion reconciliation surfaces an unreadable operation without changing it', async () => {
  const { reconcileSourcePromotion } = await import('../core/planning/source-promotion-reconcile');
  const { SOURCE_PROMOTION_NOT_DELIVERED } = await import('../core/planning/operations');
  const failure = new Error('operation payload unavailable');
  const store = { operationPayload: () => { throw failure; } } as unknown as import('../core/store/store').Store;
  const operation = { id: 'op', kind: 'source_promote', effect: { kind: 'source_promotion', status: 'uncertain' } } as import('../shared/operations').QueueOperation;
  assert.throws(() => reconcileSourcePromotion(store, operation, new Set()), failure);
  assert.notEqual(operation.effect?.result, SOURCE_PROMOTION_NOT_DELIVERED);
});
