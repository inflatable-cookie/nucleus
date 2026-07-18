import { parseSingleRecordResponse, type QueryFallback } from "./singleRecordResponse";
import type { ControlResponseEnvelopeDto } from "./envelopes";

export type ControlSelectedTaskReworkPreparationRefusalDto = {
  kind: string;
  reason: string;
};

export type ControlSelectedTaskReworkPreparationNoEffectsDto = {
  review_mutation_performed: boolean;
  task_lifecycle_mutation_performed: boolean;
  work_item_creation_performed: boolean;
  provider_execution_performed: boolean;
  provider_write_performed: boolean;
  scm_or_forge_mutation_performed: boolean;
  accepted_memory_apply_performed: boolean;
  planning_apply_performed: boolean;
  projection_write_performed: boolean;
  agent_scheduling_performed: boolean;
  ui_effect_performed: boolean;
};

export type ControlSelectedTaskReworkPreparationDto = {
  preparation_id: string;
  project_id: string;
  task_id: string;
  route_admission_id: string;
  route_id: string;
  review_decision_ref: string | null;
  status: "admitted" | "refused" | string;
  refusal: ControlSelectedTaskReworkPreparationRefusalDto | null;
  reviewed_work_item_refs: string[];
  reviewed_evidence_refs: string[];
  operator_ref: string;
  expected_task_revision: string | null;
  expected_work_item_revision: string | null;
  rework_summary: string | null;
  no_effects: ControlSelectedTaskReworkPreparationNoEffectsDto;
};

export type SelectedTaskReworkPreparationQueryResult =
  | {
      state: "record";
      preparation: ControlSelectedTaskReworkPreparationDto;
    }
  | QueryFallback;

export function selectedTaskReworkPreparationFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskReworkPreparationQueryResult {
  return parseSingleRecordResponse(response, "selected_task_rework_preparation", "selected task rework preparation", (body) => ({
    state: "record" as const,
    preparation: body.preparation,
  }));
}
