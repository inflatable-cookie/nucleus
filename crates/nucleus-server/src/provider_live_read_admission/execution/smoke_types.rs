use serde::{Deserialize, Serialize};

use crate::{ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadSmokeTargetInput {
    pub smoke_target_ref: String,
    pub provider_family_ref: Option<String>,
    pub provider_instance_ref: Option<String>,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub remote_repo_ref: Option<String>,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub target_refs: Vec<String>,
    pub local_evidence_refs: Vec<String>,
    pub smoke_target_evidence_ref: Option<String>,
    pub provider_network_call_requested: bool,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
    pub raw_provider_payload_retention_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadSmokeTargetRecord {
    pub smoke_target_id: String,
    pub smoke_target_ref: String,
    pub provider_family_ref: Option<String>,
    pub provider_instance_ref: Option<String>,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub remote_repo_ref: Option<String>,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub target_refs: Vec<String>,
    pub local_evidence_refs: Vec<String>,
    pub smoke_target_evidence_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub status: ProviderLiveReadSmokeTargetStatus,
    pub blockers: Vec<ProviderLiveReadSmokeTargetBlocker>,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadSmokeTargetStatus {
    Selected,
    RepairRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadSmokeTargetBlocker {
    MissingSmokeTargetRef,
    MissingProviderFamilyRef,
    MissingProviderInstanceRef,
    MissingForgeProvider,
    MissingRemoteRepoRef,
    MissingTargetRef,
    MissingLocalEvidenceRef,
    MissingSmokeTargetEvidenceRef,
    UnsupportedOperationFamily,
    MutatingOperationFamily,
    ProviderNetworkCallRequested,
    ProviderWriteRequested,
    TaskMutationRequested,
    RawProviderPayloadRetentionRequested,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadSmokeAuthorityChecklistInput {
    pub target: ProviderLiveReadSmokeTargetRecord,
    pub credential_lease_ref: Option<String>,
    pub network_read_authority_ref: Option<String>,
    pub payload_policy_ref: Option<String>,
    pub sanitization_policy_ref: Option<String>,
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
pub struct ProviderLiveReadSmokeAuthorityChecklistRecord {
    pub checklist_id: String,
    pub smoke_target_id: String,
    pub credential_lease_ref: Option<String>,
    pub network_read_authority_ref: Option<String>,
    pub payload_policy_ref: Option<String>,
    pub sanitization_policy_ref: Option<String>,
    pub retention_policy_ref: Option<String>,
    pub operator_approval_ref: Option<String>,
    pub checklist_evidence_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub status: ProviderLiveReadSmokeAuthorityChecklistStatus,
    pub blockers: Vec<ProviderLiveReadSmokeAuthorityChecklistBlocker>,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadSmokeAuthorityChecklistStatus {
    ReadyForStoppedSmokeRequest,
    ApprovalRequired,
    RepairRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadSmokeAuthorityChecklistBlocker {
    TargetNotSelected,
    MissingCredentialLeaseRef,
    MissingNetworkReadAuthorityRef,
    MissingPayloadPolicyRef,
    MissingSanitizationPolicyRef,
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
pub struct ProviderLiveReadSmokeRequestInput {
    pub checklist: ProviderLiveReadSmokeAuthorityChecklistRecord,
    pub stopped_handoff_ref: Option<String>,
    pub fixture_response_ref: Option<String>,
    pub smoke_request_evidence_ref: Option<String>,
    pub existing_smoke_request_ids: Vec<String>,
    pub provider_network_call_requested: bool,
    pub credential_material_present: bool,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
    pub raw_provider_payload_retention_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadSmokeRequestRecord {
    pub smoke_request_id: String,
    pub checklist_id: String,
    pub smoke_target_id: String,
    pub stopped_handoff_ref: Option<String>,
    pub fixture_response_ref: Option<String>,
    pub smoke_request_evidence_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub status: ProviderLiveReadSmokeRequestStatus,
    pub blockers: Vec<ProviderLiveReadSmokeRequestBlocker>,
    pub duplicate_smoke_request_detected: bool,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadSmokeRequestStatus {
    StoppedPendingExplicitExecution,
    ApprovalRequired,
    RepairRequired,
    Blocked,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadSmokeRequestBlocker {
    ChecklistNotReady,
    MissingOperatorApprovalRef,
    MissingStoppedHandoffRef,
    MissingFixtureResponseRef,
    MissingSmokeRequestEvidenceRef,
    DuplicateSmokeRequest,
    ProviderNetworkCallRequested,
    CredentialMaterialPresent,
    ProviderWriteRequested,
    TaskMutationRequested,
    RawProviderPayloadRetentionRequested,
}
