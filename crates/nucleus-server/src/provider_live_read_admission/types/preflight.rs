use serde::{Deserialize, Serialize};

use crate::{ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider};

use super::admission::ProviderLiveReadAdmissionSet;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadPreflightInput {
    pub admissions: ProviderLiveReadAdmissionSet,
    pub endpoint_ref: Option<String>,
    pub idempotency_ref: Option<String>,
    pub preflight_evidence_ref: Option<String>,
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
pub struct ProviderLiveReadPreflightSet {
    pub preflight_set_id: String,
    pub preflights: Vec<ProviderLiveReadPreflightRecord>,
    pub skipped_admission_ids: Vec<String>,
    pub fixture_request_planning_permitted: bool,
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
pub struct ProviderLiveReadPreflightRecord {
    pub preflight_id: String,
    pub admission_id: String,
    pub provider_context_ref: String,
    pub provider_instance_ref: Option<String>,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub remote_repo_ref: Option<String>,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub target_refs: Vec<String>,
    pub credential_status_evidence_refs: Vec<String>,
    pub network_authority_ref: Option<String>,
    pub endpoint_ref: Option<String>,
    pub payload_policy_ref: Option<String>,
    pub idempotency_ref: Option<String>,
    pub sanitization_policy_ref: Option<String>,
    pub admission_evidence_ref: Option<String>,
    pub preflight_evidence_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub status: ProviderLiveReadPreflightStatus,
    pub blockers: Vec<ProviderLiveReadPreflightBlocker>,
    pub fixture_request_planning_permitted: bool,
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
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadPreflightStatus {
    ReadyForRequestReceiptPlanning,
    RepairRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadPreflightBlocker {
    AdmissionNotReady,
    MissingCredentialStatusEvidenceRef,
    MissingNetworkAuthorityRef,
    MissingEndpointRef,
    MissingPayloadPolicyRef,
    MissingIdempotencyRef,
    MissingSanitizationPolicyRef,
    MissingPreflightEvidenceRef,
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
