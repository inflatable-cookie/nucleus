import { RepositoryRekeyRefused } from "./repository-rekey";
import { ReviewEntryRefusal } from "../review/review-entry";
import { RestartRefusal } from "../verbs/owner-verbs";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { ProvenPreSendRefusalError, RetainedRunRefusal } from "../recovery/task-reasons";
import { ExternalMergeRefusal } from "../verbs/moves";
import { PreWriteMergeObservationRefusal } from "../verbs/moves/merge";
import { isHostConnectionRefusal } from "../host/errors";

/** Prose classifier for unexplained failures only; typed pre-binding refusals never reach it. */
const uncertainOperationError = (message: string) => /uncertain|unknown|timed out|timeout|connection|socket|transport|interrupted|ambiguous/i.test(message);
/**
 * A typed refusal is Queue's own gate answering before any effect: the class
 * carries the proof that nothing was bound or sent, whatever the prose says.
 * Classification reads that proof, never the diagnostic's words (papercut
 * 4b285a6e: the retained-run gate's own "uncertain delivery" prose settled a
 * definite pre-send refusal as an unknown delivery). An untyped failure keeps
 * the prose classifier and the pre-send boundary evidence. A host call refused
 * by its own connection precondition (no authenticated connection, the executor
 * offline, a changed durable host identity) is the same proof from the adapter
 * side; its "connection" prose never makes it an unknown delivery.
 */
export const typedPreSendRefusal = (error: unknown): boolean =>
  error instanceof ProvenPreSendRefusalError || isHostConnectionRefusal(error) || error instanceof ReviewEntryRefusal
  || error instanceof ExternalMergeRefusal || error instanceof RestartRefusal || error instanceof RepositoryRekeyRefused
  || error instanceof RetainedRunRefusal || error instanceof DurableFenceRefusal
  || error instanceof PreWriteMergeObservationRefusal;

/**
 * How one failed operation settles, from the facts `runOperation` re-reads after
 * the throw. A handler may have committed its own durable result; a submission
 * or review entry may defer validation. Typed refusals settle as failures and
 * a crossed send boundary keeps other failures uncertain.
 */
export type OperationFailureSettlement =
  | { kind: "already_committed" }
  | { kind: "defer_git_transient" }
  | { kind: "defer_validation" }
  | { kind: "settle";
      state: "failed" | "needs_attention";
      /** `keep` retains the effect the settled record already holds. */
      effect: "reconciled" | "uncertain" | "keep" | null };
export function operationFailureSettlement(facts: {
  /** The handler committed its result with a reconciled effect before any send boundary. */
  committed: boolean;
  /** The failed operation is a submission or a review entry. */
  submissionDeferrable: boolean;
  /** A transport failure or `SubmissionUnavailableError` left validation unread. */
  validationUnavailable: boolean;
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
  const state = facts.ownedToolRetryRefused || facts.sourcePromotionAbsent ? "failed"
    : facts.preSendBoundaryStarted && !facts.typedPreSendRefusal ? "needs_attention"
    : facts.typedPreSendRefusal ? "failed"
    : uncertainOperationError(facts.message) ? "needs_attention" : "failed";
  const effect = facts.effectChangedSinceIntent ? "keep" as const
    : !facts.hasEffect ? null : state === "needs_attention" ? "uncertain" as const : "reconciled" as const;
  return { kind: "settle", state, effect };
}

