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
export type ControlStateDomain = "projects" | "tasks" | "workspaces";
export type ControlTaskTransitionAction = "start" | "block" | "complete" | "archive";

export type ControlProjectRecordDto = {
  project_id: string;
  display_name: string;
  status: string;
  importance_level: string;
  revision_id: string;
};

export type ControlTaskRecordDto = {
  task_id: string;
  project_id: string;
  title: string;
  description: string | null;
  importance: string;
  action_type: string;
  activity: string;
  assignment_intent: string | null;
  agent_ready: boolean;
  revision_id: string;
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

export type StewardDiagnosticsDto = {
  proposals: StewardProposalDiagnosticDto[];
  command_admissions: StewardCommandAdmissionDiagnosticDto[];
  command_outcomes: StewardCommandOutcomeDiagnosticDto[];
  client_can_mutate: false;
  source_status: string;
  source_summary: string | null;
};

export type EffigyDiagnosticsDto = {
  integration_status: string;
  selector_refs: string[];
  health_status: string | null;
  validation_status: string | null;
  evidence_refs: string[];
  client_can_run_effigy: false;
  source_status: string;
  source_summary: string | null;
};

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

export type SyncDiagnosticsDto = {
  plans: SyncPlanDiagnosticDto[];
  repairs: SyncRepairDiagnosticDto[];
  assistance_routes: SyncAssistanceDiagnosticDto[];
  capture_preps: SyncCapturePrepDiagnosticDto[];
  client_can_mutate_provider: false;
  source_status: string;
  source_summary: string | null;
};

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

export type ScmSessionDiagnosticsDto = {
  sessions: ScmSessionPlanDiagnosticDto[];
  admissions: ScmCommandAdmissionDiagnosticDto[];
  work_item_links: ScmWorkItemLinkDiagnosticDto[];
  client_can_mutate_working_copy: false;
  source_status: string;
  source_summary: string | null;
};

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

export type TaskAgentDiagnosticsDto = {
  work_units: TaskAgentWorkUnitDiagnosticDto[];
  client_can_mutate_work_units: false;
  provider_execution_available: false;
  source_status: string;
  source_summary: string | null;
};

export type ControlDiagnosticsSnapshotDto = {
  steward: StewardDiagnosticsDto;
  effigy: EffigyDiagnosticsDto;
  management_sync: SyncDiagnosticsDto;
  scm_session: ScmSessionDiagnosticsDto;
  task_agent: TaskAgentDiagnosticsDto;
};

export type ControlDiagnosticsResultDto =
  | { domain: "steward"; record: StewardDiagnosticsDto }
  | { domain: "effigy"; record: EffigyDiagnosticsDto }
  | { domain: "management_sync"; record: SyncDiagnosticsDto }
  | { domain: "scm_session"; record: ScmSessionDiagnosticsDto }
  | { domain: "task_agent"; record: TaskAgentDiagnosticsDto }
  | { domain: "all"; record: ControlDiagnosticsSnapshotDto };
