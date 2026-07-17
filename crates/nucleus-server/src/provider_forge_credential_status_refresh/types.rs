use crate::provider_no_effects::ProviderRuntimeNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    ForgeNetworkCredentialKind, ForgeNetworkCredentialResolutionBoundary,
    ForgeNetworkCredentialStatus, ForgeNetworkExecutionCredentialRef,
    ForgeNetworkExecutionOperationFamily,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeCredentialStatusRefreshInput {
    pub credential_refs: Vec<ForgeNetworkExecutionCredentialRef>,
    pub provider_context_ref: Option<String>,
    pub status_refresh_evidence_ref: Option<String>,
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
pub struct ForgeCredentialStatusRefreshSet {
    pub refresh_set_id: String,
    pub records: Vec<ForgeCredentialStatusRefreshRecord>,
    pub skipped_credential_ref_ids: Vec<String>,
    pub stopped_refresh_recorded: bool,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeCredentialStatusRefreshRecord {
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
    pub status: ForgeCredentialStatusRefreshStatus,
    pub blockers: Vec<ForgeCredentialStatusRefreshBlocker>,
    pub stopped_refresh_recorded: bool,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeCredentialStatusRefreshControlDto {
    pub dto_id: String,
    pub refresh_set_id: String,
    pub refresh_count: usize,
    pub ready_count: usize,
    pub repair_required_count: usize,
    pub blocked_count: usize,
    pub ready_credential_count: usize,
    pub repair_credential_count: usize,
    pub unknown_credential_count: usize,
    pub unsupported_credential_count: usize,
    pub blocker_count: usize,
    pub skipped_credential_ref_count: usize,
    pub stopped_refresh_recorded: bool,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeCredentialStatusClass {
    Ready,
    RequiresRepair,
    Unknown,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeCredentialStatusRefreshStatus {
    ReadyForStoppedRefresh,
    RepairRequired,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeCredentialStatusRefreshBlocker {
    MissingProviderContextRef,
    MissingStatusRefreshEvidenceRef,
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
