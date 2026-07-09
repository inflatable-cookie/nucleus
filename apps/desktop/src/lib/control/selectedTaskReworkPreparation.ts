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

type QueryFallback =
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export type SelectedTaskReworkPreparationQueryResult =
  | {
      state: "record";
      preparation: ControlSelectedTaskReworkPreparationDto;
    }
  | QueryFallback;

export function selectedTaskReworkPreparationFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskReworkPreparationQueryResult {
  switch (response.body.type) {
    case "selected_task_rework_preparation":
      return {
        state: "record",
        preparation: response.body.preparation,
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
        reason: `unexpected selected task rework preparation response: ${response.body.type}`,
      };
  }
}
