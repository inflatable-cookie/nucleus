use serde::{Deserialize, Serialize};

use crate::ForgeNetworkExecutionOperationFamily;

use super::request_receipt::{
    ProviderLiveReadRequestReceiptBlocker, ProviderLiveReadRequestReceiptSet,
    ProviderLiveReadRequestReceiptStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadPersistenceInput {
    pub request_receipts: ProviderLiveReadRequestReceiptSet,
    pub persistence_evidence_refs: Vec<String>,
    pub existing_persisted_live_read_ids: Vec<String>,
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
pub struct ProviderLiveReadPersistenceSet {
    pub persistence_set_id: String,
    pub records: Vec<ProviderLiveReadPersistenceRecord>,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadPersistenceRecord {
    pub persisted_live_read_id: String,
    pub execution_request_id: String,
    pub preflight_id: String,
    pub admission_id: String,
    pub provider_context_ref: String,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub target_refs: Vec<String>,
    pub idempotency_ref: Option<String>,
    pub request_ref: Option<String>,
    pub planned_receipt_ref: Option<String>,
    pub request_evidence_ref: Option<String>,
    pub request_status: ProviderLiveReadRequestReceiptStatus,
    pub request_blockers: Vec<ProviderLiveReadRequestReceiptBlocker>,
    pub persistence_status: ProviderLiveReadPersistenceStatus,
    pub persistence_blockers: Vec<ProviderLiveReadPersistenceBlocker>,
    pub duplicate_request_detected: bool,
    pub duplicate_live_read_detected: bool,
    pub evidence_refs: Vec<String>,
    pub planned_request_recorded: bool,
    pub live_read_record_persisted: bool,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadPersistenceDiagnostics {
    pub diagnostics_id: String,
    pub live_read_count: usize,
    pub persisted_count: usize,
    pub duplicate_noop_count: usize,
    pub persistence_blocked_count: usize,
    pub planned_request_count: usize,
    pub duplicate_request_count: usize,
    pub repair_required_request_count: usize,
    pub blocked_request_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadPersistenceControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    pub live_read_count: usize,
    pub persisted_count: usize,
    pub duplicate_noop_count: usize,
    pub persistence_blocked_count: usize,
    pub planned_request_count: usize,
    pub duplicate_request_count: usize,
    pub repair_required_request_count: usize,
    pub blocked_request_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadPersistenceBlocker {
    RequestReceiptNotPlanned,
    MissingPersistenceEvidenceRef,
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
