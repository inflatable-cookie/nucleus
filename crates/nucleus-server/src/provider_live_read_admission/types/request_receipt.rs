use crate::provider_no_effects::ProviderNoEffects;
use serde::{Deserialize, Serialize};

use crate::ForgeNetworkExecutionOperationFamily;

use super::preflight::ProviderLiveReadPreflightSet;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadRequestReceiptInput {
    pub preflights: ProviderLiveReadPreflightSet,
    pub request_ref: Option<String>,
    pub planned_receipt_ref: Option<String>,
    pub request_evidence_ref: Option<String>,
    pub existing_execution_request_ids: Vec<String>,
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
pub struct ProviderLiveReadRequestReceiptSet {
    pub request_receipt_set_id: String,
    pub records: Vec<ProviderLiveReadRequestReceiptRecord>,
    pub skipped_preflight_ids: Vec<String>,
    pub planned_request_recorded: bool,
    #[serde(flatten)]
    pub no_effects: ProviderNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadRequestReceiptRecord {
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
    pub evidence_refs: Vec<String>,
    pub status: ProviderLiveReadRequestReceiptStatus,
    pub blockers: Vec<ProviderLiveReadRequestReceiptBlocker>,
    pub duplicate_request_detected: bool,
    pub planned_request_recorded: bool,
    #[serde(flatten)]
    pub no_effects: ProviderNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadRequestReceiptStatus {
    PlannedRequestRecorded,
    DuplicateNoop,
    RepairRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadRequestReceiptBlocker {
    PreflightNotReady,
    MissingRequestRef,
    MissingPlannedReceiptRef,
    MissingRequestEvidenceRef,
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
