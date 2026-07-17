use crate::provider_no_effects::{ProviderNoEffects, ProviderRuntimeNoEffects};
use serde::{Deserialize, Serialize};

use crate::{
    ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider, ForgeStatusCheckRefreshBlocker,
    ForgeStatusCheckRefreshScope, ForgeStatusCheckRefreshSet, ForgeStatusCheckRefreshStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeStatusCheckRefreshPersistenceInput {
    pub refresh_set: ForgeStatusCheckRefreshSet,
    pub evidence_refs: Vec<String>,
    pub existing_persisted_refresh_ids: Vec<String>,
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
pub struct ForgeStatusCheckRefreshPersistenceSet {
    pub persistence_set_id: String,
    pub records: Vec<ForgeStatusCheckRefreshPersistenceRecord>,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeStatusCheckRefreshPersistenceRecord {
    pub persisted_refresh_id: String,
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
    pub refresh_status: ForgeStatusCheckRefreshStatus,
    pub refresh_blockers: Vec<ForgeStatusCheckRefreshBlocker>,
    pub persistence_status: ForgeStatusCheckRefreshPersistenceStatus,
    pub persistence_blockers: Vec<ForgeStatusCheckRefreshPersistenceBlocker>,
    pub duplicate_refresh_detected: bool,
    pub evidence_refs: Vec<String>,
    pub stopped_refresh_recorded: bool,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeStatusCheckRefreshPersistenceDiagnostics {
    pub diagnostics_id: String,
    pub refresh_count: usize,
    pub persisted_count: usize,
    pub duplicate_noop_count: usize,
    pub persistence_blocked_count: usize,
    pub ready_refresh_count: usize,
    pub repair_required_refresh_count: usize,
    pub blocked_refresh_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeStatusCheckRefreshPersistenceControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    pub refresh_count: usize,
    pub persisted_count: usize,
    pub duplicate_noop_count: usize,
    pub persistence_blocked_count: usize,
    pub ready_refresh_count: usize,
    pub repair_required_refresh_count: usize,
    pub blocked_refresh_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeStatusCheckRefreshPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeStatusCheckRefreshPersistenceBlocker {
    MissingEvidenceRef,
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
