import type { ControlResponseEnvelopeDto } from "./envelopes";
import type { ControlTaskWorkflowNoEffectsDto } from "./taskWorkflow";

export type SelectedTaskReviewDecisionAction =
  | "accept_evidence"
  | "reject_evidence"
  | "request_changes"
  | "abandon_review";

export type ControlSelectedTaskReviewDecisionNoEffectsDto =
  ControlTaskWorkflowNoEffectsDto & {
    review_mutation_performed: boolean;
  };

export type ControlSelectedTaskReviewDecisionCommandDto = {
  decision_id: string;
  project_id: string;
  task_id: string;
  action: SelectedTaskReviewDecisionAction | string;
  outcome: string;
  expected_revision: string;
  operator_ref: string;
  reviewed_evidence_refs: string[];
  idempotency_key: string;
  reason: string | null;
};

export type ControlSelectedTaskReviewDecisionRefusalDto = {
  kind: string;
  reason: string;
};

export type ControlSelectedTaskReviewDecisionAdmissionDto = {
  admission_id: string;
  decision_id: string;
  project_id: string;
  task_id: string;
  action: SelectedTaskReviewDecisionAction | string;
  status: string;
  command: ControlSelectedTaskReviewDecisionCommandDto | null;
  refusal: ControlSelectedTaskReviewDecisionRefusalDto | null;
  operator_ref: string;
  evidence_refs: string[];
  no_effects: ControlSelectedTaskReviewDecisionNoEffectsDto;
};

export type ControlSelectedTaskReviewDecisionRecordDto = {
  decision_id: string;
  admission_id: string;
  project_id: string;
  task_id: string;
  work_item_refs: string[];
  action: SelectedTaskReviewDecisionAction | string;
  outcome: string;
  operator_ref: string;
  expected_revision: string;
  reviewed_evidence_refs: string[];
  receipt_refs: string[];
  timeline_refs: string[];
  reason_summary: string | null;
  idempotency_key: string;
  status: string;
  blockers: string[];
  duplicate_decision_detected: boolean;
  review_mutation_performed: boolean;
  task_lifecycle_mutation_performed: boolean;
  provider_execution_performed: boolean;
  provider_write_performed: boolean;
  scm_or_forge_mutation_performed: boolean;
  accepted_memory_apply_performed: boolean;
  planning_apply_performed: boolean;
  projection_write_performed: boolean;
  agent_scheduling_performed: boolean;
  ui_effect_performed: boolean;
  raw_provider_material_retained: boolean;
  raw_command_output_retained: boolean;
};

type QueryFallback =
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export type SelectedTaskReviewDecisionAdmissionQueryResult =
  | {
      state: "record";
      admission: ControlSelectedTaskReviewDecisionAdmissionDto;
    }
  | QueryFallback;

export type SelectedTaskReviewDecisionApplyQueryResult =
  | {
      state: "record";
      record: ControlSelectedTaskReviewDecisionRecordDto;
    }
  | QueryFallback;

export function selectedTaskReviewDecisionAdmissionFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskReviewDecisionAdmissionQueryResult {
  switch (response.body.type) {
    case "selected_task_review_decision_admission":
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
        reason: `unexpected selected task review decision admission response: ${response.body.type}`,
      };
  }
}

export function selectedTaskReviewDecisionApplyFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskReviewDecisionApplyQueryResult {
  switch (response.body.type) {
    case "selected_task_review_decision_apply":
      return {
        state: "record",
        record: response.body.record,
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
        reason: `unexpected selected task review decision apply response: ${response.body.type}`,
      };
  }
}
