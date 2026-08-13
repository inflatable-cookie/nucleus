use crate::provider_no_effects::ForgeScmNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    ForgePullRequestExecutionPreflightSet, ForgePullRequestProvider, ForgePullRequestTextSource,
    GitPushRemoteTarget,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestRunnerAuthorityInput {
    pub preflights: ForgePullRequestExecutionPreflightSet,
    pub operator_effect_intent: ForgePullRequestRunnerOperatorEffectIntent,
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
pub struct ForgePullRequestRunnerAuthoritySet {
    pub authority_set_id: String,
    pub authorities: Vec<ForgePullRequestRunnerAuthorityRecord>,
    pub skipped_preflight_ids: Vec<String>,
    pub request_preparation_permitted: bool,
    pub pull_request_creation_permitted: bool,
    pub shell_execution_performed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

/// Operator-confirmed PR-creation scope for one run delivery: the forge
/// provider, base and head refs, and title/body sources on top of the
/// confirmed remote. Title and body are source refs only; raw PR title/body
/// text never travels through the intent records.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestCreationScope {
    pub forge_provider: ForgePullRequestProvider,
    pub base_branch: String,
    pub head_branch: String,
    pub title_source: ForgePullRequestTextSource,
    pub body_source: ForgePullRequestTextSource,
}

impl ForgePullRequestCreationScope {
    pub fn is_complete(&self) -> bool {
        !self.base_branch.trim().is_empty()
            && !self.head_branch.trim().is_empty()
            && !self.base_branch.contains('\0')
            && !self.head_branch.contains('\0')
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestRunnerAuthorityRecord {
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
    pub status: ForgePullRequestRunnerAuthorityStatus,
    pub blockers: Vec<ForgePullRequestRunnerAuthorityBlocker>,
    pub request_preparation_permitted: bool,
    pub pull_request_creation_permitted: bool,
    pub shell_execution_performed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestRunnerAuthorityStatus {
    ReadyForRequest,
    ReadyForCreation,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestRunnerAuthorityBlocker {
    PreflightNotReady,
    OperatorEffectIntentMissing,
    RequestPreparationNotConfirmed,
    PullRequestCreationScopeMissing,
    PullRequestCreationScopeMismatch,
    MissingForgeProvider,
    MissingBaseBranch,
    MissingHeadBranch,
    MissingTitleSource,
    MissingBodySource,
    RawOutputRetentionRequested,
    PullRequestCreationRequested,
    ForgeEffectRequested,
    ProviderEffectRequested,
    CallbackEffectRequested,
    InterruptionEffectRequested,
    RecoveryEffectRequested,
    TaskMutationRequested,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForgePullRequestRunnerOperatorEffectIntent {
    Missing,
    Confirmed {
        confirmation_ref: String,
        allow_request_preparation: bool,
    },
    /// Operator-confirmed per-delivery PR creation carrying the confirmed
    /// creation scope (forge provider, base/head refs, title/body sources) on
    /// top of the confirmed remote.
    PullRequestCreationConfirmed {
        confirmation_ref: String,
        scope: ForgePullRequestCreationScope,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ForgePullRequestRunnerAuthorityContext {
    pub operator_effect_intent: ForgePullRequestRunnerOperatorEffectIntent,
    pub raw_output_retention_requested: bool,
    pub pull_request_creation_requested: bool,
    pub forge_effect_requested: bool,
    pub provider_effect_requested: bool,
    pub callback_effect_requested: bool,
    pub interruption_effect_requested: bool,
    pub recovery_effect_requested: bool,
    pub task_mutation_requested: bool,
}
