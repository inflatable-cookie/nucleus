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

export type ControlTaskWorkflowGuidanceDto = {
  source: string;
  safe_action: string;
  reason: string;
  evidence_refs: string[];
  missing_evidence_areas: string[];
  blocked_reason: string | null;
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
  guidance: ControlTaskWorkflowGuidanceDto;
  source_counts: ControlTaskWorkflowSourceCountsDto;
  gaps: ControlTaskWorkflowGapDto[];
  no_effects: ControlTaskWorkflowNoEffectsDto;
};

export type ControlSelectedTaskActionDto = {
  family: string;
  status: "allowed" | "blocked" | "not_applicable" | "different_lane" | string;
  label: string;
  reason: string;
  evidence_refs: string[];
  blocker_refs: string[];
};

export type ControlSelectedTaskActionSourceCountsDto = {
  task_records: number;
  readiness_refs: number;
  work_items: number;
  active_work_items: number;
  completed_work_items: number;
  runtime_evidence_refs: number;
  completion_refs: number;
  review_refs: number;
  scm_handoff_refs: number;
  gap_count: number;
};

export type ControlSelectedTaskActionBlockerDto = {
  family: string;
  reason: string;
  evidence_refs: string[];
};

export type ControlSelectedTaskActionReadinessDto = {
  readiness_id: string;
  project_id: string;
  task_id: string;
  actions: ControlSelectedTaskActionDto[];
  source_counts: ControlSelectedTaskActionSourceCountsDto;
  blockers: ControlSelectedTaskActionBlockerDto[];
  no_effects: ControlTaskWorkflowNoEffectsDto;
};

export type ControlSelectedTaskOperatorTaskCommandCandidateDto = {
  action: "start" | "block" | "complete" | "archive" | string;
  task_id: string;
  expected_revision: string | null;
};

export type ControlSelectedTaskOperatorActionCandidateDto = {
  family: string;
  readiness_status: "allowed" | "blocked" | "not_applicable" | "different_lane" | string;
  disposition: "task_command_candidate" | "blocked" | "read_only" | "deferred" | string;
  task_command: ControlSelectedTaskOperatorTaskCommandCandidateDto | null;
  label: string;
  reason: string;
  evidence_refs: string[];
  blocker_refs: string[];
  expected_revision_required: boolean;
  reason_required: boolean;
};

export type ControlSelectedTaskOperatorActionGateSourceCountsDto = {
  readiness_actions: number;
  task_command_candidates: number;
  blocked_actions: number;
  read_only_actions: number;
  deferred_actions: number;
  evidence_refs: number;
  blocker_refs: number;
};

export type ControlSelectedTaskOperatorActionBlockerDto = {
  family: string;
  reason: string;
  evidence_refs: string[];
};

export type ControlSelectedTaskOperatorActionGateDto = {
  gate_id: string;
  project_id: string;
  task_id: string;
  expected_revision: string | null;
  actor_ref: string | null;
  candidates: ControlSelectedTaskOperatorActionCandidateDto[];
  source_counts: ControlSelectedTaskOperatorActionGateSourceCountsDto;
  blockers: ControlSelectedTaskOperatorActionBlockerDto[];
  no_effects: ControlTaskWorkflowNoEffectsDto;
};

export type TaskWorkflowDrilldownQueryResult =
  | {
      state: "record";
      drilldown: ControlTaskWorkflowDrilldownDto;
    }
  | QueryFallback;

export type SelectedTaskActionReadinessQueryResult =
  | {
      state: "record";
      readiness: ControlSelectedTaskActionReadinessDto;
    }
  | QueryFallback;

export type SelectedTaskOperatorActionGateQueryResult =
  | {
      state: "record";
      gate: ControlSelectedTaskOperatorActionGateDto;
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

export function selectedTaskActionReadinessFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskActionReadinessQueryResult {
  switch (response.body.type) {
    case "selected_task_action_readiness":
      return {
        state: "record",
        readiness: response.body.readiness,
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
        reason: `unexpected selected task action readiness response: ${response.body.type}`,
      };
  }
}

export function selectedTaskOperatorActionGateFromResponse(
  response: ControlResponseEnvelopeDto,
): SelectedTaskOperatorActionGateQueryResult {
  switch (response.body.type) {
    case "selected_task_operator_action_gate":
      return {
        state: "record",
        gate: response.body.gate,
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
        reason: `unexpected selected task operator action gate response: ${response.body.type}`,
      };
  }
}
