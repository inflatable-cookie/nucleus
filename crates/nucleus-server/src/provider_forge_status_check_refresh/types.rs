use crate::provider_no_effects::{ProviderNoEffects, ProviderRuntimeNoEffects};
use serde::{Deserialize, Serialize};

use crate::{ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeStatusCheckRefreshInput {
    pub provider_context_refs: Vec<String>,
    pub provider_instance_ref: Option<String>,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub remote_repo_ref: Option<String>,
    pub refresh_scope: Option<ForgeStatusCheckRefreshScope>,
    pub credential_status_evidence_ref: Option<String>,
    pub repository_metadata_evidence_ref: Option<String>,
    pub status_check_refresh_evidence_ref: Option<String>,
    pub sanitization_policy_ref: Option<String>,
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
pub struct ForgeStatusCheckRefreshSet {
    pub refresh_set_id: String,
    pub records: Vec<ForgeStatusCheckRefreshRecord>,
    pub skipped_provider_context_refs: Vec<String>,
    pub stopped_refresh_recorded: bool,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeStatusCheckRefreshRecord {
    pub refresh_id: String,
    pub provider_context_ref: String,
    pub provider_instance_ref: Option<String>,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub remote_repo_ref: Option<String>,
    pub refresh_scope: Option<ForgeStatusCheckRefreshScope>,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub credential_status_evidence_ref: Option<String>,
    pub repository_metadata_evidence_ref: Option<String>,
    pub status_check_refresh_evidence_ref: Option<String>,
    pub sanitization_policy_ref: Option<String>,
    pub status: ForgeStatusCheckRefreshStatus,
    pub blockers: Vec<ForgeStatusCheckRefreshBlocker>,
    pub stopped_refresh_recorded: bool,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeStatusCheckRefreshControlDto {
    pub dto_id: String,
    pub refresh_set_id: String,
    pub refresh_count: usize,
    pub ready_count: usize,
    pub repair_required_count: usize,
    pub blocked_count: usize,
    pub blocker_count: usize,
    pub skipped_provider_context_count: usize,
    pub stopped_refresh_recorded: bool,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeStatusCheckRefreshScope {
    ChangeRequestRef(String),
    CommitRef(String),
    BranchRef(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeStatusCheckRefreshStatus {
    ReadyForStoppedRefresh,
    RepairRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeStatusCheckRefreshBlocker {
    EmptyProviderContextRef,
    MissingProviderInstanceRef,
    MissingForgeProvider,
    MissingRemoteRepoRef,
    MissingRefreshScope,
    EmptyChangeRequestRef,
    EmptyCommitRef,
    EmptyBranchRef,
    MissingCredentialStatusEvidenceRef,
    MissingRepositoryMetadataEvidenceRef,
    MissingStatusCheckRefreshEvidenceRef,
    MissingSanitizationPolicyRef,
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
