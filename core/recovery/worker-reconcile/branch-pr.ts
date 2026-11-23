import type { Task } from "../../../shared/contracts";
import {
  clearLiveEvidence,
  liveEvidenceEpisode,
  recordLiveEvidenceFailure,
} from "../../machine/live-evidence";
import { now } from "../../store/store";
import { propagateQuantumDeferral } from "../../scheduling/pass-snapshot";
import type { WorkerReconcileContext } from "./context";
import { branchPrLookupOutcome } from "./decisions";

/**
 * The pre-recovery lookup for the queue branch's open PR. One owner of the
 * backoff schedule, the lookup stamp and the three answers a lookup can give:
 * an empty result, an exact match, or an identity that is unverified or
 * ambiguous. Unknown is never absence.
 */

/**
 * Papercut fa4a53a7: repeated pre-PR branch lookups back off in idle-grace
 * steps — 1, 2, 5, 15, then 60 minutes at the production grace — resetting on
 * any new worker activity, so a blocked lane cannot crowd task detail with an
 * unchanged lookup pair every minute.
 */
const BRANCH_PR_LOOKUP_BACKOFF_STEPS = [1, 2, 5, 15, 60];

/**
 * Whether the queue-owned branch reconciliation may run again. A first empty
 * result is evidence for one moment, not a permanent verdict: the worker can
 * open its PR seconds later, and a lane that retires its only repair
 * instrument can no longer be repaired without an operator. Repeats back off
 * in idle-grace steps (papercut fa4a53a7) — 1, 2, 5, 15, then 60 minutes at
 * the production grace — and the schedule resets on any new worker activity,
 * the same observations that clear `idleSince`.
 */
export function branchPrLookupDue(
  engine: WorkerReconcileContext,
  task: Task,
): boolean {
  const state = task.prLookup;
  // Null or a reset stamp (attempts 0): the next lookup is immediate, still
  // behind the reconciliation's own readiness gates.
  if (!state || state.attempts === 0) return true;
  const steps = BRANCH_PR_LOOKUP_BACKOFF_STEPS;
  const step = steps[Math.min(state.attempts - 1, steps.length - 1)];
  return Date.now() - Date.parse(state.lastAt) >= step * engine.idleGraceMs;
}

/** Look for the queue branch's open PR before coordinator recovery. True ends the pass. */
export async function reconcileBranchPr(
  engine: WorkerReconcileContext,
  current: Task,
): Promise<boolean> {
  const { store, adapter, resolution } = engine;
  if (!adapter.findOpenBranchPr) {
    // Rule 5, capability absent: proceed on Queue's own knowledge and
    // record once that the live check was unavailable, so a later reader
    // cannot mistake the decision for a confirmed absence.
    if (
      !store
        .events(current.id)
        .some((event) => event.kind === "initial_pr_lookup_unavailable")
    ) {
      store.event(
        current.id,
        "initial_pr_lookup_unavailable",
        `Open-PR live check for ${current.branch} is unavailable; deciding from Nucleus's own knowledge`,
      );
    }
    return false;
  }
  // Papercut fa4a53a7: the event pair is recorded only when the outcome
  // changes (for example empty to found); an unchanged result coalesces
  // onto the task's lookup stamp so real events keep their place.
  let matches: { number: number; url: string; head: string }[] | null = null;
  let lookupError: unknown = null;
  try {
    matches = await adapter.findOpenBranchPr(current);
  } catch (error) {
    propagateQuantumDeferral(error);
    lookupError = error;
  }
  const previousOutcome = current.prLookup?.outcome ?? null;
  const attempts = (current.prLookup?.attempts ?? 0) + 1;
  const stamp = (outcome: "empty" | "found" | null) => {
    current = store.update(current.id, {
      prLookup: {
        attempts,
        lastAt: now(),
        outcome: outcome ?? previousOutcome,
      },
    });
  };
  const outcome = branchPrLookupOutcome(
    lookupError,
    lookupError !== null ? 0 : matches!.length,
  );
  if (outcome === "unverified") {
    stamp(null);
    // Rule 5: a failed, timed-out, refused or unavailable read is
    // `unverified`, never absence. Hold quietly inside the bounded
    // grace, retry after it, and produce at most one notice if the
    // failure persists, with the failure recorded on the escalation.
    const hold = recordLiveEvidenceFailure(
      store,
      current.id,
      "branch-pr",
      lookupError,
      engine.idleGraceMs,
    );
    if (hold === "notice") {
      const summary = `Open-PR live check for ${current.branch} is unverified (${liveEvidenceEpisode(store, current.id, "branch-pr")?.error}); holding for retry rather than treating the PR as absent`;
      resolution.attention(current, summary);
      resolution.recovery.escalate(store.task(current.id), summary);
    }
    return true;
  }
  clearLiveEvidence(store, current.id, "branch-pr");
  if (outcome === "ambiguous") {
    stamp(null);
    // Rule 5, ambiguity: more than one match is real identity conflict
    // and needs a human. Escalate naming the candidate identities as
    // operational uncertainty; no coordinator run is spent on it.
    const candidates = matches!
      .map((match) => `#${match.number} (${match.url} @ ${match.head})`)
      .join(", ");
    const summary = `Multiple open PRs use queue branch ${current.branch}: ${candidates}. Exact identity is ambiguous; this is operational uncertainty for the operator, not coordinator judgment. No PR was adopted and no resource was created.`;
    if (
      current.resolution.recovery?.status !== "escalated" ||
      current.resolution.recovery.summary !== summary
    ) {
      resolution.attention(current, summary);
      resolution.recovery.escalate(store.task(current.id), summary);
    }
    return true;
  }
  if (outcome === "found") {
    stamp("found");
    if (previousOutcome !== "found")
      store.event(
        current.id,
        "initial_pr_lookup",
        "Checking the queue-owned branch for an exact open PR before coordinator recovery",
      );
    await resolution.adoptReplacementPr(
      store.task(current.id),
      matches![0].number,
    );
    return true;
  }
  stamp("empty");
  if (previousOutcome !== "empty") {
    store.event(
      current.id,
      "initial_pr_lookup",
      "Checking the queue-owned branch for an exact open PR before coordinator recovery",
    );
    store.event(
      current.id,
      "initial_pr_lookup_empty",
      `No open PR found for ${current.branch}`,
    );
  }
  return false;
}
