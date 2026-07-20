use crate::provider_no_effects::ForgeScmNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    ForgePullRequestProvider, ForgePullRequestRunnerAuthoritySet, ForgePullRequestTextSource,
    GitPushRemoteTarget,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestRunnerRequestAdapterInput {
    pub authorities: ForgePullRequestRunnerAuthoritySet,
    pub shell_passthrough_requested: bool,
    pub raw_output_retention_requested: bool,
    pub pull_request_creation_requested: bool,
    pub forge_effect_requested: bool,
    pub provider_effect_requested: bool,
    pub callback_effect_requested: bool,
    pub interruption_effect_requested: bool,
    pub recovery_effect_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestRunnerRequestAdapterSet {
    pub request_set_id: String,
    pub requests: Vec<ForgePullRequestRunnerRequestAdapterRecord>,
    pub skipped_authority_ids: Vec<String>,
    pub provider_request_prepared: bool,
    pub shell_passthrough_used: bool,
    pub shell_execution_performed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestRunnerRequestAdapterRecord {
    pub request_adapter_id: String,
    pub authority_id: String,
    pub preflight_id: String,
    pub admission_id: String,
    pub pr_evidence_id: String,
    pub pr_descriptor_id: String,
    pub push_preflight_id: String,
    pub request_id: String,
    pub upstream_authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub operator_confirmation_ref: Option<String>,
    pub remote_target: Option<GitPushRemoteTarget>,
    pub forge_provider: Option<ForgePullRequestProvider>,
    pub base_branch: Option<String>,
    pub head_branch: Option<String>,
    pub title_source: Option<ForgePullRequestTextSource>,
    pub body_source: Option<ForgePullRequestTextSource>,
    pub status: ForgePullRequestRunnerRequestAdapterStatus,
    pub blockers: Vec<ForgePullRequestRunnerRequestAdapterBlocker>,
    pub provider_request_prepared: bool,
    pub shell_passthrough_used: bool,
    pub shell_execution_performed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestRunnerRequestAdapterStatus {
    Ready,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestRunnerRequestAdapterBlocker {
    AuthorityNotReady,
    MissingForgeProvider,
    MissingBaseBranch,
    MissingHeadBranch,
    MissingTitleSource,
    MissingBodySource,
    ShellPassthroughRequested,
    RawOutputRetentionRequested,
    PullRequestCreationRequested,
    ForgeEffectRequested,
    ProviderEffectRequested,
    CallbackEffectRequested,
    InterruptionEffectRequested,
    RecoveryEffectRequested,
    TaskMutationRequested,
}
