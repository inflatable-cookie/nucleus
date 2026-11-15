import type { OwnerAcceptanceRecord, Task } from "../../shared/contracts";
import type { Store } from "../store/store";
import type { Resolution } from "../resolution";
import { mergedWithNonePatch } from "../recovery/task-reasons";

/**
 * The one owner of recording an observed external merge on a task.
 *
 * A merge is observed on two paths - an operator acceptance that proved its
 * source, and the automatic probe that found the PR merged - and both end in
 * the same facts: the merged head and commit, the none-patch the merge verdict
 * needed, the integration turn that decides whether closeout may start now, the
 * recovery episode the merge settles, and the recorded task head. Only whether
 * this observation may move the recorded head differs, so that is the one input
 * that is not derived here.
 *
 * Safe inside a transaction: it reads and writes the store through the same
 * resolution every caller already holds.
 */
export interface ObservedMergeContext {
  store: Pick<Store, "event">;
  resolution: Pick<Resolution, "assignIntegrationTurn" | "hasEarlierIntegrationTurn" | "update"> & {
    /** Only the episode settlement the caller's own recovery context supplies. */
    recovery: Pick<Resolution["recovery"], "settledEpisodeChanges">;
  };
}

export interface ObservedMergeInput {
  /** The head the forge reported merged. */
  head: string;
  /** The merge commit it reported. */
  commit: string;
  /**
   * Whether this observation may set the recorded task head. A fresh probe does;
   * a re-entry for an already-recorded merge does not, because the accepted route
   * already decided it: an ordinary acceptance recorded the merged head at
   * `prHead`, while a never-dispatched review-entry acceptance deliberately kept
   * the recorded source head and put the merged head in `mergeHead` (task 408).
   */
  recordHead: boolean;
  /** The exact-final-head acceptance recorded beside the merge, when the route derived one. */
  acceptance?: OwnerAcceptanceRecord | null;
  /** Whether an episode one of the superseded runs held closes with this merge. */
  settleEpisode: boolean;
  episodeDetail: string;
  /** The visible reason per integration-turn state. */
  reason: { holding: string; waiting: string };
}

/** Record one observed external merge, its acceptance and the episode it settles. */
export function recordObservedMerge(context: ObservedMergeContext, current: Task, input: ObservedMergeInput): Task {
  const acceptance = input.acceptance ?? null;
  const latest = context.resolution.assignIntegrationTurn(current);
  const holding = !context.resolution.hasEarlierIntegrationTurn(latest);
  const headPatch = input.recordHead ? { prHead: input.head } : {};
  // Every unreleased run is released by the caller, so an episode one of them held
  // closes here: the merge is the outcome its coordinator was recovering toward (Queue #680).
  const episode = input.settleEpisode ? context.resolution.recovery.settledEpisodeChanges(latest, input.episodeDetail) : null;
  const updated = context.resolution.update(latest, {
    externalMerge: true, mergeHead: input.head, mergedCommit: input.commit, currentRunId: null, attention: false, externalMergePreAttention: null,
    ...(acceptance ? {} : mergedWithNonePatch(latest, input.head)),
    ...(acceptance ? { ownerAcceptances: [...(latest.resolution.ownerAcceptances ?? []), acceptance] } : {}),
    ...(episode ?? {}),
  }, holding
    ? { phase: "syncing", ...headPatch, coordinatorGeneration: latest.coordinatorGeneration + 1, reason: input.reason.holding }
    : { phase: "merging", ...headPatch, reason: input.reason.waiting }, "external_merge_observed");
  if (episode) context.store.event(latest.id, "recovery_episode_settled", input.episodeDetail);
  return updated;
}
