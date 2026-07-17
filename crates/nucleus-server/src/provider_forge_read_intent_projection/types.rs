use crate::provider_no_effects::{ProviderNoEffects, ProviderRuntimeNoEffects};
use serde::{Deserialize, Serialize};

use crate::{
    ForgeCredentialStatusRefreshPersistenceRecord, ForgeNetworkExecutionOperationFamily,
    ForgePullRequestProvider, ForgePullRequestRefreshPersistenceRecord,
    ForgeRepositoryMetadataRefreshPersistenceRecord, ForgeStatusCheckRefreshPersistenceRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeReadIntentProjectionInput {
    pub credential_status_records: Vec<ForgeCredentialStatusRefreshPersistenceRecord>,
    pub repository_metadata_records: Vec<ForgeRepositoryMetadataRefreshPersistenceRecord>,
    pub pull_request_records: Vec<ForgePullRequestRefreshPersistenceRecord>,
    pub status_check_records: Vec<ForgeStatusCheckRefreshPersistenceRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeReadIntentProjectionSet {
    pub projection_id: String,
    pub total_count: usize,
    pub credential_status_count: usize,
    pub repository_metadata_count: usize,
    pub pull_request_count: usize,
    pub status_check_count: usize,
    pub ready_count: usize,
    pub duplicate_noop_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub entries: Vec<ForgeReadIntentProjectionEntry>,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeReadIntentProjectionEntry {
    pub intent_id: String,
    pub source_persisted_refresh_id: String,
    pub family: ForgeReadIntentProjectionFamily,
    pub status: ForgeReadIntentProjectionStatus,
    pub provider_context_ref: Option<String>,
    pub provider_instance_ref: Option<String>,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub remote_repo_ref: Option<String>,
    pub operation_family: ForgeNetworkExecutionOperationFamily,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub duplicate_refresh_detected: bool,
    pub stopped_refresh_recorded: bool,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeReadIntentProjectionControlDto {
    pub dto_id: String,
    pub projection_id: String,
    pub total_count: usize,
    pub credential_status_count: usize,
    pub repository_metadata_count: usize,
    pub pull_request_count: usize,
    pub status_check_count: usize,
    pub ready_count: usize,
    pub duplicate_noop_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeReadIntentProjectionFamily {
    CredentialStatus,
    RepositoryMetadata,
    PullRequest,
    StatusCheck,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeReadIntentProjectionStatus {
    Ready,
    DuplicateNoop,
    Blocked,
    RepairRequired,
}
