import { type Store } from "../store/store";

/**
 * Live-evidence fetch policy (Spec 016 rules 4-5, Contract 003).
 *
 * The rule-4 facts this lane may read live are closed: the open PR on the
 * queue-owned branch (at the branch-PR decision point) and the retained
 * worker's current binding and stopped state (before a reporting-identity
 * mismatch escalation). Every other fact decides from Queue's own knowledge.
 *
 * A read that fails, times out, is refused or is unavailable yields
 * `unverified`, never absence. The episode below is that outcome made durable:
 * a failed read holds quietly inside its bounded grace and retries, coalesced
 * per task identity, with at most one notice if it persists. A successful read
 * clears the episode. Ambiguity is not an episode: more than one match is real
 * identity conflict and escalates at once.
 */

export type LiveEvidenceFact = "branch-pr" | "reporting-binding";

export interface LiveEvidenceEpisode {
  fact: LiveEvidenceFact;
  /** First failed read; the bounded grace is measured from here. */
  since: string;
  /** First failure text, pinned so repeated observations coalesce per identity. */
  error: string;
  /** Whether the persisting failure has produced its single notice. */
  noticed: boolean;
}

const metaKey = (taskId: string, fact: LiveEvidenceFact) => `liveEvidence:${fact}:${taskId}`;

const failureKind = (fact: LiveEvidenceFact) =>
  fact === "branch-pr" ? "initial_pr_lookup_unverified" : "reporting_binding_unverified";

const persistsKind = (fact: LiveEvidenceFact) =>
  fact === "branch-pr" ? "initial_pr_lookup_unverified_persists" : "reporting_binding_unverified_persists";

export function liveEvidenceEpisode(store: Store, taskId: string, fact: LiveEvidenceFact): LiveEvidenceEpisode | null {
  return store.getMeta<LiveEvidenceEpisode>(metaKey(taskId, fact)) ?? null;
}

/** A successful live read clears the unverified episode for that fact. */
export function clearLiveEvidence(store: Store, taskId: string, fact: LiveEvidenceFact): void {
  if (store.getMeta(metaKey(taskId, fact)) !== undefined) store.deleteMeta(metaKey(taskId, fact));
}

export type UnverifiedHold = "quiet" | "notice" | "noticed";

/**
 * Record a failed, timed-out, refused or unavailable live read as
 * `unverified`. Returns `quiet` while the bounded grace holds, `notice` once
 * when the failure persists past it, and `noticed` for every later failure so
 * the lane produces at most one notice per episode. Never records absence.
 */
export function recordLiveEvidenceFailure(
  store: Store, taskId: string, fact: LiveEvidenceFact, error: unknown, graceMs: number, at = Date.now(),
): UnverifiedHold {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  let episode = liveEvidenceEpisode(store, taskId, fact);
  if (!episode) {
    episode = { fact, since: new Date(at).toISOString(), error: message, noticed: false };
    store.setMeta(metaKey(taskId, fact), episode);
    store.event(taskId, failureKind(fact), `${fact} live check is unverified, not absent: ${message}`);
    return "quiet";
  }
  if (episode.noticed) return "noticed";
  if (at - Date.parse(episode.since) < graceMs) return "quiet";
  episode = { ...episode, noticed: true };
  store.setMeta(metaKey(taskId, fact), episode);
  store.event(taskId, persistsKind(fact), `${fact} live check still unverified after the bounded grace: ${episode.error}`);
  return "notice";
}
