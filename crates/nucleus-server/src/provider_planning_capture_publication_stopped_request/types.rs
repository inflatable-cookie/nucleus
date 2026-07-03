use serde::{Deserialize, Serialize};

use crate::{
    PlanningCapturePublicationAdapterFamily, PlanningCapturePublicationAdmissionRecord,
    PlanningCapturePublicationOperation,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningCapturePublicationStoppedRequestInput {
    pub admission: PlanningCapturePublicationAdmissionRecord,
    pub existing_request_ids: Vec<String>,
    pub raw_payload_present: bool,
    pub command_execution_requested: bool,
    pub runner_handoff_requested: bool,
    pub scm_or_snapshot_mutation_requested: bool,
    pub remote_share_requested: bool,
    pub forge_mutation_requested: bool,
    pub provider_write_requested: bool,
    pub projection_import_requested: bool,
    pub task_promotion_requested: bool,
    pub callback_response_requested: bool,
    pub interruption_requested: bool,
    pub recovery_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningCapturePublicationStoppedRequestRecord {
    pub request_id: String,
    pub admission_id: String,
    pub preparation_id: String,
    pub plan_item_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub approval_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub adapter_family: PlanningCapturePublicationAdapterFamily,
    pub operation: PlanningCapturePublicationOperation,
    pub adapter_label: String,
    pub workflow_label: String,
    pub management_file_refs: Vec<String>,
    pub status: PlanningCapturePublicationStoppedRequestStatus,
    pub blockers: Vec<PlanningCapturePublicationStoppedRequestBlocker>,
    pub duplicate_request_detected: bool,
    pub command_execution_permitted: bool,
    pub runner_handoff_permitted: bool,
    pub commit_permitted: bool,
    pub snapshot_permitted: bool,
    pub publish_permitted: bool,
    pub push_permitted: bool,
    pub forge_share_permitted: bool,
    pub provider_write_permitted: bool,
    pub projection_import_permitted: bool,
    pub task_promotion_permitted: bool,
    pub callback_response_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningCapturePublicationStoppedRequestStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningCapturePublicationStoppedRequestBlocker {
    AdmissionNotAdmitted,
    StoppedRequestNotAdmitted,
    MissingEvidenceRef,
    MissingApprovalRef,
    RawPayloadPresent,
    CommandExecutionRequested,
    RunnerHandoffRequested,
    ScmOrSnapshotMutationRequested,
    RemoteShareRequested,
    ForgeMutationRequested,
    ProviderWriteRequested,
    ProjectionImportRequested,
    TaskPromotionRequested,
    CallbackResponseRequested,
    InterruptionRequested,
    RecoveryRequested,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningCapturePublicationStoppedRequestDiagnostics {
    pub diagnostics_id: String,
    pub request_count: usize,
    pub persisted_request_count: usize,
    pub duplicate_request_count: usize,
    pub blocked_request_count: usize,
    pub blocker_count: usize,
    pub adapter_family_buckets: Vec<PlanningCapturePublicationStoppedRequestDiagnosticBucket>,
    pub operation_buckets: Vec<PlanningCapturePublicationStoppedRequestDiagnosticBucket>,
    pub evidence_ref_count: usize,
    pub management_file_ref_count: usize,
    pub command_execution_permitted: bool,
    pub runner_handoff_permitted: bool,
    pub commit_permitted: bool,
    pub snapshot_permitted: bool,
    pub publish_permitted: bool,
    pub push_permitted: bool,
    pub forge_share_permitted: bool,
    pub provider_write_permitted: bool,
    pub projection_import_permitted: bool,
    pub task_promotion_permitted: bool,
    pub callback_response_permitted: bool,
    pub interruption_permitted: bool,
    pub recovery_permitted: bool,
    pub raw_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningCapturePublicationStoppedRequestDiagnosticBucket {
    pub label: String,
    pub count: usize,
}
