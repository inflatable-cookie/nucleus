import type { ControlResponseEnvelopeDto } from "./envelopes";
import type { ControlSelectedTaskCommandAdmissionDto } from "./taskWorkflow";
import type { ControlSelectedTaskReviewOutcomeRouteNoEffectsDto } from "./selectedTaskReviewOutcomeRoute";

export type ControlSelectedTaskRouteAdmissionRefusalDto = {
  kind: string;
  reason: string;
};

export type ControlSelectedTaskRouteAdmissionPreviewDto = {
  family: string;
  summary: string;
  source_refs: string[];
  evidence_refs: string[];
};

export type ControlSelectedTaskCompletionRouteAdmissionDto = {
  admission_id: string;
  project_id: string;
  task_id: string;
  route_id: string;
  route_candidate: string;
  decision_ref: string | null;
  status: "admitted" | "refused" | string;
  command_admission: ControlSelectedTaskCommandAdmissionDto | null;
  refusal: ControlSelectedTaskRouteAdmissionRefusalDto | null;
  evidence_refs: string[];
  no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto;
};

export type ControlSelectedTaskReworkDelegationRouteAdmissionDto = {
  admission_id: string;
  project_id: string;
  task_id: string;
  route_id: string;
  route_candidate: string;
  decision_ref: string | null;
  status: "admitted" | "refused" | string;
  rework_preview: ControlSelectedTaskRouteAdmissionPreviewDto | null;
  delegation_preview: ControlSelectedTaskRouteAdmissionPreviewDto | null;
  refusal: ControlSelectedTaskRouteAdmissionRefusalDto | null;
  work_item_refs: string[];
  evidence_refs: string[];
  no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto;
};

export type ControlSelectedTaskRouteAdmissionDto = {
  admission_id: string;
  project_id: string;
  task_id: string;
  route_id: string;
  completion: ControlSelectedTaskCompletionRouteAdmissionDto;
  rework_delegation: ControlSelectedTaskReworkDelegationRouteAdmissionDto;
  no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto;
};

type QueryFallback =
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export type SelectedTaskRouteAdmissionQueryResult =
  | {
      state: "record";
      admission: ControlSelectedTaskRouteAdmissionDto;
    }
  | QueryFallback;

export function selectedTaskRouteAdmissionFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskRouteAdmissionQueryResult {
  switch (response.body.type) {
    case "selected_task_route_admission":
      return {
        state: "record",
        admission: response.body.admission,
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
        reason: `unexpected selected task route admission response: ${response.body.type}`,
      };
  }
}
