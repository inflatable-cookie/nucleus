use serde::{Deserialize, Serialize};

use crate::ForgeNetworkExecutionOperationFamily;

use super::smoke_types::{
    ProviderLiveReadSmokeAuthorityChecklistRecord, ProviderLiveReadSmokeRequestRecord,
    ProviderLiveReadSmokeTargetRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadServerRequestInput {
    pub smoke_target: ProviderLiveReadSmokeTargetRecord,
    pub checklist: ProviderLiveReadSmokeAuthorityChecklistRecord,
    pub smoke_request: ProviderLiveReadSmokeRequestRecord,
    pub executor_authority_ref: Option<String>,
    pub command_descriptor_ref: Option<String>,
    pub output_evidence_ref: Option<String>,
    pub receipt_evidence_ref: Option<String>,
    pub existing_executor_request_ids: Vec<String>,
    pub credential_material_present: bool,
    pub provider_write_requested: bool,
    pub callback_execution_requested: bool,
    pub interruption_execution_requested: bool,
    pub recovery_execution_requested: bool,
    pub task_mutation_requested: bool,
    pub raw_provider_payload_retention_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadServerRequestRecord {
    pub executor_request_id: String,
    pub smoke_target_id: String,
    pub checklist_id: String,
    pub smoke_request_id: String,
    pub operator_approval_ref: Option<String>,
    pub network_read_authority_ref: Option<String>,
    pub credential_lease_ref: Option<String>,
    pub executor_authority_ref: Option<String>,
    pub command_descriptor_ref: Option<String>,
    pub output_evidence_ref: Option<String>,
    pub receipt_evidence_ref: Option<String>,
    pub provider_family_ref: Option<String>,
    pub provider_instance_ref: Option<String>,
    pub remote_repo_ref: Option<String>,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub evidence_refs: Vec<String>,
    pub status: ProviderLiveReadServerRequestStatus,
    pub blockers: Vec<ProviderLiveReadServerRequestBlocker>,
    pub duplicate_executor_request_detected: bool,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadServerRequestStatus {
    ReadyForCommandDescriptor,
    RepairRequired,
    Blocked,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadServerRequestBlocker {
    SmokeTargetNotSelected,
    ChecklistNotReady,
    SmokeRequestNotApprovedForExecution,
    SmokeTargetMismatch,
    ChecklistMismatch,
    MissingOperatorApprovalRef,
    MissingNetworkReadAuthorityRef,
    MissingCredentialLeaseRef,
    MissingExecutorAuthorityRef,
    MissingCommandDescriptorRef,
    MissingOutputEvidenceRef,
    MissingReceiptEvidenceRef,
    MissingRemoteRepoRef,
    UnsupportedOperationFamily,
    DuplicateExecutorRequest,
    CredentialMaterialPresent,
    ProviderWriteRequested,
    CallbackExecutionRequested,
    InterruptionExecutionRequested,
    RecoveryExecutionRequested,
    TaskMutationRequested,
    RawProviderPayloadRetentionRequested,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadGhCommandDescriptorRecord {
    pub command_descriptor_id: String,
    pub executor_request_id: String,
    pub remote_repo_ref: String,
    pub executable: String,
    pub args: Vec<String>,
    pub json_fields: Vec<String>,
    pub expected_sanitized_fields: Vec<String>,
    pub status: ProviderLiveReadGhCommandDescriptorStatus,
    pub blockers: Vec<ProviderLiveReadGhCommandDescriptorBlocker>,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadGhCommandDescriptorStatus {
    ReadyForReadOnlySpawn,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadGhCommandDescriptorBlocker {
    ExecutorRequestNotReady,
    MissingRemoteRepoRef,
    UnsupportedOperationFamily,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadSanitizedRepositoryMetadataRecord {
    pub output_record_id: String,
    pub command_descriptor_id: String,
    pub executor_request_id: String,
    pub name_with_owner: Option<String>,
    pub default_branch: Option<String>,
    pub is_private: Option<bool>,
    pub visibility: Option<String>,
    pub url: Option<String>,
    pub viewer_permission: Option<String>,
    pub pushed_at: Option<String>,
    pub updated_at: Option<String>,
    pub status: ProviderLiveReadSanitizedRepositoryMetadataStatus,
    pub blockers: Vec<ProviderLiveReadRepositoryMetadataParseBlocker>,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadSanitizedRepositoryMetadataStatus {
    Sanitized,
    ParseError,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadRepositoryMetadataParseBlocker {
    CommandDescriptorNotReady,
    JsonParseFailed,
    MissingNameWithOwner,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadServerReceiptInput {
    pub request: ProviderLiveReadServerRequestRecord,
    pub descriptor: ProviderLiveReadGhCommandDescriptorRecord,
    pub output: ProviderLiveReadSanitizedRepositoryMetadataRecord,
    pub provider_exit_code: Option<i32>,
    pub receipt_evidence_ref: Option<String>,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadServerReceiptRecord {
    pub receipt_id: String,
    pub executor_request_id: String,
    pub command_descriptor_id: String,
    pub output_record_id: String,
    pub provider_exit_code: Option<i32>,
    pub receipt_evidence_ref: Option<String>,
    pub status: ProviderLiveReadServerReceiptStatus,
    pub blockers: Vec<ProviderLiveReadServerReceiptBlocker>,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadServerReceiptStatus {
    ProviderReadPerformed,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadServerReceiptBlocker {
    ExecutorRequestNotReady,
    CommandDescriptorNotReady,
    SanitizedOutputNotReady,
    ProviderNetworkReadNotPerformed,
    ProviderWriteExecuted,
    CallbackEffectExecuted,
    InterruptionEffectExecuted,
    RecoveryEffectExecuted,
    TaskMutationExecuted,
    RawProviderPayloadRetained,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadServerExecutorDiagnostics {
    pub diagnostics_id: String,
    pub request_count: usize,
    pub ready_request_count: usize,
    pub blocked_request_count: usize,
    pub descriptor_ready_count: usize,
    pub sanitized_output_count: usize,
    pub parse_error_count: usize,
    pub receipt_count: usize,
    pub provider_network_read_performed_count: usize,
    pub blocker_count: usize,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadCommandHandoffInput {
    pub descriptor: ProviderLiveReadGhCommandDescriptorRecord,
    pub command_handoff_ref: Option<String>,
    pub working_directory_hint: Option<String>,
    pub timeout_ms: Option<u64>,
    pub stdout_limit_bytes: Option<usize>,
    pub stderr_limit_bytes: Option<usize>,
    pub existing_handoff_ids: Vec<String>,
    pub provider_write_requested: bool,
    pub task_mutation_requested: bool,
    pub raw_provider_payload_retention_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadCommandHandoffRecord {
    pub handoff_id: String,
    pub command_handoff_ref: Option<String>,
    pub command_descriptor_id: String,
    pub executor_request_id: String,
    pub executable: String,
    pub argv: Vec<String>,
    pub working_directory_hint: Option<String>,
    pub timeout_ms: Option<u64>,
    pub stdout_limit_bytes: Option<usize>,
    pub stderr_limit_bytes: Option<usize>,
    pub status: ProviderLiveReadCommandHandoffStatus,
    pub blockers: Vec<ProviderLiveReadCommandHandoffBlocker>,
    pub duplicate_handoff_detected: bool,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadCommandHandoffStatus {
    ReadyForReadOnlyCommand,
    RepairRequired,
    Blocked,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadCommandHandoffBlocker {
    CommandDescriptorNotReady,
    MissingCommandHandoffRef,
    MissingWorkingDirectoryHint,
    MissingTimeout,
    MissingStdoutLimit,
    MissingStderrLimit,
    DuplicateHandoff,
    ProviderWriteRequested,
    TaskMutationRequested,
    RawProviderPayloadRetentionRequested,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadCommandResultMappingInput {
    pub request: ProviderLiveReadServerRequestRecord,
    pub descriptor: ProviderLiveReadGhCommandDescriptorRecord,
    pub handoff: ProviderLiveReadCommandHandoffRecord,
    pub command_stdout_json: String,
    pub command_exit_status: Option<i32>,
    pub command_succeeded: bool,
    pub receipt_evidence_ref: Option<String>,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadCommandResultMappingRecord {
    pub mapping_id: String,
    pub handoff_id: String,
    pub command_descriptor_id: String,
    pub executor_request_id: String,
    pub output: ProviderLiveReadSanitizedRepositoryMetadataRecord,
    pub receipt: ProviderLiveReadServerReceiptRecord,
    pub status: ProviderLiveReadCommandResultMappingStatus,
    pub blockers: Vec<ProviderLiveReadCommandResultMappingBlocker>,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadCommandResultMappingStatus {
    MappedSanitizedOutput,
    ParseError,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadCommandResultMappingBlocker {
    HandoffNotReady,
    CommandFailed,
    SanitizedOutputNotReady,
    ReceiptNotReady,
    ProviderWriteExecuted,
    CallbackEffectExecuted,
    InterruptionEffectExecuted,
    RecoveryEffectExecuted,
    TaskMutationExecuted,
    RawProviderPayloadRetained,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadCommandHandoffDiagnostics {
    pub diagnostics_id: String,
    pub handoff_count: usize,
    pub ready_handoff_count: usize,
    pub blocked_handoff_count: usize,
    pub duplicate_handoff_count: usize,
    pub mapping_count: usize,
    pub mapped_output_count: usize,
    pub parse_error_count: usize,
    pub receipt_count: usize,
    pub provider_network_read_performed_count: usize,
    pub blocker_count: usize,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}
