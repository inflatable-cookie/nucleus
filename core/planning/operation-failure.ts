import { RepositoryRekeyRefused } from "./repository-rekey";
import { ReviewEntryRefusal } from "../review/review-entry";
import { RestartRefusal } from "../verbs/owner-verbs";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { ProvenPreSendRefusalError, RetainedRunRefusal } from "../recovery/task-reasons";
import { ExternalMergeRefusal } from "../verbs/moves";
import { ParkedRestartPreSendRefusal } from "../verbs/restart";

/** Prose classifier for unexplained failures only; typed pre-binding refusals never reach it. */
const uncertainOperationError = (message: string) => /uncertain|unknown|timed out|timeout|connection|socket|transport|interrupted|ambiguous/i.test(message);
/**
 * A typed refusal is Queue's own gate answering before any effect: the class
 * carries the proof that nothing was bound or sent, whatever the prose says.
 * Classification reads that proof, never the diagnostic's words (papercut
 * 4b285a6e: the retained-run gate's own "uncertain delivery" prose settled a
 * definite pre-send refusal as an unknown delivery). An untyped failure keeps
 * the prose classifier and the pre-send boundary evidence.
 */
export const typedPreSendRefusal = (error: unknown): boolean =>
  error instanceof ProvenPreSendRefusalError || error instanceof ReviewEntryRefusal
  || error instanceof ExternalMergeRefusal || error instanceof RestartRefusal || error instanceof RepositoryRekeyRefused
  || error instanceof RetainedRunRefusal || error instanceof ParkedRestartPreSendRefusal || error instanceof DurableFenceRefusal;

/**
 * How one failed operation settles, from the facts `runOperation` re-reads after
 * the throw. A handler may have committed its own durable result; a submission
 * or review entry may defer validation; Queue's own pre-send refusal keeps its
 * proof; and everything else settles from its pre-send boundary evidence, never
 * from prose alone. The caller applies the effects in this order.
 */
export type OperationFailureSettlement =
  | { kind: "already_committed" }
  | { kind: "defer_git_transient" }
  | { kind: "defer_validation" }
  | { kind: "settle";
      /** The pre-send receipt that proves the refusal, when one applies. */
      receipt: "parked_restart" | "typed_refusal" | null;
      state: "failed" | "needs_attention";
      /** `keep` retains the effect the settled record already holds. */
      effect: "reconciled" | "uncertain" | "keep" | null };
/**
 * A recorded pre-send receipt always belongs to a typed refusal, and both settle
 * failed, so the settlement does not depend on whether the receipt write itself
 * succeeded. `deferGitTransient` is asked only where today's order asks it: after
 * the committed result, before any other deferral, and only for a submission or
 * review entry.
 */
export function operationFailureSettlement(facts: {
  /** The handler committed its result with a reconciled effect before any send boundary. */
  committed: boolean;
  /** The failed operation is a submission or a review entry. */
  submissionDeferrable: boolean;
  /** A transport failure or `SubmissionUnavailableError` left validation unread. */
  validationUnavailable: boolean;
  /** Every proof a parked restart's rollback receipt requires. */
  parkedRestartProven: boolean;
  /** Every proof any other typed pre-send refusal's receipt requires. */
  typedRefusalProven: boolean;
  /** Queue's own gate answered before anything was bound or sent. */
  typedPreSendRefusal: boolean;
  /** A send boundary was crossed, so only observed evidence settles it. */
  preSendBoundaryStarted: boolean;
  /** The retry was refused by an owned-tool hold, which is definite whatever its prose. */
  ownedToolRetryRefused: boolean;
  /** A source promotion whose own insert is provably absent refused before committing. */
  sourcePromotionAbsent?: boolean;
  /** The settled record's effect changed since its intent, so no failure may rewrite it. */
  effectChangedSinceIntent: boolean;
  hasEffect: boolean;
  message: string;
}, deferGitTransient: () => boolean): OperationFailureSettlement {
  // A handler may atomically commit its durable operation with its local
  // transition. A later reporting failure cannot undo that committed result.
  if (facts.committed) return { kind: "already_committed" };
  if (facts.submissionDeferrable && deferGitTransient()) return { kind: "defer_git_transient" };
  if (facts.submissionDeferrable && facts.validationUnavailable) return { kind: "defer_validation" };
  // Record the proof before settlement; an interrupted writer is fenced on restart.
  const receipt = facts.parkedRestartProven ? "parked_restart" as const
    : facts.typedRefusalProven ? "typed_refusal" as const : null;
  // A parked restart's refusal is raised by read-only verification or a
  // transaction that rolls back, so the typed refusal itself is the proof that
  // nothing was bound or sent. Its own prose never decides attention, and a
  // receipt it could not record leaves a definite refusal definite (papercut
  // 4b285a6e). A fence refusal (`DurableFenceRefusal`) is the same definite
  // class: its prose — "its delivery is unknown" and kin — never re-classifies
  // Queue's own pre-send refusal as an unknown effect.
  const state = facts.ownedToolRetryRefused || facts.sourcePromotionAbsent ? "failed"
    : facts.preSendBoundaryStarted && !facts.typedPreSendRefusal ? "needs_attention"
    : facts.typedPreSendRefusal ? "failed"
    : uncertainOperationError(facts.message) ? "needs_attention" : "failed";
  const effect = facts.effectChangedSinceIntent ? "keep" as const
    : !facts.hasEffect ? null : state === "needs_attention" ? "uncertain" as const : "reconciled" as const;
  return { kind: "settle", receipt, state, effect };
}

