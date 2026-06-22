use serde::{Deserialize, Serialize};

use crate::{
    ForgeNetworkExecutionCredentialRef, ForgeNetworkExecutionOperationFamily,
    ForgeNetworkExecutionReceiptStatus, ForgeNetworkExecutionRequestReceiptBlocker,
    ForgeNetworkExecutionRequestReceiptSet, ForgeNetworkExecutionRequestReceiptStatus,
    ForgePullRequestProvider,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeNetworkExecutionOutcomePersistenceInput {
    pub request_receipts: ForgeNetworkExecutionRequestReceiptSet,
    pub requested_status: ForgeNetworkExecutionOutcomeStatus,
    pub inspected_ref_count: usize,
    pub evidence_refs: Vec<String>,
    pub existing_outcome_ids: Vec<String>,
    pub raw_request_body_present: bool,
    pub raw_response_body_present: bool,
    pub raw_headers_present: bool,
    pub credential_material_present: bool,
    pub provider_payload_present: bool,
    pub raw_provider_payload_retention_requested: bool,
    pub real_credential_resolution_requested: bool,
    pub provider_network_call_requested: bool,
    pub callback_execution_requested: bool,
    pub interruption_execution_requested: bool,
    pub recovery_execution_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeNetworkExecutionOutcomePersistenceSet {
    pub outcome_set_id: String,
    pub records: Vec<ForgeNetworkExecutionOutcomePersistenceRecord>,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeNetworkExecutionOutcomePersistenceRecord {
    pub persisted_outcome_id: String,
    pub execution_request_id: String,
    pub receipt_id: String,
    pub preflight_id: String,
    pub admission_id: String,
    pub request_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub credential_ref: Option<ForgeNetworkExecutionCredentialRef>,
    pub network_authority_ref: Option<String>,
    pub operator_approval_ref: Option<String>,
    pub idempotency_key: Option<String>,
    pub retry_policy_ref: Option<String>,
    pub recovery_policy_ref: Option<String>,
    pub sanitization_policy_ref: Option<String>,
    pub provider_context_ref: Option<String>,
    pub target_provider_ref: Option<String>,
    pub credential_use_evidence_ref: Option<String>,
    pub preflight_evidence_ref: Option<String>,
    pub provider_response_evidence_ref: Option<String>,
    pub execution_request_evidence_ref: Option<String>,
    pub runtime_receipt_ref: Option<String>,
    pub retry_of_receipt_ref: Option<String>,
    pub recovery_classification_ref: Option<String>,
    pub request_receipt_status: ForgeNetworkExecutionRequestReceiptStatus,
    pub request_receipt_blockers: Vec<ForgeNetworkExecutionRequestReceiptBlocker>,
    pub receipt_status: ForgeNetworkExecutionReceiptStatus,
    pub outcome_status: ForgeNetworkExecutionOutcomeStatus,
    pub persistence_status: ForgeNetworkExecutionOutcomePersistenceStatus,
    pub persistence_blockers: Vec<ForgeNetworkExecutionOutcomePersistenceBlocker>,
    pub duplicate_outcome_detected: bool,
    pub inspected_ref_count: usize,
    pub evidence_refs: Vec<String>,
    pub stopped_request_recorded: bool,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeNetworkExecutionOutcomeDiagnosticsRecord {
    pub diagnostics_id: String,
    pub outcome_count: usize,
    pub stopped_recorded_count: usize,
    pub failed_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub duplicate_noop_count: usize,
    pub persistence_blocked_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeNetworkExecutionOutcomeControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    pub outcome_count: usize,
    pub stopped_recorded_count: usize,
    pub failed_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub duplicate_noop_count: usize,
    pub persistence_blocked_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkExecutionOutcomeStatus {
    StoppedRecorded,
    Failed,
    Blocked,
    RepairRequired,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkExecutionOutcomePersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkExecutionOutcomePersistenceBlocker {
    MissingEvidenceRef,
    RawRequestBodyPresent,
    RawResponseBodyPresent,
    RawHeadersPresent,
    CredentialMaterialPresent,
    ProviderPayloadPresent,
    RawProviderPayloadRetentionRequested,
    RealCredentialResolutionRequested,
    ProviderNetworkCallRequested,
    CallbackExecutionRequested,
    InterruptionExecutionRequested,
    RecoveryExecutionRequested,
    TaskMutationRequested,
}
