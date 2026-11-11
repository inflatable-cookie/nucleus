import type { Task } from '../../shared/contracts';
import type { Resolution } from '../resolution';
import { stages } from './task-reasons';
import { now } from '../store/store';
import { coordinatorReportMatches } from './recovery';
import { latestAuthorResult } from '../verbs/owner-verbs';
import { blockerLadderStep as decideBlockerLadderStep, plannerEscalations, reviewerConsults, blockerCauseId, stalledUnknownEscalation, type LadderEvent } from '../questions/blocker-ladder';
import { DEFAULT_STALL_THRESHOLD_MINUTES } from '../../shared/schema/settings';
import { advanceFailureDisposition } from './resolution-decisions';
import { isTransportFailure } from '../../shared/transport';
import { classifyGitTransientFailure, classifyGitCommandFailure, ForgeOutageError } from '../forge/forge-health';
import { GitReadTimeoutError } from '../git/index';
import { LoginSessionFaultError, isLoginSessionFault } from '../../shared/session-fault';

export type RecoveryLifecycleContext = Pick<Resolution, 'attention' | 'attentionUnknownEscalation' | 'environmentDeferred' | 'gitTransientFailure' | 'responsibleBlockerLadder' | 'store' | 'update' | 'waiting'> & {
  replayHeldAttention(t: Task): Promise<Task | null>;
};

export class RecoveryLifecycle {
  constructor(readonly context: RecoveryLifecycleContext) {}
  supersedeEarlierRecovery(t: Task): Task {
    // Progress supersedes an old recovery episode once it no longer owns a
    // run or attention. Keep explicit planner and owner waits intact.
    const oldRecovery = t.resolution.recovery;
    if (stages.includes(t.phase) && oldRecovery?.status === 'escalated'
      && oldRecovery.progress && !coordinatorReportMatches(t) && !t.resolution.recoveryActive && !t.resolution.attention
      && !['escalated', 'responsible_question', 'budget', 'paused_stop'].includes(t.resolution.stop?.reason ?? '')
      && (!oldRecovery.runId || this.context.store.run(oldRecovery.runId)?.released)) {
      const incident = t.resolution.incident;
      t = this.context.update(t, { recovery: { ...oldRecovery, status: 'resolved', summary: 'Superseded by later task progress' },
        ...(incident && incident.id === oldRecovery.incidentId ? { incident: { ...incident, status: 'resolved', detail: 'Superseded by later task progress', updatedAt: now() } } : {})
      }, {}, 'recovery_episode_superseded', 'Later task progress superseded the earlier recovery');
    }
    return t;
  }
  async blockerLadderStep(t: Task): Promise<Task | null> {
    // Spec 058 slice 17: a parked blocked responsible task climbs the ladder once
    // per receipt — the repository hook and the ordinary park have already run, so
    // this is classification after the fact, never a second emission. A provider
    // failure never enters the ladder, and a source-approved proof round stays the
    // proof wait's own episode.
    const completion = latestAuthorResult(t, this.context.store.runs(t.id));
    const events = this.context.store.eventsAll(t.id);
    const classified = Boolean(completion && events.some(event => event.kind === 'blocker_ladder_classified' && event.detail.startsWith(`${completion.eventId}:`)));
    // Papercut 2ef86450: an escalation nobody observed delivering is never resent,
    // but past the stall threshold it must surface instead of waiting invisibly.
    const thresholdMs = (this.context.store.getMeta<number>('stallThresholdMinutes') ?? DEFAULT_STALL_THRESHOLD_MINUTES) * 60_000;
    const escalations = plannerEscalations(events as LadderEvent[]);
    const unknownStall = stalledUnknownEscalation({ escalations, now: Date.now(), thresholdMs });
    const first = decideBlockerLadderStep({
      classified,
      completion,
      escalations,
      consults: reviewerConsults(events as LadderEvent[]),
      unknownStall,
    });
    if (first.kind === 'classify' && completion) {
      this.context.store.event(t.id, 'blocker_ladder_classified', `${completion.eventId}: ${blockerCauseId(t.id, completion)}`);
      if (await this.context.responsibleBlockerLadder(this.context.store.task(t.id), { source: 'worker', runId: completion.runId, completion })) return null;
    } else if (first.kind === 'attention') {
      this.context.attentionUnknownEscalation(t, first.escalation);
      return null;
    } else if (first.kind === 'wait') {
      this.context.waiting(t, first.detail, 'escalated');
      return null;
    } else if (first.kind === 'continue') {
      return t;
    }
    // The ladder's park is durable. While a consult or planner escalation is still
    // open, re-assert its escalated wait so no later wait-stamp can strand the
    // ladder behind an operator stop.
    const ladderEvents = this.context.store.eventsAll(t.id);
    const after = decideBlockerLadderStep({
      classified: true,
      completion,
      escalations: plannerEscalations(ladderEvents as LadderEvent[]),
      consults: reviewerConsults(ladderEvents as LadderEvent[]),
      unknownStall: stalledUnknownEscalation({ escalations: plannerEscalations(ladderEvents as LadderEvent[]), now: Date.now(), thresholdMs }),
    });
    if (after.kind === 'attention') { this.context.attentionUnknownEscalation(t, after.escalation); return null; }
    if (after.kind === 'wait') { this.context.waiting(t, after.detail, 'escalated'); return null; }
    return t;
  }
  attentionReplayApplies(t: Task): boolean {
    return t.resolution.attention && !(t.resolution.mergeIntent && !t.resolution.mergedCommit);
  }
  replayHeldAttention(t: Task): Promise<Task | null> { return this.context.replayHeldAttention(t); }
  settleAdvanceFailure(t: Task, error: unknown, observedRunId: string | null, supersededBy: (current: Task) => string | null): void {
    const current = this.context.store.task(t.id);
    const uncertainCurrentSend = current.resolution.currentRunId
      ? this.context.store.run(current.resolution.currentRunId)?.status === 'uncertain'
      : false;
    const disposition = advanceFailureDisposition({
      message: error instanceof Error ? error.message : String(error),
      errorText: String(error),
      successor: current.resolution.mergeIntent ? null : supersededBy(current),
      mergeIntent: current.resolution.mergeIntent,
      mergedCommit: current.resolution.mergedCommit,
      mergeResponseOutcome: current.resolution.mergeResponseOutcome,
      mergedIdentityDiffers: error instanceof Error && error.message === 'Merged PR identity differs from the approved task',
      uncertainCurrentSend,
      transientSendFault: isTransportFailure(error) || classifyGitTransientFailure(error) === 'network' || classifyGitCommandFailure(error) === 'network',
      forgeOutage: error instanceof ForgeOutageError,
      gitReadTimeout: error instanceof GitReadTimeoutError,
      loginSessionFault: error instanceof LoginSessionFaultError || isLoginSessionFault(error),
    }, () => Boolean(this.context.gitTransientFailure?.(current, error)));
    switch (disposition.kind) {
      case 'superseded_attempt':
        this.context.store.event(current.id, 'superseded_attempt_failure', JSON.stringify({ observedRunId, supersededBy: disposition.successor, currentRunId: current.resolution.currentRunId, error: (error instanceof Error ? error.message : String(error)).slice(0, 1500) }));
        return;
      case 'git_transient': return;
      case 'wait': this.context.waiting(current, disposition.reason, disposition.stop); return;
      case 'environment': this.context.environmentDeferred(current, error); return;
      case 'attention': this.context.attention(current, disposition.reason); return;
      case 'merge_response_uncertain':
        this.context.update(current, { mergeResponseOutcome: 'uncertain' }, {}, 'merge_response_uncertain', disposition.detail);
        this.context.waiting(this.context.store.task(current.id), 'Merge response is uncertain; checking GitHub before considering one guarded re-issue', 'lifecycle');
        return;
    }
  }
}
