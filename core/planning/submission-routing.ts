import type { Engine } from "../engine";
import type { Submission } from "../../shared/contracts";
import { hostKindOf } from "../../shared/host-kind";
import { ProtocolError } from "../../shared/service/protocol";

/** The same review-routing refusal applies to checks, dry runs and intake. */
export function assertSubmissionRouting(
  engine: Pick<Engine, "independentReviewRoutingRefusal"> & Partial<Pick<Engine, "submissionRoutingRefusal">>,
  submission: Submission,
): void {
  const refusal = engine.submissionRoutingRefusal ? engine.submissionRoutingRefusal(submission) : engine.independentReviewRoutingRefusal(submission);
  if (refusal) throw new Error(refusal);
}

/** Keep BB caller ingress availability consistent between dry runs and acceptance. */
export function assertBbSubmissionIngressAvailable(
  engine: Pick<Engine, "hostIngressAvailable">,
  explicitHostId?: string,
  plannerHostId?: string,
): string | undefined {
  const explicitBbHostId =
    explicitHostId && hostKindOf(explicitHostId) === "bb"
      ? explicitHostId
      : undefined;
  if (explicitBbHostId && plannerHostId !== explicitBbHostId)
    throw new ProtocolError(
      "invalid_input",
      `Selected BB submission host ${explicitBbHostId} must match the verified caller identity`,
    );

  const bbIngressHostId =
    plannerHostId && hostKindOf(plannerHostId) === "bb"
      ? plannerHostId
      : explicitBbHostId;
  if (bbIngressHostId && !engine.hostIngressAvailable(bbIngressHostId))
    throw new ProtocolError(
      "invalid_input",
      `Selected submission host ${bbIngressHostId} is offline or unavailable for ingress`,
    );
  return bbIngressHostId;
}
