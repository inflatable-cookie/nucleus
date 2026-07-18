import { parseSingleRecordResponse, type QueryFallback } from "./singleRecordResponse";
import {
  buildControlQueryEnvelope,
  type ControlRequestEnvelopeDto,
  type ControlResponseEnvelopeDto,
} from "./envelopes";
import type { ControlTaskWorkflowNoEffectsDto } from "./taskWorkflow";
import { CONTROL_CLIENT_ID } from "./types";

export type ControlSelectedTaskProductIdentityDto = {
  title: string | null;
  activity: string | null;
  assignment: string | null;
  action_type: string | null;
  expected_revision: string | null;
};

export type ControlSelectedTaskProductWorkflowDto = {
  primary_next_action: string;
  reason: string;
  phase: string;
  next_ref: string | null;
  blocked_reason: string | null;
};

export type ControlSelectedTaskProductBlockerDto = {
  family: string;
  reason: string;
  evidence_refs: string[];
};

export type ControlSelectedTaskProductUnavailableActionDto = {
  family: string;
  status: string;
  reason: string;
};

export type ControlSelectedTaskProductReadinessDto = {
  blockers: ControlSelectedTaskProductBlockerDto[];
  unavailable_actions: ControlSelectedTaskProductUnavailableActionDto[];
  allowed_action_count: number;
};

export type ControlSelectedTaskProductCommandPreviewDto = {
  family: string;
  status: string;
  command_available: boolean;
  refusal_reason: string | null;
  evidence_refs: string[];
};

export type ControlSelectedTaskProductCommandPreviewsDto = {
  admitted_count: number;
  refused_count: number;
  previews: ControlSelectedTaskProductCommandPreviewDto[];
};

export type ControlSelectedTaskProductWorkEvidenceDto = {
  work_item_refs: string[];
  active_work_item_count: number;
  completed_work_item_count: number;
  evidence_refs: string[];
  timeline_refs: string[];
};

export type ControlSelectedTaskProductReviewDto = {
  state: string | null;
  next_category: string | null;
  route_status: string | null;
  primary_route: string | null;
  decision_ref: string | null;
  decision_available: boolean;
  blocker_reasons: string[];
  evidence_refs: string[];
};

export type ControlSelectedTaskProductReworkDto = {
  status: string | null;
  summary: string | null;
  refusal_reason: string | null;
  reviewed_work_item_refs: string[];
  reviewed_evidence_refs: string[];
};

export type ControlSelectedTaskProductCompletionDto = {
  status: string | null;
  command_available: boolean;
  refusal_reason: string | null;
  evidence_refs: string[];
};

export type ControlSelectedTaskProductScmHandoffDto = {
  state: string | null;
  next_category: string | null;
  target_shape: string | null;
  blocker_refs: string[];
  evidence_refs: string[];
  gap_count: number;
};

export type ControlSelectedTaskProductSourceStatusDto = {
  source: string;
  state: string;
  reason: string | null;
};

export type ControlSelectedTaskProductSourceHealthDto = {
  sources: ControlSelectedTaskProductSourceStatusDto[];
  missing_count: number;
  partial_count: number;
};

export type ControlSelectedTaskProductGapDto = {
  source: string;
  reason: string;
};

export type ControlSelectedTaskProductAggregateDto = {
  aggregate_id: string;
  project_id: string;
  task_id: string;
  identity: ControlSelectedTaskProductIdentityDto;
  workflow: ControlSelectedTaskProductWorkflowDto;
  readiness: ControlSelectedTaskProductReadinessDto;
  command_previews: ControlSelectedTaskProductCommandPreviewsDto;
  work_evidence: ControlSelectedTaskProductWorkEvidenceDto;
  review: ControlSelectedTaskProductReviewDto;
  rework: ControlSelectedTaskProductReworkDto;
  completion: ControlSelectedTaskProductCompletionDto;
  scm_handoff: ControlSelectedTaskProductScmHandoffDto;
  source_health: ControlSelectedTaskProductSourceHealthDto;
  gaps: ControlSelectedTaskProductGapDto[];
  no_effects: ControlTaskWorkflowNoEffectsDto;
};

export type SelectedTaskProductAggregateQueryResult =
  | {
      state: "record";
      aggregate: ControlSelectedTaskProductAggregateDto;
    }
  | QueryFallback;

export function buildSelectedTaskProductAggregateQuery(
  projectId: string,
  taskId: string,
  expectedRevision: string | null,
): ControlRequestEnvelopeDto {
  return buildControlQueryEnvelope({
    kind: "selected_task_product_aggregate",
    query_id: "",
    action: "aggregate",
    project_id: projectId,
    task_id: taskId,
    expected_revision: expectedRevision,
    operator_ref: CONTROL_CLIENT_ID,
  });
}

export function selectedTaskProductAggregateFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskProductAggregateQueryResult {
  return parseSingleRecordResponse(response, "selected_task_product_aggregate", "selected task product aggregate", (body) => ({
    state: "record" as const,
    aggregate: body.aggregate,
  }));
}
