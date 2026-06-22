//! Provider read-intent response DTOs.

use serde::{Deserialize, Serialize};

use crate::{
    ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider, ForgeReadIntentProjectionEntry,
    ForgeReadIntentProjectionFamily, ForgeReadIntentProjectionSet, ForgeReadIntentProjectionStatus,
    ForgeReadIntentQueryResult, ForgeReadIntentQuerySourceCounts,
};

/// Serializable provider read-intent query result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProviderReadIntentQueryResultDto {
    pub query_id: String,
    pub projection: ControlProviderReadIntentProjectionDto,
    pub source_counts: ControlProviderReadIntentSourceCountsDto,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

impl From<&ForgeReadIntentQueryResult> for ControlProviderReadIntentQueryResultDto {
    fn from(result: &ForgeReadIntentQueryResult) -> Self {
        Self {
            query_id: result.query_id.clone(),
            projection: ControlProviderReadIntentProjectionDto::from(&result.projection),
            source_counts: ControlProviderReadIntentSourceCountsDto::from(&result.source_counts),
            credential_resolution_performed: result.credential_resolution_performed,
            provider_network_call_performed: result.provider_network_call_performed,
            provider_effect_executed: result.provider_effect_executed,
            callback_effect_executed: result.callback_effect_executed,
            interruption_effect_executed: result.interruption_effect_executed,
            recovery_effect_executed: result.recovery_effect_executed,
            task_mutation_executed: result.task_mutation_executed,
            raw_provider_payload_retained: result.raw_provider_payload_retained,
        }
    }
}

/// Serializable provider read-intent projection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProviderReadIntentProjectionDto {
    pub projection_id: String,
    pub total_count: usize,
    pub credential_status_count: usize,
    pub repository_metadata_count: usize,
    pub pull_request_count: usize,
    pub ready_count: usize,
    pub duplicate_noop_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub entries: Vec<ControlProviderReadIntentEntryDto>,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

impl From<&ForgeReadIntentProjectionSet> for ControlProviderReadIntentProjectionDto {
    fn from(projection: &ForgeReadIntentProjectionSet) -> Self {
        Self {
            projection_id: projection.projection_id.clone(),
            total_count: projection.total_count,
            credential_status_count: projection.credential_status_count,
            repository_metadata_count: projection.repository_metadata_count,
            pull_request_count: projection.pull_request_count,
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
            credential_resolution_performed: projection.credential_resolution_performed,
            provider_network_call_performed: projection.provider_network_call_performed,
            provider_effect_executed: projection.provider_effect_executed,
            callback_effect_executed: projection.callback_effect_executed,
            interruption_effect_executed: projection.interruption_effect_executed,
            recovery_effect_executed: projection.recovery_effect_executed,
            task_mutation_executed: projection.task_mutation_executed,
            raw_provider_payload_retained: projection.raw_provider_payload_retained,
        }
    }
}

/// Serializable provider read-intent entry summary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
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
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub duplicate_refresh_detected: bool,
    pub stopped_refresh_recorded: bool,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
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
            credential_resolution_performed: entry.credential_resolution_performed,
            provider_network_call_performed: entry.provider_network_call_performed,
            provider_effect_executed: entry.provider_effect_executed,
            callback_effect_executed: entry.callback_effect_executed,
            interruption_effect_executed: entry.interruption_effect_executed,
            recovery_effect_executed: entry.recovery_effect_executed,
            task_mutation_executed: entry.task_mutation_executed,
            raw_provider_payload_retained: entry.raw_provider_payload_retained,
        }
    }
}

/// Serializable provider read-intent source counts.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProviderReadIntentSourceCountsDto {
    pub credential_status_records: usize,
    pub repository_metadata_records: usize,
    pub pull_request_records: usize,
}

impl From<&ForgeReadIntentQuerySourceCounts> for ControlProviderReadIntentSourceCountsDto {
    fn from(counts: &ForgeReadIntentQuerySourceCounts) -> Self {
        Self {
            credential_status_records: counts.credential_status_records,
            repository_metadata_records: counts.repository_metadata_records,
            pull_request_records: counts.pull_request_records,
        }
    }
}

fn projection_family(family: &ForgeReadIntentProjectionFamily) -> &'static str {
    match family {
        ForgeReadIntentProjectionFamily::CredentialStatus => "credential_status",
        ForgeReadIntentProjectionFamily::RepositoryMetadata => "repository_metadata",
        ForgeReadIntentProjectionFamily::PullRequest => "pull_request",
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
