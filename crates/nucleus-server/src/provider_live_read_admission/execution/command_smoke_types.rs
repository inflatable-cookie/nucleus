use serde::{Deserialize, Serialize};

use super::executor_types::{
    ProviderLiveReadCommandHandoffRecord, ProviderLiveReadCommandHandoffStatus,
    ProviderLiveReadGhCommandDescriptorRecord, ProviderLiveReadGhCommandDescriptorStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadCommandSmokeTargetInput {
    pub smoke_target_ref: String,
    pub descriptor: ProviderLiveReadGhCommandDescriptorRecord,
    pub handoff: ProviderLiveReadCommandHandoffRecord,
    pub smoke_target_evidence_ref: Option<String>,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
    pub raw_provider_payload_retention_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadCommandSmokeTargetRecord {
    pub smoke_target_id: String,
    pub smoke_target_ref: String,
    pub command_descriptor_id: String,
    pub handoff_id: String,
    pub executor_request_id: String,
    pub remote_repo_ref: String,
    pub executable: String,
    pub argv: Vec<String>,
    pub smoke_target_evidence_ref: Option<String>,
    pub status: ProviderLiveReadCommandSmokeTargetStatus,
    pub blockers: Vec<ProviderLiveReadCommandSmokeTargetBlocker>,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadCommandSmokeTargetStatus {
    Selected,
    RepairRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadCommandSmokeTargetBlocker {
    MissingSmokeTargetRef,
    CommandDescriptorNotReady,
    CommandHandoffNotReady,
    DescriptorHandoffMismatch,
    MissingSmokeTargetEvidenceRef,
    ProviderWriteRequested,
    TaskMutationRequested,
    RawProviderPayloadRetentionRequested,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadCommandSmokeApprovalInput {
    pub target: ProviderLiveReadCommandSmokeTargetRecord,
    pub read_authority_ref: Option<String>,
    pub credential_lease_ref: Option<String>,
    pub payload_policy_ref: Option<String>,
    pub retention_policy_ref: Option<String>,
    pub operator_approval_ref: Option<String>,
    pub checklist_evidence_ref: Option<String>,
    pub credential_material_present: bool,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
    pub raw_provider_payload_retention_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadCommandSmokeApprovalRecord {
    pub checklist_id: String,
    pub smoke_target_id: String,
    pub command_descriptor_id: String,
    pub handoff_id: String,
    pub read_authority_ref: Option<String>,
    pub credential_lease_ref: Option<String>,
    pub payload_policy_ref: Option<String>,
    pub retention_policy_ref: Option<String>,
    pub operator_approval_ref: Option<String>,
    pub checklist_evidence_ref: Option<String>,
    pub status: ProviderLiveReadCommandSmokeApprovalStatus,
    pub blockers: Vec<ProviderLiveReadCommandSmokeApprovalBlocker>,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadCommandSmokeApprovalStatus {
    ReadyForStoppedCommandSmokeRequest,
    ApprovalRequired,
    RepairRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadCommandSmokeApprovalBlocker {
    TargetNotSelected,
    MissingReadAuthorityRef,
    MissingCredentialLeaseRef,
    MissingPayloadPolicyRef,
    MissingRetentionPolicyRef,
    MissingOperatorApprovalRef,
    MissingChecklistEvidenceRef,
    CredentialMaterialPresent,
    ProviderWriteRequested,
    TaskMutationRequested,
    RawProviderPayloadRetentionRequested,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadCommandSmokeRequestInput {
    pub checklist: ProviderLiveReadCommandSmokeApprovalRecord,
    pub command_smoke_request_ref: Option<String>,
    pub expected_command_line: Vec<String>,
    pub request_evidence_ref: Option<String>,
    pub existing_request_ids: Vec<String>,
    pub provider_network_call_requested: bool,
    pub credential_material_present: bool,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
    pub raw_provider_payload_retention_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadCommandSmokeRequestRecord {
    pub request_id: String,
    pub command_smoke_request_ref: Option<String>,
    pub checklist_id: String,
    pub smoke_target_id: String,
    pub command_descriptor_id: String,
    pub handoff_id: String,
    pub expected_command_line: Vec<String>,
    pub request_evidence_ref: Option<String>,
    pub status: ProviderLiveReadCommandSmokeRequestStatus,
    pub blockers: Vec<ProviderLiveReadCommandSmokeRequestBlocker>,
    pub duplicate_request_detected: bool,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadCommandSmokeRequestStatus {
    StoppedPendingExplicitExecution,
    ApprovalRequired,
    RepairRequired,
    Blocked,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadCommandSmokeRequestBlocker {
    ChecklistNotReady,
    MissingOperatorApprovalRef,
    MissingCommandSmokeRequestRef,
    MissingExpectedCommandLine,
    MissingRequestEvidenceRef,
    DuplicateRequest,
    ProviderNetworkCallRequested,
    CredentialMaterialPresent,
    ProviderWriteRequested,
    TaskMutationRequested,
    RawProviderPayloadRetentionRequested,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadCommandSmokeDiagnostics {
    pub diagnostics_id: String,
    pub target_count: usize,
    pub selected_target_count: usize,
    pub approval_checklist_count: usize,
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

pub(super) fn descriptor_ready(descriptor: &ProviderLiveReadGhCommandDescriptorRecord) -> bool {
    descriptor.status == ProviderLiveReadGhCommandDescriptorStatus::ReadyForReadOnlySpawn
}

pub(super) fn handoff_ready(handoff: &ProviderLiveReadCommandHandoffRecord) -> bool {
    handoff.status == ProviderLiveReadCommandHandoffStatus::ReadyForReadOnlyCommand
}
