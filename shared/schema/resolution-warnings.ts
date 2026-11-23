import { z } from "zod";

/** The warning IDs a Spec 067 explicit command names; a caller accepts them by ID. */
export const resolutionWarningId = z.enum([
  "live_turn",
  "unreported_result",
  "hold_owner",
  "effect_may_land",
  "owned_tool",
  "duplicate_thread",
  "two_writers",
  "head_mismatch",
  "budget",
  "route_policy",
  "live_runs",
  "queued",
  "no_thread",
  "turn_held",
  "merge_in_flight",
  "checks",
  "holds",
  "unverified_merge",
  "unreviewed_merge",
  "no_verdict",
  // A reviewer run already reported a verdict at the current head that has not
  // been applied; replacing or superseding it would discard that verdict.
  "discard_reported_verdict",
  // The host may still answer the create command of this role's uncertain run;
  // a new run could stand beside the thread that late answer brings (Spec 068).
  "creation_in_flight",
  // record.clear kind=workspace_intent: the uncertain workspace may exist on
  // the host; the next dispatch binds or recreates the same branch and worktree.
  "workspace_may_exist",
]);

/**
 * Warnings only the task's live responsible planner or the operator board may
 * accept (Spec 067 authority). A coordinator that names one is refused: a second
 * budget spend, the revision cap and the replacement ceiling (`budget`) are the
 * planner's disposition, as the author-round rule already holds
 * (`assertAuthorRevisionAllowance`). `bin/explicit-outcome.mjs` marks the same IDs.
 */
type WarningId = z.infer<typeof resolutionWarningId>;
export const PLANNER_ONLY_WARNINGS: ReadonlySet<WarningId> = new Set<WarningId>([
  "hold_owner",
  "route_policy",
  "two_writers",
  // Spec 068 §3: a coordinator started before the wait could otherwise accept
  // a second thread beside a create the host may still answer.
  "creation_in_flight",
  "budget",
  "unreviewed_merge",
]);
