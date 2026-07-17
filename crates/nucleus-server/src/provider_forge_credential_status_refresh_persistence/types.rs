use crate::provider_no_effects::{ProviderNoEffects, ProviderRuntimeNoEffects};
use serde::{Deserialize, Serialize};

use crate::{
    ForgeCredentialStatusClass, ForgeCredentialStatusRefreshBlocker,
    ForgeCredentialStatusRefreshSet, ForgeCredentialStatusRefreshStatus,
    ForgeNetworkCredentialKind, ForgeNetworkCredentialResolutionBoundary,
    ForgeNetworkCredentialStatus, ForgeNetworkExecutionOperationFamily,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeCredentialStatusRefreshPersistenceInput {
    pub refresh_set: ForgeCredentialStatusRefreshSet,
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
pub struct ForgeCredentialStatusRefreshPersistenceSet {
    pub persistence_set_id: String,
    pub records: Vec<ForgeCredentialStatusRefreshPersistenceRecord>,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeCredentialStatusRefreshPersistenceRecord {
    pub persisted_refresh_id: String,
    pub refresh_id: String,
    pub credential_ref_id: String,
    pub credential_kind: ForgeNetworkCredentialKind,
    pub resolution_boundary: ForgeNetworkCredentialResolutionBoundary,
    pub current_status: ForgeNetworkCredentialStatus,
    pub status_class: ForgeCredentialStatusClass,
    pub allowed_operation_families: Vec<ForgeNetworkExecutionOperationFamily>,
    pub provider_context_ref: Option<String>,
    pub status_refresh_evidence_ref: Option<String>,
    pub sanitization_policy_ref: Option<String>,
    pub refresh_status: ForgeCredentialStatusRefreshStatus,
    pub refresh_blockers: Vec<ForgeCredentialStatusRefreshBlocker>,
    pub persistence_status: ForgeCredentialStatusRefreshPersistenceStatus,
    pub persistence_blockers: Vec<ForgeCredentialStatusRefreshPersistenceBlocker>,
    pub duplicate_refresh_detected: bool,
    pub evidence_refs: Vec<String>,
    pub stopped_refresh_recorded: bool,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeCredentialStatusRefreshPersistenceDiagnostics {
    pub diagnostics_id: String,
    pub refresh_count: usize,
    pub persisted_count: usize,
    pub duplicate_noop_count: usize,
    pub persistence_blocked_count: usize,
    pub ready_refresh_count: usize,
    pub repair_required_refresh_count: usize,
    pub blocked_refresh_count: usize,
    pub ready_credential_count: usize,
    pub repair_credential_count: usize,
    pub unknown_credential_count: usize,
    pub unsupported_credential_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeCredentialStatusRefreshPersistenceControlDto {
    pub dto_id: String,
    pub diagnostics_id: String,
    pub refresh_count: usize,
    pub persisted_count: usize,
    pub duplicate_noop_count: usize,
    pub persistence_blocked_count: usize,
    pub ready_refresh_count: usize,
    pub repair_required_refresh_count: usize,
    pub blocked_refresh_count: usize,
    pub ready_credential_count: usize,
    pub repair_credential_count: usize,
    pub unknown_credential_count: usize,
    pub unsupported_credential_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeCredentialStatusRefreshPersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeCredentialStatusRefreshPersistenceBlocker {
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
