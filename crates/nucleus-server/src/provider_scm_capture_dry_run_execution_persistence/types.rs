use serde::{Deserialize, Serialize};

use crate::{
    ScmCaptureDryRunReceiptBlocker, ScmCaptureDryRunReceiptRecord, ScmCaptureDryRunReceiptStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureDryRunExecutionPersistenceInput {
    pub receipt: ScmCaptureDryRunReceiptRecord,
    pub existing_execution_receipt_ids: Vec<String>,
    pub raw_output_present: bool,
    pub scm_capture_requested: bool,
    pub scm_publish_requested: bool,
    pub forge_change_request_requested: bool,
    pub forge_merge_requested: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunExecutionPersistenceRecord {
    pub persisted_execution_receipt_id: String,
    pub receipt_id: String,
    pub capability_item_id: String,
    pub admission_id: String,
    pub persisted_dry_run_plan_id: String,
    pub dry_run_plan_item_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub adapter_label: String,
    pub workflow_label: String,
    pub outcome: ScmCaptureDryRunReceiptStatus,
    pub receipt_blockers: Vec<ScmCaptureDryRunReceiptBlocker>,
    pub persistence_status: ScmCaptureDryRunExecutionPersistenceStatus,
    pub persistence_blockers: Vec<ScmCaptureDryRunExecutionPersistenceBlocker>,
    pub duplicate_execution_receipt_detected: bool,
    pub evidence_refs: Vec<String>,
    pub changed_path_count: usize,
    pub summary_line_count: usize,
    pub scm_dry_run_executed: bool,
    pub scm_capture_executed: bool,
    pub scm_publish_executed: bool,
    pub forge_change_request_created: bool,
    pub forge_merge_executed: bool,
    pub provider_write_executed: bool,
    pub callback_response_executed: bool,
    pub interruption_executed: bool,
    pub recovery_executed: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunExecutionPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunExecutionPersistenceBlocker {
    MissingEvidenceRef,
    RawOutputPresent,
    CaptureRequested,
    PublishRequested,
    ForgeChangeRequestRequested,
    ForgeMergeRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCaptureDryRunExecutionDiagnosticsRecord {
    pub diagnostics_id: String,
    pub receipt_count: usize,
    pub accepted_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
    pub timed_out_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub duplicate_noop_count: usize,
    pub blocker_count: usize,
    pub dry_run_executed_count: usize,
    pub scm_capture_executed: bool,
    pub scm_publish_executed: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}
