import type { ControlResponseEnvelopeDto } from "./envelopes";
import type {
  ControlSelectedTaskCommandAdmissionCommandDto,
  ControlSelectedTaskCommandAdmissionDto,
} from "./taskWorkflow";
import type { ControlSelectedTaskReviewOutcomeRouteNoEffectsDto } from "./selectedTaskReviewOutcomeRoute";

export type ControlSelectedTaskCompletionRouteApplyRefusalDto = {
  kind: string;
  reason: string;
};

export type ControlSelectedTaskCompletionRouteApplyDto = {
  apply_id: string;
  project_id: string;
  task_id: string;
  route_admission_id: string;
  route_id: string;
  review_decision_ref: string | null;
  status: "admitted" | "refused" | string;
  command: ControlSelectedTaskCommandAdmissionCommandDto | null;
  command_admission: ControlSelectedTaskCommandAdmissionDto | null;
  refusal: ControlSelectedTaskCompletionRouteApplyRefusalDto | null;
  evidence_refs: string[];
  operator_ref: string;
  no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto;
};

type QueryFallback =
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export type SelectedTaskCompletionRouteApplyQueryResult =
  | {
      state: "record";
      apply: ControlSelectedTaskCompletionRouteApplyDto;
    }
  | QueryFallback;

export function selectedTaskCompletionRouteApplyFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskCompletionRouteApplyQueryResult {
  switch (response.body.type) {
    case "selected_task_completion_route_apply":
      return {
        state: "record",
        apply: response.body.apply,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return { state: "unsupported", reason: response.body.reason };
    case "error":
      return {
        state: "error",
        kind: response.body.kind,
        reason: response.body.reason,
      };
    default:
      return {
        state: "unexpected",
        reason: `unexpected selected task completion route apply response: ${response.body.type}`,
      };
  }
}
