use crate::provider_no_effects::ProviderNoEffects;
use serde::{Deserialize, Serialize};

use crate::{ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLiveReadAdmissionInput {
    pub provider_context_refs: Vec<String>,
    pub provider_instance_ref: Option<String>,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub remote_repo_ref: Option<String>,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub target_refs: Vec<String>,
    pub credential_status_evidence_refs: Vec<String>,
    pub network_authority_ref: Option<String>,
    pub payload_policy_ref: Option<String>,
    pub sanitization_policy_ref: Option<String>,
    pub admission_evidence_ref: Option<String>,
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
pub struct ProviderLiveReadAdmissionSet {
    pub admission_set_id: String,
    pub records: Vec<ProviderLiveReadAdmissionRecord>,
    pub skipped_provider_context_refs: Vec<String>,
    pub fixture_preflight_permitted: bool,
    #[serde(flatten)]
    pub no_effects: ProviderNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadAdmissionRecord {
    pub admission_id: String,
    pub provider_context_ref: String,
    pub provider_instance_ref: Option<String>,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub remote_repo_ref: Option<String>,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub target_refs: Vec<String>,
    pub credential_status_evidence_refs: Vec<String>,
    pub network_authority_ref: Option<String>,
    pub payload_policy_ref: Option<String>,
    pub sanitization_policy_ref: Option<String>,
    pub admission_evidence_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub status: ProviderLiveReadAdmissionStatus,
    pub blockers: Vec<ProviderLiveReadAdmissionBlocker>,
    pub fixture_preflight_permitted: bool,
    #[serde(flatten)]
    pub no_effects: ProviderNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderLiveReadAdmissionControlDto {
    pub dto_id: String,
    pub admission_set_id: String,
    pub admission_count: usize,
    pub ready_count: usize,
    pub repair_required_count: usize,
    pub unsupported_count: usize,
    pub blocked_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub skipped_provider_context_count: usize,
    pub fixture_preflight_permitted: bool,
    #[serde(flatten)]
    pub no_effects: ProviderNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadAdmissionStatus {
    ReadyForFixturePreflight,
    RepairRequired,
    Unsupported,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLiveReadAdmissionBlocker {
    EmptyProviderContextRef,
    MissingProviderInstanceRef,
    MissingForgeProvider,
    MissingRemoteRepoRef,
    MissingTargetRef,
    MissingCredentialStatusEvidenceRef,
    MissingNetworkAuthorityRef,
    MissingPayloadPolicyRef,
    MissingSanitizationPolicyRef,
    MissingAdmissionEvidenceRef,
    UnsupportedOperationFamily,
    MutatingOperationFamily,
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
