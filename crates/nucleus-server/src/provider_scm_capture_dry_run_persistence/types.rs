use serde::{Deserialize, Serialize};

use crate::{ScmCaptureDryRunPlanBlocker, ScmCaptureDryRunPlanItem, ScmCaptureDryRunPlanStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCaptureDryRunPersistenceInput {
    pub plan_item: ScmCaptureDryRunPlanItem,
    pub existing_dry_run_plan_ids: Vec<String>,
    pub raw_material_present: bool,
    pub scm_dry_run_requested: bool,
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
pub struct ScmCaptureDryRunPersistenceRecord {
    pub persisted_dry_run_plan_id: String,
    pub dry_run_plan_item_id: String,
    pub dry_run_candidate_id: String,
    pub persisted_preparation_id: String,
    pub plan_item_id: String,
    pub admission_id: String,
    pub readiness_id: String,
    pub capture_candidate_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub adapter_label: String,
    pub workflow_label: String,
    pub plan_status: ScmCaptureDryRunPlanStatus,
    pub plan_blockers: Vec<ScmCaptureDryRunPlanBlocker>,
    pub status: ScmCaptureDryRunPersistenceStatus,
    pub blockers: Vec<ScmCaptureDryRunPersistenceBlocker>,
    pub duplicate_dry_run_plan_detected: bool,
    pub scm_dry_run_permitted: bool,
    pub scm_capture_permitted: bool,
    pub scm_publish_permitted: bool,
    pub forge_change_request_permitted: bool,
    pub forge_merge_permitted: bool,
    pub provider_write_permitted: bool,
    pub callback_response_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScmCaptureDryRunPersistenceBlocker {
    MissingEvidenceRef,
    RawMaterialPresent,
    ScmDryRunRequested,
    ScmCaptureRequested,
    ScmPublishRequested,
    ForgeChangeRequestRequested,
    ForgeMergeRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}
