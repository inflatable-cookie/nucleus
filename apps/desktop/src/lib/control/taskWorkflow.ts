import type { ControlResponseEnvelopeDto } from "./envelopes";

export type ControlTaskWorkflowTaskDto = {
  title: string;
  activity: string;
  assignment: string;
  action_type: string;
};

export type ControlTaskWorkflowReadinessDto = {
  lane: string;
  rationale_refs: string[];
};

export type ControlTaskWorkflowWorkItemDto = {
  work_item_ref: string;
  runtime_status: string;
  review_status: string;
  source_ref: string;
  source_count: number;
  session_ref: string | null;
  turn_refs: string[];
  receipt_refs: string[];
  checkpoint_refs: string[];
  diff_summary_refs: string[];
  timeline_entry_refs: string[];
  validation_refs: string[];
  artifact_refs: string[];
  issue_refs: string[];
};

export type ControlTaskWorkflowSourceCountsDto = {
  task_records: number;
  readiness_refs: number;
  timeline_entry_refs: number;
  work_items: number;
  runtime_receipt_refs: number;
  command_evidence_refs: number;
  task_completion_refs: number;
  review_refs: number;
  scm_handoff_refs: number;
};

export type ControlTaskWorkflowGapDto = {
  area: string;
  reason: string;
};

export type ControlTaskWorkflowNoEffectsDto = {
  task_mutation_performed: boolean;
  provider_execution_performed: boolean;
  provider_write_performed: boolean;
  scm_or_forge_mutation_performed: boolean;
  accepted_memory_apply_performed: boolean;
  planning_apply_performed: boolean;
  projection_write_performed: boolean;
  agent_scheduling_performed: boolean;
  ui_effect_performed: boolean;
};

export type ControlTaskWorkflowDrilldownDto = {
  drilldown_id: string;
  project_id: string;
  task_id: string;
  task: ControlTaskWorkflowTaskDto | null;
  readiness: ControlTaskWorkflowReadinessDto | null;
  timeline: { entry_refs: string[] };
  work_progress: { work_items: ControlTaskWorkflowWorkItemDto[] };
  runtime: {
    runtime_receipt_refs: string[];
    command_evidence_refs: string[];
    task_completion_refs: string[];
  };
  review: { review_refs: string[] };
  scm_handoff: { handoff_refs: string[] };
  next: {
    source: string;
    next_ref: string | null;
    summary: string;
    rationale_refs: string[];
    blocked_reason: string | null;
  };
  source_counts: ControlTaskWorkflowSourceCountsDto;
  gaps: ControlTaskWorkflowGapDto[];
  no_effects: ControlTaskWorkflowNoEffectsDto;
};

export type TaskWorkflowDrilldownQueryResult =
  | {
      state: "record";
      drilldown: ControlTaskWorkflowDrilldownDto;
    }
  | QueryFallback;

type QueryFallback =
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

export function taskWorkflowDrilldownFromResponse(
  response: ControlResponseEnvelopeDto,
): TaskWorkflowDrilldownQueryResult {
  switch (response.body.type) {
    case "task_workflow_drilldown":
      return {
        state: "record",
        drilldown: response.body.drilldown,
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
        reason: `unexpected task workflow drilldown response: ${response.body.type}`,
      };
  }
}
