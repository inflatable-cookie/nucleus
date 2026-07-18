import { parseSingleRecordResponse, type QueryFallback } from "./singleRecordResponse";
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

export type SelectedTaskRouteAdmissionQueryResult =
  | {
      state: "record";
      admission: ControlSelectedTaskRouteAdmissionDto;
    }
  | QueryFallback;

export function selectedTaskRouteAdmissionFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskRouteAdmissionQueryResult {
  return parseSingleRecordResponse(response, "selected_task_route_admission", "selected task route admission", (body) => ({
    state: "record" as const,
    admission: body.admission,
  }));
}
