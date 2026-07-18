import { parseSingleRecordResponse, type QueryFallback } from "./singleRecordResponse";
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

export type SelectedTaskCompletionRouteApplyQueryResult =
  | {
      state: "record";
      apply: ControlSelectedTaskCompletionRouteApplyDto;
    }
  | QueryFallback;

export function selectedTaskCompletionRouteApplyFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskCompletionRouteApplyQueryResult {
  return parseSingleRecordResponse(response, "selected_task_completion_route_apply", "selected task completion route apply", (body) => ({
    state: "record" as const,
    apply: body.apply,
  }));
}
