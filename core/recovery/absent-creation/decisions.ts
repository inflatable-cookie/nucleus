import { holdsOf, type Run, type Task } from '../../../shared/contracts';

/**
 * The pure decisions of absence: whether an unowned workspace creation may be
 * replayed, and which absent-worker step the already-read facts select. Both
 * take facts and answer; neither reads the store or the host.
 */

/** Facts needed before an unowned workspace creation may be replayed. A parked
 * refusal for this exact classified state stands where the dispatching phase
 * would: the stop exists because the proven orphan was not yet removed, its
 * detail names the replay as the exit, and nothing else holds the task — so the
 * same recovery path clears it and replays once (nucleus#1106). */
export function workspaceReplayAllowed(task: Task, kind: string, canRemoveOrphan: boolean, hasRuns: boolean, replayRecorded: boolean, parkedRefusal?: string | null): boolean {
  const parked = task.phase === 'needs_attention' && !task.resolution.attention && !holdsOf(task).dispatch
    && Boolean(parkedRefusal) && task.resolution.stop?.detail === parkedRefusal;
  return (kind === 'absent' || kind === 'partial' && canRemoveOrphan) &&
    (task.phase === 'dispatching' || parked) && !task.agentIntent && !task.agentId && !task.runId && !task.completion &&
    !task.prUrl && !task.prHead && !task.resolution.recoveryActive && !task.resolution.attention &&
    (!task.resolution.incident || task.resolution.incident.status === 'resolved') &&
    (!task.resolution.recovery || task.resolution.recovery.status === 'resolved') && !hasRuns && !replayRecorded;
}

/** Choose the next absent-worker step from facts available at this point.
 * A missing replacement budget requests that read only after the grace gate. */
export function absentWorkerStep(facts: { launchRetry: boolean; retryDue: boolean; matches: number; graceElapsed: boolean; replacementSpent?: boolean }):
  'wait' | 'launch_retry' | 'read_budget' | 'escalate' | 'ambiguous' | 'replace' {
  if (facts.launchRetry && facts.matches === 0) return facts.retryDue ? 'launch_retry' : 'wait';
  if (!facts.graceElapsed) return 'wait';
  if (facts.replacementSpent === undefined) return 'read_budget';
  if (facts.replacementSpent) return 'escalate';
  if (facts.matches > 1) return 'ambiguous';
  return 'replace';
}

/**
 * An uncertain creation an exact lookup proved produced no agent. It is
 * settled as absent: never resent, no longer a blocking recovery effect, and
 * replaceable by an owner `route now` or `restart` from the current route.
 */
export const provenAbsentCreation = (run: Run): boolean =>
  run.status === 'uncertain' && !run.agentId && Boolean(run.absentProvenAt);
