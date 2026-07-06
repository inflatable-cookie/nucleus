import type { ControlResponseEnvelopeDto } from "./envelopes";

export type ControlProductWorkflowProjectDto = {
  display_name: string | null;
  status: string | null;
  authority_refs: string[];
};

export type ControlProductWorkflowLaneDto = {
  lane: string;
  count: number;
  task_refs: string[];
  rationale_refs: string[];
};

export type ControlProductWorkflowPlanningContextDto = {
  planning_session_refs: string[];
  task_seed_refs: string[];
  accepted_planning_refs: string[];
};

export type ControlProductWorkflowContextDto = {
  memory_proposal_refs: string[];
  accepted_memory_refs: string[];
  research_run_refs: string[];
};

export type ControlProductWorkflowRuntimeDto = {
  runtime_evidence_refs: string[];
  command_evidence_refs: string[];
};

export type ControlProductWorkflowReviewDto = {
  review_refs: string[];
};

export type ControlProductWorkflowScmReadinessDto = {
  readiness_refs: string[];
};

export type ControlProductWorkflowNextDto = {
  source: string;
  next_ref: string | null;
  summary: string;
  rationale_refs: string[];
  blocked_reason: string | null;
};

export type ControlProductWorkflowSourceCountsDto = {
  task_candidates: number;
  planning_sessions: number;
  task_seeds: number;
  accepted_planning_refs: number;
  memory_proposals: number;
  accepted_memories: number;
  research_runs: number;
  runtime_evidence_refs: number;
  command_evidence_refs: number;
  review_refs: number;
  scm_readiness_refs: number;
};

export type ControlProductWorkflowGapDto = {
  area: string;
  reason: string;
};

export type ControlProductWorkflowNoEffectsDto = {
  task_mutation_performed: boolean;
  provider_execution_performed: boolean;
  provider_write_performed: boolean;
  scm_or_forge_mutation_performed: boolean;
  accepted_memory_apply_performed: boolean;
  projection_write_performed: boolean;
  agent_scheduling_performed: boolean;
  ui_effect_performed: boolean;
};

export type ControlProductWorkflowSummaryDto = {
  summary_id: string;
  project_id: string;
  project: ControlProductWorkflowProjectDto;
  task_lanes: ControlProductWorkflowLaneDto[];
  planning_context: ControlProductWorkflowPlanningContextDto;
  context: ControlProductWorkflowContextDto;
  runtime: ControlProductWorkflowRuntimeDto;
  review: ControlProductWorkflowReviewDto;
  scm_readiness: ControlProductWorkflowScmReadinessDto;
  next: ControlProductWorkflowNextDto;
  source_counts: ControlProductWorkflowSourceCountsDto;
  gaps: ControlProductWorkflowGapDto[];
  no_effects: ControlProductWorkflowNoEffectsDto;
};

export type ProductWorkflowSummaryQueryResult =
  | {
      state: "record";
      summary: ControlProductWorkflowSummaryDto;
    }
  | QueryFallback;

type QueryFallback =
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export function productWorkflowSummaryFromResponse(
  response: ControlResponseEnvelopeDto,
): ProductWorkflowSummaryQueryResult {
  switch (response.body.type) {
    case "product_workflow_summary":
      return {
        state: "record",
        summary: response.body.summary,
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
        reason: `unexpected product workflow response: ${response.body.type}`,
      };
  }
}
