use serde::{Deserialize, Serialize};

use crate::{
    CompletionScmCaptureAdmissionBlocker, CompletionScmCaptureAdmissionRecord,
    CompletionScmCaptureAdmissionStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmCaptureAdmissionPersistenceInput {
    pub admission: CompletionScmCaptureAdmissionRecord,
    pub existing_admission_ids: Vec<String>,
    pub raw_material_present: bool,
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
pub struct CompletionScmCaptureAdmissionPersistenceRecord {
    pub persisted_admission_id: String,
    pub admission_id: String,
    pub request_id: String,
    pub readiness_id: String,
    pub candidate_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub admission_status: CompletionScmCaptureAdmissionStatus,
    pub status: CompletionScmCaptureAdmissionPersistenceStatus,
    pub blockers: Vec<CompletionScmCaptureAdmissionPersistenceBlocker>,
    pub admission_blockers: Vec<CompletionScmCaptureAdmissionBlocker>,
    pub duplicate_admission_detected: bool,
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
pub enum CompletionScmCaptureAdmissionPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionScmCaptureAdmissionPersistenceBlocker {
    MissingEvidenceRef,
    RawMaterialPresent,
    ScmCaptureRequested,
    ScmPublishRequested,
    ForgeChangeRequestRequested,
    ForgeMergeRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}
