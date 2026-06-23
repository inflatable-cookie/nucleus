use serde::{Deserialize, Serialize};

pub const GH_PR_CHECKS_FIELDS: &[&str] = &[
    "bucket",
    "completedAt",
    "description",
    "event",
    "link",
    "name",
    "startedAt",
    "state",
    "workflow",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadStatusCheckSmokeTargetInput {
    pub smoke_target_ref: String,
    pub remote_repo_ref: Option<String>,
    pub pull_request_ref: Option<String>,
    pub smoke_target_evidence_ref: Option<String>,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
    pub raw_provider_payload_retention_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadStatusCheckSmokeTargetRecord {
    pub smoke_target_id: String,
    pub smoke_target_ref: String,
    pub remote_repo_ref: Option<String>,
    pub pull_request_ref: Option<String>,
    pub json_fields: Vec<String>,
    pub smoke_target_evidence_ref: Option<String>,
    pub status: ProviderLiveReadStatusCheckSmokeTargetStatus,
    pub blockers: Vec<ProviderLiveReadStatusCheckSmokeTargetBlocker>,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadStatusCheckSmokeTargetStatus {
    Selected,
    RepairRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadStatusCheckSmokeTargetBlocker {
    MissingSmokeTargetRef,
    MissingRemoteRepoRef,
    MissingPullRequestRef,
    MissingSmokeTargetEvidenceRef,
    ProviderWriteRequested,
    TaskMutationRequested,
    RawProviderPayloadRetentionRequested,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadStatusCheckSmokeChecklistInput {
    pub target: ProviderLiveReadStatusCheckSmokeTargetRecord,
    pub credential_lease_ref: Option<String>,
    pub network_read_authority_ref: Option<String>,
    pub payload_policy_ref: Option<String>,
    pub retention_policy_ref: Option<String>,
    pub operator_approval_ref: Option<String>,
    pub checklist_evidence_ref: Option<String>,
    pub credential_material_present: bool,
    pub provider_network_call_requested: bool,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
    pub raw_provider_payload_retention_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadStatusCheckSmokeChecklistRecord {
    pub checklist_id: String,
    pub smoke_target_id: String,
    pub remote_repo_ref: Option<String>,
    pub pull_request_ref: Option<String>,
    pub json_fields: Vec<String>,
    pub credential_lease_ref: Option<String>,
    pub network_read_authority_ref: Option<String>,
    pub payload_policy_ref: Option<String>,
    pub retention_policy_ref: Option<String>,
    pub operator_approval_ref: Option<String>,
    pub checklist_evidence_ref: Option<String>,
    pub status: ProviderLiveReadStatusCheckSmokeChecklistStatus,
    pub blockers: Vec<ProviderLiveReadStatusCheckSmokeChecklistBlocker>,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadStatusCheckSmokeChecklistStatus {
    ReadyForStoppedStatusCheckRequest,
    ApprovalRequired,
    RepairRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadStatusCheckSmokeChecklistBlocker {
    TargetNotSelected,
    MissingCredentialLeaseRef,
    MissingNetworkReadAuthorityRef,
    MissingPayloadPolicyRef,
    MissingRetentionPolicyRef,
    MissingOperatorApprovalRef,
    MissingChecklistEvidenceRef,
    CredentialMaterialPresent,
    ProviderNetworkCallRequested,
    ProviderWriteRequested,
    TaskMutationRequested,
    RawProviderPayloadRetentionRequested,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadStatusCheckSmokeRequestInput {
    pub checklist: ProviderLiveReadStatusCheckSmokeChecklistRecord,
    pub status_check_request_ref: Option<String>,
    pub request_evidence_ref: Option<String>,
    pub existing_request_ids: Vec<String>,
    pub provider_network_call_requested: bool,
    pub credential_material_present: bool,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
    pub raw_provider_payload_retention_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadStatusCheckSmokeRequestRecord {
    pub request_id: String,
    pub status_check_request_ref: Option<String>,
    pub checklist_id: String,
    pub smoke_target_id: String,
    pub expected_command_line: Vec<String>,
    pub request_evidence_ref: Option<String>,
    pub status: ProviderLiveReadStatusCheckSmokeRequestStatus,
    pub blockers: Vec<ProviderLiveReadStatusCheckSmokeRequestBlocker>,
    pub duplicate_request_detected: bool,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadStatusCheckSmokeRequestStatus {
    StoppedPendingExplicitExecution,
    ApprovalRequired,
    RepairRequired,
    Blocked,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadStatusCheckSmokeRequestBlocker {
    ChecklistNotReady,
    MissingOperatorApprovalRef,
    MissingStatusCheckRequestRef,
    MissingRequestEvidenceRef,
    MissingCommandTarget,
    DuplicateRequest,
    ProviderNetworkCallRequested,
    CredentialMaterialPresent,
    ProviderWriteRequested,
    TaskMutationRequested,
    RawProviderPayloadRetentionRequested,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadStatusCheckSmokeDiagnostics {
    pub diagnostics_id: String,
    pub target_count: usize,
    pub selected_target_count: usize,
    pub checklist_count: usize,
    pub approval_required_count: usize,
    pub stopped_request_count: usize,
    pub blocked_count: usize,
    pub blocker_count: usize,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}
