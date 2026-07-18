//! Provider readiness overview response DTO.

use crate::provider_no_effects::ProviderRuntimeNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider,
    ForgeReadIntentProjectionFamily, ForgeReadinessOverview, ForgeReadinessOverviewStatus,
};

/// Serializable provider readiness overview.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlProviderReadinessOverviewDto {
    pub overview_id: String,
    pub projection_id: String,
    pub project_ref: Option<String>,
    pub repo_ref: Option<String>,
    pub authority_host_ref: Option<String>,
    pub provider_instance_refs: Vec<String>,
    pub remote_repo_refs: Vec<String>,
    pub forge_providers: Vec<String>,
    pub status: String,
    pub supported_read_families: Vec<String>,
    pub represented_read_families: Vec<String>,
    pub represented_mutating_families: Vec<String>,
    #[ts(as = "u32")]
    pub total_read_intent_count: usize,
    #[ts(as = "u32")]
    pub missing_evidence_family_count: usize,
    #[ts(as = "u32")]
    pub ready_count: usize,
    #[ts(as = "u32")]
    pub blocked_count: usize,
    #[ts(as = "u32")]
    pub repair_required_count: usize,
    #[ts(as = "u32")]
    pub duplicate_noop_count: usize,
    #[ts(as = "u32")]
    pub blocker_count: usize,
    #[ts(as = "u32")]
    pub evidence_ref_count: usize,
    #[ts(as = "u32")]
    pub approved_live_read_smoke_evidence_count: usize,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

impl From<&ForgeReadinessOverview> for ControlProviderReadinessOverviewDto {
    fn from(overview: &ForgeReadinessOverview) -> Self {
        Self {
            overview_id: overview.overview_id.clone(),
            projection_id: overview.projection_id.clone(),
            project_ref: overview.project_ref.clone(),
            repo_ref: overview.repo_ref.clone(),
            authority_host_ref: overview.authority_host_ref.clone(),
            provider_instance_refs: overview.provider_instance_refs.clone(),
            remote_repo_refs: overview.remote_repo_refs.clone(),
            forge_providers: overview
                .forge_providers
                .iter()
                .map(forge_provider)
                .collect(),
            status: overview_status(&overview.status).to_owned(),
            supported_read_families: overview
                .supported_read_families
                .iter()
                .map(read_family)
                .map(str::to_owned)
                .collect(),
            represented_read_families: overview
                .represented_read_families
                .iter()
                .map(read_family)
                .map(str::to_owned)
                .collect(),
            represented_mutating_families: overview
                .represented_mutating_families
                .iter()
                .map(operation_family)
                .map(str::to_owned)
                .collect(),
            total_read_intent_count: overview.total_read_intent_count,
            missing_evidence_family_count: overview.missing_evidence_family_count,
            ready_count: overview.ready_count,
            blocked_count: overview.blocked_count,
            repair_required_count: overview.repair_required_count,
            duplicate_noop_count: overview.duplicate_noop_count,
            blocker_count: overview.blocker_count,
            evidence_ref_count: overview.evidence_ref_count,
            approved_live_read_smoke_evidence_count: overview
                .approved_live_read_smoke_evidence_count,
        no_effects: overview.no_effects,
        }
    }
}

fn overview_status(status: &ForgeReadinessOverviewStatus) -> &'static str {
    match status {
        ForgeReadinessOverviewStatus::Ready => "ready",
        ForgeReadinessOverviewStatus::Blocked => "blocked",
        ForgeReadinessOverviewStatus::NeedsRepair => "needs_repair",
        ForgeReadinessOverviewStatus::Unknown => "unknown",
        ForgeReadinessOverviewStatus::Unsupported => "unsupported",
    }
}

fn read_family(family: &ForgeReadIntentProjectionFamily) -> &'static str {
    match family {
        ForgeReadIntentProjectionFamily::CredentialStatus => "credential_status",
        ForgeReadIntentProjectionFamily::RepositoryMetadata => "repository_metadata",
        ForgeReadIntentProjectionFamily::PullRequest => "pull_request",
        ForgeReadIntentProjectionFamily::StatusCheck => "status_check",
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
