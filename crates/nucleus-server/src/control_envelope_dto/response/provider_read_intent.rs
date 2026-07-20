//! Provider read-intent response DTOs.

use crate::provider_no_effects::ProviderRuntimeNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider, ForgeReadIntentProjectionEntry,
    ForgeReadIntentProjectionFamily, ForgeReadIntentProjectionSet, ForgeReadIntentProjectionStatus,
    ForgeReadIntentQueryResult, ForgeReadIntentQuerySourceCounts,
};

/// Serializable provider read-intent query result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlProviderReadIntentQueryResultDto {
    pub query_id: String,
    pub projection: ControlProviderReadIntentProjectionDto,
    pub source_counts: ControlProviderReadIntentSourceCountsDto,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

impl From<&ForgeReadIntentQueryResult> for ControlProviderReadIntentQueryResultDto {
    fn from(result: &ForgeReadIntentQueryResult) -> Self {
        Self {
            query_id: result.query_id.clone(),
            projection: ControlProviderReadIntentProjectionDto::from(&result.projection),
            source_counts: ControlProviderReadIntentSourceCountsDto::from(&result.source_counts),
            no_effects: result.no_effects,
        }
    }
}

/// Serializable provider read-intent projection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlProviderReadIntentProjectionDto {
    pub projection_id: String,
    #[ts(as = "u32")]
    pub total_count: usize,
    #[ts(as = "u32")]
    pub credential_status_count: usize,
    #[ts(as = "u32")]
    pub repository_metadata_count: usize,
    #[ts(as = "u32")]
    pub pull_request_count: usize,
    #[ts(as = "u32")]
    pub status_check_count: usize,
    #[ts(as = "u32")]
    pub ready_count: usize,
    #[ts(as = "u32")]
    pub duplicate_noop_count: usize,
    #[ts(as = "u32")]
    pub blocked_count: usize,
    #[ts(as = "u32")]
    pub repair_required_count: usize,
    #[ts(as = "u32")]
    pub blocker_count: usize,
    #[ts(as = "u32")]
    pub evidence_ref_count: usize,
    pub entries: Vec<ControlProviderReadIntentEntryDto>,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

impl From<&ForgeReadIntentProjectionSet> for ControlProviderReadIntentProjectionDto {
    fn from(projection: &ForgeReadIntentProjectionSet) -> Self {
        Self {
            projection_id: projection.projection_id.clone(),
            total_count: projection.total_count,
            credential_status_count: projection.credential_status_count,
            repository_metadata_count: projection.repository_metadata_count,
            pull_request_count: projection.pull_request_count,
            status_check_count: projection.status_check_count,
            ready_count: projection.ready_count,
            duplicate_noop_count: projection.duplicate_noop_count,
            blocked_count: projection.blocked_count,
            repair_required_count: projection.repair_required_count,
            blocker_count: projection.blocker_count,
            evidence_ref_count: projection.evidence_ref_count,
            entries: projection
                .entries
                .iter()
                .map(ControlProviderReadIntentEntryDto::from)
                .collect(),
            no_effects: projection.no_effects,
        }
    }
}

/// Serializable provider read-intent entry summary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlProviderReadIntentEntryDto {
    pub intent_id: String,
    pub source_persisted_refresh_id: String,
    pub family: String,
    pub status: String,
    pub provider_context_ref: Option<String>,
    pub provider_instance_ref: Option<String>,
    pub forge_provider: Option<String>,
    pub remote_repo_ref: Option<String>,
    pub operation_family: String,
    #[ts(as = "u32")]
    pub blocker_count: usize,
    #[ts(as = "u32")]
    pub evidence_ref_count: usize,
    pub duplicate_refresh_detected: bool,
    pub stopped_refresh_recorded: bool,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

impl From<&ForgeReadIntentProjectionEntry> for ControlProviderReadIntentEntryDto {
    fn from(entry: &ForgeReadIntentProjectionEntry) -> Self {
        Self {
            intent_id: entry.intent_id.clone(),
            source_persisted_refresh_id: entry.source_persisted_refresh_id.clone(),
            family: projection_family(&entry.family).to_owned(),
            status: projection_status(&entry.status).to_owned(),
            provider_context_ref: entry.provider_context_ref.clone(),
            provider_instance_ref: entry.provider_instance_ref.clone(),
            forge_provider: entry.forge_provider.as_ref().map(forge_provider),
            remote_repo_ref: entry.remote_repo_ref.clone(),
            operation_family: operation_family(&entry.operation_family).to_owned(),
            blocker_count: entry.blocker_count,
            evidence_ref_count: entry.evidence_ref_count,
            duplicate_refresh_detected: entry.duplicate_refresh_detected,
            stopped_refresh_recorded: entry.stopped_refresh_recorded,
            no_effects: entry.no_effects,
        }
    }
}

/// Serializable provider read-intent source counts.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlProviderReadIntentSourceCountsDto {
    #[ts(as = "u32")]
    pub credential_status_records: usize,
    #[ts(as = "u32")]
    pub repository_metadata_records: usize,
    #[ts(as = "u32")]
    pub pull_request_records: usize,
    #[ts(as = "u32")]
    pub status_check_records: usize,
}

impl From<&ForgeReadIntentQuerySourceCounts> for ControlProviderReadIntentSourceCountsDto {
    fn from(counts: &ForgeReadIntentQuerySourceCounts) -> Self {
        Self {
            credential_status_records: counts.credential_status_records,
            repository_metadata_records: counts.repository_metadata_records,
            pull_request_records: counts.pull_request_records,
            status_check_records: counts.status_check_records,
        }
    }
}

fn projection_family(family: &ForgeReadIntentProjectionFamily) -> &'static str {
    match family {
        ForgeReadIntentProjectionFamily::CredentialStatus => "credential_status",
        ForgeReadIntentProjectionFamily::RepositoryMetadata => "repository_metadata",
        ForgeReadIntentProjectionFamily::PullRequest => "pull_request",
        ForgeReadIntentProjectionFamily::StatusCheck => "status_check",
    }
}

fn projection_status(status: &ForgeReadIntentProjectionStatus) -> &'static str {
    match status {
        ForgeReadIntentProjectionStatus::Ready => "ready",
        ForgeReadIntentProjectionStatus::DuplicateNoop => "duplicate_noop",
        ForgeReadIntentProjectionStatus::Blocked => "blocked",
        ForgeReadIntentProjectionStatus::RepairRequired => "repair_required",
    }
}

fn forge_provider(provider: &ForgePullRequestProvider) -> String {
    match provider {
        ForgePullRequestProvider::GitHub => "github",
        ForgePullRequestProvider::GitLab => "gitlab",
        ForgePullRequestProvider::GenericForge => "generic_forge",
    }
    .to_owned()
}

fn operation_family(family: &ForgeNetworkExecutionOperationFamily) -> &'static str {
    match family {
        ForgeNetworkExecutionOperationFamily::ProviderAuthStatusRefresh => {
            "provider_auth_status_refresh"
        }
        ForgeNetworkExecutionOperationFamily::RepositoryMetadataRefresh => {
            "repository_metadata_refresh"
        }
        ForgeNetworkExecutionOperationFamily::PullRequestRefresh => "pull_request_refresh",
        ForgeNetworkExecutionOperationFamily::IssueRefresh => "issue_refresh",
        ForgeNetworkExecutionOperationFamily::CommentRefresh => "comment_refresh",
        ForgeNetworkExecutionOperationFamily::ReviewWorkflowRefresh => "review_workflow_refresh",
        ForgeNetworkExecutionOperationFamily::StatusCheckRefresh => "status_check_refresh",
        ForgeNetworkExecutionOperationFamily::PullRequestCreate => "pull_request_create",
        ForgeNetworkExecutionOperationFamily::PullRequestUpdate => "pull_request_update",
        ForgeNetworkExecutionOperationFamily::CommentCreate => "comment_create",
        ForgeNetworkExecutionOperationFamily::ReviewRequestUpdate => "review_request_update",
        ForgeNetworkExecutionOperationFamily::LabelOrMetadataUpdate => "label_or_metadata_update",
        ForgeNetworkExecutionOperationFamily::StatusCheckUpdate => "status_check_update",
        ForgeNetworkExecutionOperationFamily::Merge => "merge",
        ForgeNetworkExecutionOperationFamily::CloseWithoutReviewOutcome => {
            "close_without_review_outcome"
        }
        ForgeNetworkExecutionOperationFamily::BranchProtectionMutation => {
            "branch_protection_mutation"
        }
        ForgeNetworkExecutionOperationFamily::RepositorySettingMutation => {
            "repository_setting_mutation"
        }
        ForgeNetworkExecutionOperationFamily::ForcePush => "force_push",
        ForgeNetworkExecutionOperationFamily::DestructiveBranchDeletion => {
            "destructive_branch_deletion"
        }
        ForgeNetworkExecutionOperationFamily::ProviderPermissionMutation => {
            "provider_permission_mutation"
        }
    }
}
