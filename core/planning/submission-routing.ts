import type { Engine } from "../engine";
import type { Submission } from "../../shared/contracts";

/** The same review-routing refusal applies to checks, dry runs and intake. */
export function assertSubmissionRouting(engine: Pick<Engine, "independentReviewRoutingRefusal">, submission: Submission): void {
  const refusal = engine.independentReviewRoutingRefusal(submission);
  if (refusal) throw new Error(refusal);
}
