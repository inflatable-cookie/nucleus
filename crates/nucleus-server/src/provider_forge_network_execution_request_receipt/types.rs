use serde::{Deserialize, Serialize};

use crate::{
    ForgeNetworkExecutionCredentialRef, ForgeNetworkExecutionOperationFamily,
    ForgeNetworkExecutionPreflightRecord, ForgeNetworkExecutionPreflightSet,
    ForgePullRequestProvider,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeNetworkExecutionRequestReceiptInput {
    pub preflights: ForgeNetworkExecutionPreflightSet,
    pub execution_request_evidence_ref: Option<String>,
    pub runtime_receipt_ref: Option<String>,
    pub retry_of_receipt_ref: Option<String>,
    pub recovery_classification_ref: Option<String>,
    pub real_credential_resolution_requested: bool,
    pub provider_network_call_requested: bool,
    pub raw_provider_payload_retention_requested: bool,
    pub callback_execution_requested: bool,
    pub interruption_execution_requested: bool,
    pub recovery_execution_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeNetworkExecutionRequestReceiptSet {
    pub request_receipt_set_id: String,
    pub request_receipts: Vec<ForgeNetworkExecutionRequestReceiptRecord>,
    pub skipped_preflight_ids: Vec<String>,
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
pub struct ForgeNetworkExecutionRequestReceiptRecord {
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
    pub status: ForgeNetworkExecutionRequestReceiptStatus,
    pub receipt_status: ForgeNetworkExecutionReceiptStatus,
    pub blockers: Vec<ForgeNetworkExecutionRequestReceiptBlocker>,
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

impl ForgeNetworkExecutionRequestReceiptRecord {
    pub(super) fn from_preflight(
        preflight: ForgeNetworkExecutionPreflightRecord,
        input: &ForgeNetworkExecutionRequestReceiptInput,
        status: ForgeNetworkExecutionRequestReceiptStatus,
        receipt_status: ForgeNetworkExecutionReceiptStatus,
        blockers: Vec<ForgeNetworkExecutionRequestReceiptBlocker>,
    ) -> Self {
        let stopped_request_recorded =
            status == ForgeNetworkExecutionRequestReceiptStatus::StoppedRequestRecorded;
        let execution_request_id =
            format!("forge-network-execution-request:{}", preflight.preflight_id);

        Self {
            receipt_id: input
                .runtime_receipt_ref
                .clone()
                .unwrap_or_else(|| format!("runtime-receipt:{}", execution_request_id)),
            execution_request_id,
            preflight_id: preflight.preflight_id,
            admission_id: preflight.admission_id,
            request_id: preflight.request_id,
            task_id: preflight.task_id,
            repo_id: preflight.repo_id,
            operator_ref: preflight.operator_ref,
            operation_family: preflight.operation_family,
            forge_provider: preflight.forge_provider,
            credential_ref: preflight.credential_ref,
            network_authority_ref: preflight.network_authority_ref,
            operator_approval_ref: preflight.operator_approval_ref,
            idempotency_key: preflight.idempotency_key,
            retry_policy_ref: preflight.retry_policy_ref,
            recovery_policy_ref: preflight.recovery_policy_ref,
            sanitization_policy_ref: preflight.sanitization_policy_ref,
            provider_context_ref: preflight.provider_context_ref,
            target_provider_ref: preflight.target_provider_ref,
            credential_use_evidence_ref: preflight.credential_use_evidence_ref,
            preflight_evidence_ref: preflight.preflight_evidence_ref,
            provider_response_evidence_ref: preflight.provider_response_evidence_ref,
            execution_request_evidence_ref: input.execution_request_evidence_ref.clone(),
            runtime_receipt_ref: input.runtime_receipt_ref.clone(),
            retry_of_receipt_ref: input.retry_of_receipt_ref.clone(),
            recovery_classification_ref: input.recovery_classification_ref.clone(),
            status,
            receipt_status,
            blockers,
            stopped_request_recorded,
            credential_resolution_performed: false,
            provider_network_call_performed: false,
            forge_effect_executed: false,
            provider_effect_executed: false,
            callback_effect_executed: false,
            interruption_effect_executed: false,
            recovery_effect_executed: false,
            task_mutation_executed: false,
            raw_provider_payload_retained: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeNetworkExecutionRequestReceiptControlDto {
    pub dto_id: String,
    pub request_receipt_set_id: String,
    pub request_receipt_count: usize,
    pub recorded_count: usize,
    pub repair_required_count: usize,
    pub blocked_count: usize,
    pub blocker_count: usize,
    pub skipped_preflight_count: usize,
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
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkExecutionRequestReceiptStatus {
    StoppedRequestRecorded,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkExecutionReceiptStatus {
    AcceptedStopped,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkExecutionRequestReceiptBlocker {
    PreflightNotReady,
    MissingExecutionRequestEvidenceRef,
    MissingRuntimeReceiptRef,
    MissingProviderResponseEvidenceRef,
    MissingCredentialUseEvidenceRef,
    MissingIdempotencyKey,
    MissingRetryPolicyRef,
    MissingRecoveryPolicyRef,
    MissingRecoveryClassificationRef,
    RealCredentialResolutionRequested,
    ProviderNetworkCallRequested,
    RawProviderPayloadRetentionRequested,
    CallbackExecutionRequested,
    InterruptionExecutionRequested,
    RecoveryExecutionRequested,
    TaskMutationRequested,
}
