import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Run, StalledTurnStop, Task } from '../shared/contracts';
import { GIT_TRANSIENT_LIMIT_MS } from '../core/git/git-transient-backoff';
import { gitTransientPlan, quantumFollowUps, stepFailureRoute } from '../core/scheduling/task-wakes';
import { stalledStopDecision } from '../core/recovery/stall';
import { refusalGap } from '../core/recovery/provider-refusal';
import { reminderDecision } from '../core/intake/callback-reminders';
import { timelineMessage } from '../core/recovery/effect-reconcile';
import type { AgentObservation } from '../core/host';
import type { TimelinePage } from '../core/recovery/stall';

const gitFacts = {
  failureKind: 'network' as const, deliveryUnknown: false, publicationTransient: false, operation: false,
  hasReviewPublication: false, old: null, host: null, detail: 'fail', now: 1_000,
};

test('gitTransientPlan outcomes', () => {
  const cases: Array<[Parameters<typeof gitTransientPlan>[0], string]> = [
    [{ ...gitFacts, failureKind: null }, 'ignore'],
    [{ ...gitFacts, deliveryUnknown: true, operation: true }, 'skip_unknown'],
    [{ ...gitFacts, deliveryUnknown: true, publicationTransient: false }, 'skip_unknown'],
    [{ ...gitFacts, deliveryUnknown: true, publicationTransient: true, hasReviewPublication: false }, 'skip_unknown'],
    [{ ...gitFacts, deliveryUnknown: true, publicationTransient: true, hasReviewPublication: true }, 'retry_shared'],
    [{ ...gitFacts, failureKind: 'lock' }, 'retry_lock'],
    [{ ...gitFacts, old: { startedAt: 0, attempts: 3, retryAt: 100, detail: 'old' }, now: GIT_TRANSIENT_LIMIT_MS }, 'exhausted'],
    [{ ...gitFacts, failureKind: 'ssh', old: { startedAt: 0, attempts: 2, retryAt: 100, detail: 'ssh' }, now: GIT_TRANSIENT_LIMIT_MS }, 'exhausted'],
  ];
  for (const [facts, expected] of cases) assert.equal(gitTransientPlan(facts).kind, expected, expected);
  const sharedHost = gitTransientPlan({
    ...gitFacts, host: { startedAt: 0, attempts: 1, retryAt: 8_000, detail: 'host' },
  });
  assert.equal(sharedHost.kind, 'retry_shared');
  if (sharedHost.kind === 'retry_shared') {
    assert.equal(sharedHost.episode.retryAt, 8_000);
    assert.equal(sharedHost.host.retryAt, 8_000);
  }
  const lock = gitTransientPlan({ ...gitFacts, failureKind: 'lock' });
  assert.equal(lock.kind, 'retry_lock');
  if (lock.kind === 'retry_lock') assert.equal(lock.episode.retryAt, 6_000);
});

test('stepFailureRoute order', () => {
  const none = { terminal: false, gitTransient: false, checkoutRefusal: false, externalWait: false, transport: false, session: false };
  const cases: Array<[Partial<typeof none>, string]> = [
    [{ gitTransient: true }, 'git_transient'],
    [{ terminal: true, gitTransient: true }, 'cleanup'],
    [{ terminal: true }, 'cleanup'],
    [{ checkoutRefusal: true, externalWait: true }, 'checkout_refusal'],
    [{ externalWait: true, transport: true }, 'external_wait'],
    [{ transport: true, session: true }, 'transport'],
    [{ session: true }, 'session'],
    [{}, 'attention'],
  ];
  for (const [patch, expected] of cases) assert.equal(stepFailureRoute({ ...none, ...patch }), expected);
});

test('quantumFollowUps order and gates', () => {
  const base = {
    transientBefore: null, transientUnchanged: true, phaseChanged: false, syncedCommitChanged: false, currentRunIdChanged: false,
    occupiedBefore: false, occupiedAfter: false, afterPhase: 'working', threadsPending: false, beforePhase: 'working',
    threadWorkBefore: false, launched: false, progressChanged: false, attention: false, recoveryActive: false, dispatchBlocked: false,
    heldIntegration: false, hadIntegrationTurn: false, integrationActiveBefore: false, holdsIntegrationAfter: false,
  };
  const episode = { startedAt: 1, attempts: 1, retryAt: 2, detail: 'x' };
  assert.deepEqual(quantumFollowUps(base), ['completion', 'terminal_archive']);
  assert.deepEqual(quantumFollowUps({ ...base, transientBefore: episode, phaseChanged: true, transientUnchanged: true }),
    ['clear_transient', 'completion', 'terminal_archive']);
  assert.deepEqual(quantumFollowUps({ ...base, transientBefore: episode, phaseChanged: true, transientUnchanged: false }),
    ['completion', 'terminal_archive']);
  assert.deepEqual(quantumFollowUps({ ...base, occupiedBefore: true, occupiedAfter: false }),
    ['wake_capacity', 'completion', 'terminal_archive']);
  assert.deepEqual(quantumFollowUps({ ...base, afterPhase: 'done', beforePhase: 'closing' }),
    ['completion', 'terminal_archive', 'cleanup']);
  assert.deepEqual(quantumFollowUps({ ...base, afterPhase: 'done', beforePhase: 'done', threadWorkBefore: true }),
    ['completion', 'terminal_archive', 'cleanup']);
  assert.deepEqual(quantumFollowUps({ ...base, afterPhase: 'done', beforePhase: 'done' }),
    ['completion', 'terminal_archive']);
  assert.deepEqual(quantumFollowUps({ ...base, afterPhase: 'done', threadsPending: true, beforePhase: 'closing' }),
    ['completion', 'terminal_archive']);
  assert.deepEqual(quantumFollowUps({ ...base, afterPhase: 'verifying', progressChanged: true }),
    ['completion', 'terminal_archive', 'lifecycle']);
  assert.deepEqual(quantumFollowUps({ ...base, afterPhase: 'verifying', progressChanged: true, launched: true }),
    ['completion', 'terminal_archive']);
  assert.deepEqual(quantumFollowUps({ ...base, afterPhase: 'working', progressChanged: true }),
    ['completion', 'terminal_archive']);
  assert.deepEqual(quantumFollowUps({ ...base, afterPhase: 'verifying', progressChanged: true, attention: true }),
    ['completion', 'terminal_archive']);
  assert.deepEqual(quantumFollowUps({ ...base, heldIntegration: true, holdsIntegrationAfter: false }),
    ['completion', 'terminal_archive', 'wake_integration']);
  assert.deepEqual(quantumFollowUps({ ...base, hadIntegrationTurn: true, integrationActiveBefore: false, holdsIntegrationAfter: false }),
    ['completion', 'terminal_archive', 'wake_integration']);
  assert.deepEqual(quantumFollowUps({ ...base, heldIntegration: true, holdsIntegrationAfter: true }),
    ['completion', 'terminal_archive']);
});

const idle = { id: 'a', workspaceId: 'w', active: false, permissions: false, status: 'idle' } as AgentObservation;
const workerStop = { role: 'worker', runId: 'r', agentId: 'a', workspaceId: 'w', turnId: 't', status: 'sent' } as StalledTurnStop;
const workerTask = { runId: 'r', agentId: 'a', workspaceId: 'w', prHead: null, completion: null, reason: '',
  resolution: { currentRunId: null, reviewerAgentId: null } } as Task;
const stallBase = { stop: workerStop, run: null, targetRun: null, current: workerTask, paused: false, dispatchBlocked: false,
  state: idle, authenticCompletion: false };

test('stalledStopDecision outcomes', () => {
  const cases: Array<[object, string]> = [
    [{ stop: null }, 'none'],
    [{ stop: { ...workerStop, status: 'completed' } }, 'none'],
    [{ run: { id: 'r' } as Run }, 'identity_mismatch'],
    [{ current: { ...workerTask, runId: 'other' } as Task }, 'identity_mismatch'],
    [{ paused: true }, 'held'],
    [{ dispatchBlocked: true, paused: true }, 'held'],
    [{ state: { ...idle, id: 'other' } }, 'agent_changed'],
    [{ state: { ...idle, active: true, permissions: true } }, 'busy_permission'],
    [{ state: { ...idle, active: true, activeTurnId: 'other' } }, 'busy_other_turn'],
    [{ state: { ...idle, active: true, activeTurnId: 't' } }, 'busy_same_turn'],
    [{ state: { ...idle, status: 'running' } }, 'busy_unknown_turn'],
    [{ state: { ...idle, status: 'unknown' } }, 'incomplete'],
    [{ authenticCompletion: true }, 'completion'],
    [{ stop: { ...workerStop, restartInstruction: 'continue' } }, 'restart'],
    [{}, 'inactive'],
  ];
  for (const [patch, expected] of cases)
    assert.equal(stalledStopDecision({ ...stallBase, ...patch } as typeof stallBase).kind, expected, expected);
  assert.equal(stalledStopDecision({ ...stallBase, paused: true, run: { id: 'r' } as Run }).kind, 'identity_mismatch');
  const inactive = stalledStopDecision(stallBase);
  assert.equal(inactive.kind, 'inactive');
  if (inactive.kind === 'inactive')
    assert.equal(inactive.reason, 'The operator-authorized stalled worker run r turn t is inactive. No authenticated result or review verdict was received, and no replacement turn was started. The owner must choose the next action.');
  const reviewerStop = { role: 'reviewer', runId: 'r', agentId: 'a', workspaceId: 'w', turnId: 't', status: 'sent' } as StalledTurnStop;
  const reviewerRun = { id: 'r', role: 'reviewer', agentId: 'a', workspaceId: 'w', head: 'h' } as Run;
  const reviewerTask = { runId: null, agentId: null, workspaceId: 'w', prHead: 'h', completion: null, reason: '',
    resolution: { currentRunId: 'r', reviewerAgentId: 'a' } } as Task;
  assert.equal(stalledStopDecision({
    ...stallBase, stop: reviewerStop, run: reviewerRun, targetRun: reviewerRun, current: reviewerTask,
  }).kind, 'inactive');
  assert.equal(stalledStopDecision({
    ...stallBase, stop: reviewerStop, run: reviewerRun, targetRun: { ...reviewerRun, head: 'other' } as Run, current: reviewerTask,
  }).kind, 'identity_mismatch');
});

test('refusalGap first matching fence', () => {
  const run = { id: 'r', workspaceId: 'w', agentId: 'a', head: 'h', released: false, status: 'running', completion: null,
    reviewCheckpoints: [], reviewContinuation: null, reviewDeliveries: [] } as unknown as Run;
  const current = {
    version: 1, removedAt: null, phase: 'reviewing', workspaceId: 'w', directory: '/d', prUrl: 'u', prHead: 'h',
    resolution: {
      currentRunId: 'r', reviewerAgentId: 'a', mergeIntent: false, mergedCommit: null, externalMerge: null, mergeHead: null,
      review: null, attention: false, recoveryActive: false, recovery: null, incident: null, stalledTurnStop: null, roleReplacements: 0,
    },
  } as unknown as Task;
  const ok = { current, run, latest: run, paused: false, reviewAuthorizationRequired: false, otherUnreleased: false, publicationUnresolved: false };
  const cases: Array<[object, string | null]> = [
    [{ expectedVersion: 2 }, 'the task changed during refusal recovery'],
    [{ current: { ...current, removedAt: 'now' } as Task }, 'the task was removed'],
    [{ current: { ...current, phase: 'working' } as Task }, 'the task is not reviewing (working)'],
    [{ paused: true }, 'Nucleus is paused'],
    [{ reviewAuthorizationRequired: true }, 'a review authorization is required'],
    [{ current: { ...current, resolution: { ...current.resolution, mergeIntent: true } } as Task }, 'a merge intent exists'],
    [{ latest: null }, 'the reviewer run is released or completed'],
    [{ current: { ...current, resolution: { ...current.resolution, currentRunId: 'other' } } as Task }, 'the reviewer run is no longer current'],
    [{ current: { ...current, workspaceId: 'other' } as Task }, 'the reviewer workspace differs from the task workspace'],
    [{ current: { ...current, resolution: { ...current.resolution, reviewerAgentId: 'other' } } as Task }, 'the reviewer agent identity changed'],
    [{ current: { ...current, resolution: { ...current.resolution, review: { status: 'ready_to_merge' } } } as Task }, 'a reviewer result already exists'],
    [{ current: { ...current, prHead: 'other' } as Task }, "the reviewer is not bound to the task's exact open head"],
    [{ otherUnreleased: true }, 'another run still owns this task'],
    [{ latest: { ...run, reviewCheckpoints: [{}] } as unknown as Run }, 'the reviewer recorded progress checkpoints'],
    [{ latest: { ...run, reviewContinuation: { status: 'reserved' } } as unknown as Run }, 'a reviewer continuation effect is unresolved'],
    [{ latest: { ...run, reviewDeliveries: [{ status: 'uncertain' }] } as unknown as Run }, 'a reviewer delivery effect is unresolved'],
    [{ publicationUnresolved: true }, 'a review publication is unresolved'],
    [{ current: { ...current, resolution: { ...current.resolution, attention: true } } as Task }, 'an unresolved incident or recovery fences this run'],
    [{ current: { ...current, resolution: { ...current.resolution, stalledTurnStop: { status: 'sent' } } } as Task }, 'a stalled-turn stop is outstanding'],
    [{ current: { ...current, resolution: { ...current.resolution, roleReplacements: 8 } } as Task }, 'the role replacement budget is spent'],
    [{}, null],
  ];
  for (const [patch, expected] of cases) assert.equal(refusalGap({ ...ok, ...patch } as typeof ok), expected, String(expected));
});

test('reminderDecision gates', () => {
  const cases: Array<[Parameters<typeof reminderDecision>[0], string]> = [
    [{ blocked: true }, 'skip'],
    [{ reviewAuth: true }, 'skip'],
    [{ escalated: true }, 'skip'],
    [{ bindingOutside: true }, 'relaunch'],
    [{ blocked: true, bindingOutside: true }, 'skip'],
    [{ dispatch: 'absent' }, 'skip_undispatched'],
    [{ dispatch: 'unverified', validationAbsent: false }, 'extend'],
    [{ dispatch: 'delivered', validationAbsent: false }, 'extend'],
    [{ validationAbsent: true, reminderAction: true, graceExpired: true }, 'escalate'],
    [{ validationAbsent: true, reminderAction: true, graceExpired: false }, 'wait_grace'],
    [{ validationAbsent: true, alreadySent: true }, 'already_sent'],
    [{ validationAbsent: true, hasChannel: false }, 'no_channel'],
    [{ validationAbsent: true, hasChannel: true }, 'send'],
    [{ dispatch: 'absent', validationAbsent: false, reminderAction: true, graceExpired: true }, 'skip_undispatched'],
  ];
  for (const [facts, expected] of cases) assert.equal(reminderDecision(facts), expected, expected);
});

test('timelineMessage present absent unknown, including map bug 14', () => {
  const present = { entries: [{ timestamp: 't', item: { type: 'user_message', messageId: 'm' } }] } as unknown as TimelinePage;
  const client = { entries: [{ timestamp: 't', item: { type: 'user_message', clientMessageId: 'm' } }] } as unknown as TimelinePage;
  const other = { entries: [{ timestamp: 't', item: { type: 'user_message', messageId: 'other' } }] } as unknown as TimelinePage;
  const cases: Array<[TimelinePage | null, string]> = [
    [present, 'present'],
    [client, 'present'],
    [other, 'absent'],
    [{ entries: [] } as unknown as TimelinePage, 'absent'],
    [null, 'unknown'],
    [{ ...present, hasOlder: true }, 'unknown'],
    [{ ...present, gap: true }, 'unknown'],
    [{ ...present, staleCursor: true }, 'unknown'],
    [{ ...present, reset: true }, 'unknown'],
  ];
  for (const [page, expected] of cases) assert.equal(timelineMessage(page, 'm'), expected, expected);
});
