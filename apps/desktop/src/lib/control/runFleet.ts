import type { ControlOrchestrationRunStateCountDto } from "../control/generated/ControlOrchestrationRunStateCountDto";
import type { ControlOrchestrationRunSummaryDto } from "../control/generated/ControlOrchestrationRunSummaryDto";
import type { ControlResponseEnvelopeDto } from "./envelopes";
import { buildControlQueryEnvelope } from "./envelopes";
import { submitControlEnvelope } from "./client";

export type OrchestrationRunsQueryResult =
  | {
      state: "record";
      project_id: string;
      runs: ControlOrchestrationRunSummaryDto[];
      state_counts: ControlOrchestrationRunStateCountDto[];
    }
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export async function queryOrchestrationRuns(
  projectId: string,
): Promise<OrchestrationRunsQueryResult> {
  const response = await submitControlEnvelope(
    buildControlQueryEnvelope({
      kind: "orchestration_runs",
      query_id: "",
      action: "fleet",
      project_id: projectId,
    }),
  );
  return orchestrationRunsFromResponse(response);
}

export function orchestrationRunsFromResponse(
  response: ControlResponseEnvelopeDto,
): OrchestrationRunsQueryResult {
  switch (response.body.type) {
    case "orchestration_runs":
      return {
        state: "record",
        project_id: response.body.project_id,
        runs: response.body.runs,
        state_counts: response.body.state_counts,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return { state: "unsupported", reason: response.body.reason };
    case "error":
      return { state: "error", kind: response.body.kind, reason: response.body.reason };
    default:
      return {
        state: "unexpected",
        reason: `unexpected orchestration runs response: ${response.body.type}`,
      };
  }
}
