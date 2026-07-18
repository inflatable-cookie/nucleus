export const CONTROL_PROTOCOL_FAMILY = "nucleus.control";
export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_CLIENT_ID = "client:desktop";

export type RuntimeMetadataAction =
  | "list_artifact_metadata"
  | "list_command_evidence"
  | "list_task_work_progress"
  | "get_local_runtime_readiness";
export type DiagnosticsDomain =
  | "steward"
  | "effigy"
  | "management_sync"
  | "scm_session"
  | "task_agent"
  | "all";
export type ProviderReadinessOverviewAction = "overview";
export type ProviderReadIntentAction = "projection";
export type ControlStateDomain = "projects" | "tasks" | "goals" | "workspaces";
export type ControlTaskTransitionAction = "start" | "block" | "complete" | "archive";

// Canonical shape comes from the Rust DTOs via ts-rs.
export type { ControlProjectRecordDto } from "./generated/ControlProjectRecordDto";
import type { ControlProjectRecordDto } from "./generated/ControlProjectRecordDto";

// Canonical shape comes from the Rust DTOs via ts-rs.
export type { ControlProjectResourceRecordDto } from "./generated/ControlProjectResourceRecordDto";
import type { ControlProjectResourceRecordDto } from "./generated/ControlProjectResourceRecordDto";

export type ControlTaskRecordDto = {
  task_id: string;
  project_id: string;
  title: string;
  description: string | null;
  acceptance_criteria: ControlTaskAcceptanceCriterionDto[];
  importance: string;
  action_type: string;
  activity: string;
  assignment_intent: string | null;
  agent_ready: boolean;
  required_context_refs: string[];
  allowed_actions: string[];
  stop_conditions: string[];
  validation_commands: string[];
  blocked_reason: string | null;
  revision_id: string;
};

export type ControlTaskAcceptanceCriterionDto = {
  text: string;
  required: boolean;
};

export type ControlGoalRecordDto = {
  goal_id: string;
  project_id: string;
  title: string;
  desired_outcome: string;
  scope: string;
  status: string;
  blocked_reason: string | null;
  owner_refs: string[];
  ordered_task_refs: string[];
  planning_artifact_refs: string[];
  provenance_refs: string[];
  stop_conditions: string[];
  evidence_refs: string[];
  current_next_task_ref: string | null;
  next_action: string | null;
  revision_id: string;
  created_at_epoch_seconds: number | null;
  updated_at_epoch_seconds: number | null;
  achieved_at_epoch_seconds: number | null;
};

export type ControlCommandEvidenceRecordDto = {
  evidence_id: string;
  command_request_id: string;
  status: string;
  exit_status: number | null;
  retention: string;
  summary: string | null;
  stdout_artifact_ref: string | null;
  stderr_artifact_ref: string | null;
};

export type ControlRuntimeReadinessBlockerDto = {
  source: string;
  code: string;
  message: string;
};

export type ControlRuntimeReadinessDiagnosticDto = {
  host_id: string;
  runtime_surface: string;
  status: string;
  blockers: ControlRuntimeReadinessBlockerDto[];
  evidence_refs: string[];
  repair_hints: string[];
  summary: string | null;
};

// Canonical shape comes from the Rust DTOs via ts-rs.
export type { ControlProviderReadinessOverviewDto } from "./generated/ControlProviderReadinessOverviewDto";
import type { ControlProviderReadinessOverviewDto } from "./generated/ControlProviderReadinessOverviewDto";

export type ControlProviderReadIntentEntryDto = {
  intent_id: string;
  source_persisted_refresh_id: string;
  family: string;
  status: string;
  provider_context_ref: string | null;
  provider_instance_ref: string | null;
  forge_provider: string | null;
  remote_repo_ref: string | null;
  operation_family: string;
  blocker_count: number;
  evidence_ref_count: number;
  duplicate_refresh_detected: boolean;
  stopped_refresh_recorded: boolean;
  credential_resolution_performed: boolean;
  provider_network_call_performed: boolean;
  provider_effect_executed: boolean;
  callback_effect_executed: boolean;
  interruption_effect_executed: boolean;
  recovery_effect_executed: boolean;
  task_mutation_executed: boolean;
  raw_provider_payload_retained: boolean;
};

export type ControlProviderReadIntentProjectionDto = {
  projection_id: string;
  total_count: number;
  credential_status_count: number;
  repository_metadata_count: number;
  pull_request_count: number;
  status_check_count: number;
  ready_count: number;
  duplicate_noop_count: number;
  blocked_count: number;
  repair_required_count: number;
  blocker_count: number;
  evidence_ref_count: number;
  entries: ControlProviderReadIntentEntryDto[];
  credential_resolution_performed: boolean;
  provider_network_call_performed: boolean;
  provider_effect_executed: boolean;
  callback_effect_executed: boolean;
  interruption_effect_executed: boolean;
  recovery_effect_executed: boolean;
  task_mutation_executed: boolean;
  raw_provider_payload_retained: boolean;
};

export type ControlProviderReadIntentSourceCountsDto = {
  credential_status_records: number;
  repository_metadata_records: number;
  pull_request_records: number;
  status_check_records: number;
};

export type ControlProviderReadIntentQueryResultDto = {
  query_id: string;
  projection: ControlProviderReadIntentProjectionDto;
  source_counts: ControlProviderReadIntentSourceCountsDto;
  credential_resolution_performed: boolean;
  provider_network_call_performed: boolean;
  provider_effect_executed: boolean;
  callback_effect_executed: boolean;
  interruption_effect_executed: boolean;
  recovery_effect_executed: boolean;
  task_mutation_executed: boolean;
  raw_provider_payload_retained: boolean;
};

export type StewardProposalDiagnosticDto = {
  proposal_id: string;
  kind: string;
  review: string;
  requires_human_approval: boolean;
  evidence_refs: string[];
  receipt_refs: string[];
  summary: string | null;
};

export type StewardCommandAdmissionDiagnosticDto = {
  command_id: string;
  status: string;
  terminal: boolean;
};

export type StewardCommandOutcomeDiagnosticDto = {
  command_id: string;
  status: string;
  terminal: boolean;
  proposal_refs: string[];
  sync_assistance_refs: string[];
};

// Canonical shape comes from the Rust DTOs via ts-rs.
export type { StewardDiagnosticsDto } from "./generated/StewardDiagnosticsDto";
import type { StewardDiagnosticsDto } from "./generated/StewardDiagnosticsDto";

// Canonical shape comes from the Rust DTOs via ts-rs.
export type { EffigyDiagnosticsDto } from "./generated/EffigyDiagnosticsDto";
import type { EffigyDiagnosticsDto } from "./generated/EffigyDiagnosticsDto";

export type SyncPlanDiagnosticDto = {
  plan_id: string;
  kind: string;
  status: string;
  file_refs: string[];
  receipt_ids: string[];
};

export type SyncRepairDiagnosticDto = {
  proposal_id: string;
  kind: string;
  review: string;
  file_ref: string;
  preserves_incoming_record: boolean;
};

export type SyncAssistanceDiagnosticDto = {
  conflict_id: string;
  kind: string;
  review: string;
  requires_human_approval: boolean;
};

export type SyncCapturePrepDiagnosticDto = {
  prep_id: string;
  plan_id: string;
  status: string;
  file_refs: string[];
  receipt_ids: string[];
  execution_available: boolean;
};

// Canonical shape comes from the Rust DTOs via ts-rs.
export type { SyncDiagnosticsDto } from "./generated/SyncDiagnosticsDto";
import type { SyncDiagnosticsDto } from "./generated/SyncDiagnosticsDto";

export type ScmSessionPlanDiagnosticDto = {
  session_id: string;
  repository_id: string;
  provider_kind: string;
  mode: string;
  status: string;
  user_can_test_in_known_directory: boolean;
  runtime_constraints: string[];
};

export type ScmCommandAdmissionDiagnosticDto = {
  command_id: string;
  status: string;
  required_capability: string;
  executes_provider_command: boolean;
};

export type ScmWorkItemLinkDiagnosticDto = {
  link_id: string;
  task_id: string;
  work_item_id: string;
  work_session_id: string;
  session_command_ids: string[];
  change_refs: string[];
  checkpoint_ids: string[];
  diff_summary_ids: string[];
  requires_repair: boolean;
};

// Canonical shape comes from the Rust DTOs via ts-rs.
export type { ScmSessionDiagnosticsDto } from "./generated/ScmSessionDiagnosticsDto";
import type { ScmSessionDiagnosticsDto } from "./generated/ScmSessionDiagnosticsDto";

export type TaskAgentWorkUnitIssueDto = {
  code: string;
  summary: string;
};

export type TaskAgentWorkUnitDiagnosticDto = {
  work_item_id: string;
  project_id: string;
  task_id: string;
  runtime: string;
  review: string;
  last_source_id: string;
  last_cursor: string;
  source_count: number;
  session_id: string | null;
  turn_ids: string[];
  receipt_ids: string[];
  checkpoint_ids: string[];
  diff_summary_ids: string[];
  timeline_entry_ids: string[];
  validation_refs: string[];
  artifact_refs: string[];
  issues: TaskAgentWorkUnitIssueDto[];
  summary: string;
};

// Canonical shape comes from the Rust DTOs via ts-rs.
export type { TaskAgentDiagnosticsDto } from "./generated/TaskAgentDiagnosticsDto";
import type { TaskAgentDiagnosticsDto } from "./generated/TaskAgentDiagnosticsDto";

// Canonical shape comes from the Rust DTOs via ts-rs; the hand-written
// version had drifted 12 fields behind.
export type { ControlDiagnosticsSnapshotDto } from "./generated/ControlDiagnosticsSnapshotDto";
import type { ControlDiagnosticsSnapshotDto } from "./generated/ControlDiagnosticsSnapshotDto";

// Canonical shape comes from the Rust DTOs via ts-rs.
export type { ControlDiagnosticsResultDto } from "./generated/ControlDiagnosticsResultDto";
