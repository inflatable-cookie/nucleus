use serde::{Deserialize, Serialize};

use crate::{
    ForgeNetworkExecutionAdmissionRecord, ForgeNetworkExecutionAdmissionSet,
    ForgeNetworkExecutionCredentialRef, ForgeNetworkExecutionOperationFamily,
    ForgePullRequestProvider, ForgePullRequestTextSource, GitPushRemoteTarget,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeNetworkExecutionPreflightInput {
    pub admissions: ForgeNetworkExecutionAdmissionSet,
    pub provider_context_ref: Option<String>,
    pub target_provider_ref: Option<String>,
    pub credential_use_evidence_ref: Option<String>,
    pub preflight_evidence_ref: Option<String>,
    pub provider_response_evidence_ref: Option<String>,
    pub real_credential_resolution_requested: bool,
    pub provider_network_call_requested: bool,
    pub raw_provider_payload_retention_requested: bool,
    pub callback_execution_requested: bool,
    pub interruption_execution_requested: bool,
    pub recovery_execution_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeNetworkExecutionPreflightSet {
    pub preflight_set_id: String,
    pub preflights: Vec<ForgeNetworkExecutionPreflightRecord>,
    pub skipped_admission_ids: Vec<String>,
    pub stopped_execution_request_permitted: bool,
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
pub struct ForgeNetworkExecutionPreflightRecord {
    pub preflight_id: String,
    pub admission_id: String,
    pub request_adapter_id: String,
    pub request_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
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
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub remote_target: Option<GitPushRemoteTarget>,
    pub base_branch: Option<String>,
    pub head_branch: Option<String>,
    pub title_source: Option<ForgePullRequestTextSource>,
    pub body_source: Option<ForgePullRequestTextSource>,
    pub status: ForgeNetworkExecutionPreflightStatus,
    pub blockers: Vec<ForgeNetworkExecutionPreflightBlocker>,
    pub stopped_execution_request_permitted: bool,
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

impl ForgeNetworkExecutionPreflightRecord {
    pub(super) fn from_admission(
        admission: ForgeNetworkExecutionAdmissionRecord,
        status: ForgeNetworkExecutionPreflightStatus,
        blockers: Vec<ForgeNetworkExecutionPreflightBlocker>,
        input: &ForgeNetworkExecutionPreflightInput,
    ) -> Self {
        let stopped_execution_request_permitted =
            status == ForgeNetworkExecutionPreflightStatus::ReadyForStoppedExecutionRequest;

        Self {
            preflight_id: format!(
                "forge-network-execution-preflight:{}",
                admission.admission_id
            ),
            admission_id: admission.admission_id,
            request_adapter_id: admission.request_adapter_id,
            request_id: admission.request_id,
            task_id: admission.task_id,
            repo_id: admission.repo_id,
            operator_ref: admission.operator_ref,
            operation_family: admission.operation_family,
            credential_ref: admission.credential_ref,
            network_authority_ref: admission.network_authority_ref,
            operator_approval_ref: admission.operator_approval_ref,
            idempotency_key: admission.idempotency_key,
            retry_policy_ref: admission.retry_policy_ref,
            recovery_policy_ref: admission.recovery_policy_ref,
            sanitization_policy_ref: admission.sanitization_policy_ref,
            provider_context_ref: input.provider_context_ref.clone(),
            target_provider_ref: input.target_provider_ref.clone(),
            credential_use_evidence_ref: input.credential_use_evidence_ref.clone(),
            preflight_evidence_ref: input.preflight_evidence_ref.clone(),
            provider_response_evidence_ref: input.provider_response_evidence_ref.clone(),
            forge_provider: admission.forge_provider,
            remote_target: admission.remote_target,
            base_branch: admission.base_branch,
            head_branch: admission.head_branch,
            title_source: admission.title_source,
            body_source: admission.body_source,
            status,
            blockers,
            stopped_execution_request_permitted,
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
pub struct ForgeNetworkExecutionPreflightControlDto {
    pub dto_id: String,
    pub preflight_set_id: String,
    pub preflight_count: usize,
    pub ready_count: usize,
    pub repair_required_count: usize,
    pub blocked_count: usize,
    pub blocker_count: usize,
    pub skipped_admission_count: usize,
    pub stopped_execution_request_permitted: bool,
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
pub enum ForgeNetworkExecutionPreflightStatus {
    ReadyForStoppedExecutionRequest,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeNetworkExecutionPreflightBlocker {
    AdmissionNotReady,
    MissingForgeProvider,
    MissingProviderContextRef,
    MissingTargetProviderRef,
    MissingCredentialUseEvidenceRef,
    MissingPreflightEvidenceRef,
    MissingProviderResponseEvidenceRef,
    MissingNetworkAuthorityRef,
    MissingOperatorApprovalRef,
    MissingIdempotencyKey,
    MissingRetryPolicyRef,
    MissingRecoveryPolicyRef,
    MissingSanitizationPolicyRef,
    DeferredOperationFamily,
    RealCredentialResolutionRequested,
    ProviderNetworkCallRequested,
    RawProviderPayloadRetentionRequested,
    CallbackExecutionRequested,
    InterruptionExecutionRequested,
    RecoveryExecutionRequested,
    TaskMutationRequested,
}
