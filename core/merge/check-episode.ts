import { REQUIRED_CHECK_ESCALATION_MS } from '../forge/index';
import type { OverdueCheckEvidence } from '../resolution';

/**
 * The durable record of one required-check wait at one reviewed head: the poll
 * cadence, the incident that owns the episode, the overdue check it is waiting
 * on, its one recovery run and the escalation it already raised. Possession of
 * this record — not the wording of the task's reason — is what makes a check
 * wait an episode.
 */
export type RequiredCheckPollState = {
  head: string;
  nextAt: number;
  incidentId?: string | null;
  overdueCheck?: OverdueCheckEvidence;
  firstOverdueAt?: number;
  recoveryRunId?: string | null;
  attentionRaisedAt?: number | null;
};

/** What one pass of the pending-check wait does with the task. */
export type CheckEpisodeStep =
  /** Leave the visible episode exactly as it is; record nothing. */
  | 'hold'
  /** Park the recovery episode but keep the check wait visible. */
  | 'park'
  /** Raise the same check incident to the coordinator: its one recovery did not clear it. */
  | 'escalate'
  /** Raise operator attention for a wait no recovery has looked at yet. */
  | 'attention'
  /** Keep waiting on the durable cadence. */
  | 'wait';

export type CheckEpisodeFacts = {
  overdue: boolean;
  /** The task currently carries attention from this wait. */
  attention: boolean;
  /** The incident recorded for this head's episode, when one is recorded. */
  incidentId: string | null;
  /** The one recovery run this episode dispatched, when it did. */
  recoveryRunId: string | null;
  /** That recovery run has released: its look at the check is over. */
  recoveryFinished: boolean;
  /** The overdue check is still queued for a runner. */
  checkStillQueued: boolean;
  /** How long the first overdue observation of this exact check has been waited on. */
  waitedMs: number;
  /** When this episode's escalation was raised; null while it never was. */
  attentionRaisedAt: number | null;
};

/**
 * The one decision behind the pending-check wait: a finished recovery escalates
 * a still-queued check once past the escalation bound, parks itself otherwise,
 * and yields to a visible attention state it did not raise. A wait no recovery
 * has looked at yet raises attention; everything else keeps its durable cadence.
 */
export function checkEpisodeStep(facts: CheckEpisodeFacts): CheckEpisodeStep {
  if (!facts.overdue) return facts.attention ? 'park' : 'wait';
  if (!facts.recoveryFinished) return !facts.recoveryRunId && !facts.attention && !facts.incidentId ? 'attention' : 'hold';
  if (!facts.checkStillQueued) return 'park';
  if (!facts.attentionRaisedAt) return facts.waitedMs >= REQUIRED_CHECK_ESCALATION_MS ? 'escalate' : 'park';
  return facts.attention ? 'hold' : 'wait';
}
