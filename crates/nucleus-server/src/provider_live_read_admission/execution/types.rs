use serde::{Deserialize, Serialize};

use crate::ForgeNetworkExecutionOperationFamily;

use super::super::{ProviderLiveReadPersistenceRecord, ProviderLiveReadPersistenceSet};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadCapabilityRecord {
    pub capability_ref: String,
    pub provider_family_ref: String,
    pub supported_operation_families: Vec<ForgeNetworkExecutionOperationFamily>,
    pub supports_conditional_requests: bool,
    pub supports_rate_limit_metadata: bool,
    pub supports_cancellation: bool,
    pub provider_specific_limits_ref: Option<String>,
    pub credential_lease_required: bool,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadStoppedHandoffInput {
    pub persisted_live_reads: ProviderLiveReadPersistenceSet,
    pub capability: ProviderLiveReadCapabilityRecord,
    pub credential_lease_ref: Option<String>,
    pub network_read_authority_ref: Option<String>,
    pub fixture_client_ref: Option<String>,
    pub sanitization_policy_ref: Option<String>,
    pub handoff_evidence_ref: Option<String>,
    pub existing_handoff_ids: Vec<String>,
    pub credential_material_present: bool,
    pub provider_payload_present: bool,
    pub raw_provider_payload_retention_requested: bool,
    pub real_credential_resolution_requested: bool,
    pub provider_network_call_requested: bool,
    pub provider_write_requested: bool,
    pub callback_execution_requested: bool,
    pub interruption_execution_requested: bool,
    pub recovery_execution_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadStoppedHandoffSet {
    pub handoff_set_id: String,
    pub records: Vec<ProviderLiveReadStoppedHandoffRecord>,
    pub ready_handoff_ids: Vec<String>,
    pub blocked_handoff_ids: Vec<String>,
    pub duplicate_handoff_ids: Vec<String>,
    pub repair_required_handoff_ids: Vec<String>,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadStoppedHandoffRecord {
    pub handoff_id: String,
    pub persisted_live_read_id: String,
    pub execution_request_id: String,
    pub provider_context_ref: String,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub target_refs: Vec<String>,
    pub request_ref: Option<String>,
    pub planned_receipt_ref: Option<String>,
    pub credential_lease_ref: Option<String>,
    pub network_read_authority_ref: Option<String>,
    pub fixture_client_ref: Option<String>,
    pub capability_ref: String,
    pub sanitization_policy_ref: Option<String>,
    pub handoff_evidence_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub status: ProviderLiveReadStoppedHandoffStatus,
    pub blockers: Vec<ProviderLiveReadStoppedHandoffBlocker>,
    pub duplicate_handoff_detected: bool,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadStoppedHandoffStatus {
    ReadyForFixtureResponse,
    RepairRequired,
    Blocked,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadStoppedHandoffBlocker {
    PersistedLiveReadNotReady,
    MissingCredentialLeaseRef,
    MissingNetworkReadAuthorityRef,
    MissingFixtureClientRef,
    MissingSanitizationPolicyRef,
    MissingHandoffEvidenceRef,
    CapabilityDoesNotSupportOperationFamily,
    DuplicateHandoff,
    CredentialMaterialPresent,
    ProviderPayloadPresent,
    RawProviderPayloadRetentionRequested,
    RealCredentialResolutionRequested,
    ProviderNetworkCallRequested,
    ProviderWriteRequested,
    CallbackExecutionRequested,
    InterruptionExecutionRequested,
    RecoveryExecutionRequested,
    TaskMutationRequested,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadFixtureResponseInput {
    pub handoffs: ProviderLiveReadStoppedHandoffSet,
    pub response_summary_ref: Option<String>,
    pub response_evidence_ref: Option<String>,
    pub provider_status_class_ref: Option<String>,
    pub provider_error_class_ref: Option<String>,
    pub retry_hint_ref: Option<String>,
    pub rate_limit_ref: Option<String>,
    pub cancellation_ref: Option<String>,
    pub existing_response_ids: Vec<String>,
    pub credential_material_present: bool,
    pub provider_payload_present: bool,
    pub raw_provider_payload_retention_requested: bool,
    pub real_credential_resolution_requested: bool,
    pub provider_network_call_requested: bool,
    pub provider_write_requested: bool,
    pub callback_execution_requested: bool,
    pub interruption_execution_requested: bool,
    pub recovery_execution_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadFixtureResponseSet {
    pub response_set_id: String,
    pub records: Vec<ProviderLiveReadFixtureResponseRecord>,
    pub ready_response_ids: Vec<String>,
    pub blocked_response_ids: Vec<String>,
    pub retryable_response_ids: Vec<String>,
    pub non_retryable_response_ids: Vec<String>,
    pub duplicate_response_ids: Vec<String>,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadFixtureResponseRecord {
    pub response_id: String,
    pub handoff_id: String,
    pub persisted_live_read_id: String,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub response_summary_ref: Option<String>,
    pub response_evidence_ref: Option<String>,
    pub provider_status_class_ref: Option<String>,
    pub provider_error_class_ref: Option<String>,
    pub retry_hint_ref: Option<String>,
    pub rate_limit_ref: Option<String>,
    pub cancellation_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub status: ProviderLiveReadFixtureResponseStatus,
    pub blockers: Vec<ProviderLiveReadFixtureResponseBlocker>,
    pub duplicate_response_detected: bool,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadFixtureResponseStatus {
    SanitizedResponseReady,
    RetryableError,
    NonRetryableError,
    Blocked,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadFixtureResponseBlocker {
    HandoffNotReady,
    MissingResponseSummaryRef,
    MissingResponseEvidenceRef,
    MissingProviderStatusClassRef,
    MissingProviderErrorClassRef,
    DuplicateResponse,
    CredentialMaterialPresent,
    ProviderPayloadPresent,
    RawProviderPayloadRetentionRequested,
    RealCredentialResolutionRequested,
    ProviderNetworkCallRequested,
    ProviderWriteRequested,
    CallbackExecutionRequested,
    InterruptionExecutionRequested,
    RecoveryExecutionRequested,
    TaskMutationRequested,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadExecutionDiagnostics {
    pub diagnostics_id: String,
    pub response_count: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub retryable_error_count: usize,
    pub non_retryable_error_count: usize,
    pub duplicate_noop_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub provider_network_call_performed: bool,
    pub credential_resolution_performed: bool,
    pub provider_write_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

pub(super) fn handoff_id(record: &ProviderLiveReadPersistenceRecord) -> String {
    format!(
        "provider-live-read-stopped-handoff:{}",
        record.persisted_live_read_id
    )
}
