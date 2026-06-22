use serde::{Deserialize, Serialize};

use crate::{GitPushPreflightSet, GitPushRemoteTarget};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPushRunnerAuthorityInput {
    pub preflights: GitPushPreflightSet,
    pub operator_effect_intent: GitPushRunnerOperatorEffectIntent,
    pub raw_output_retention_requested: bool,
    pub pull_request_requested: bool,
    pub forge_effect_requested: bool,
    pub provider_effect_requested: bool,
    pub callback_effect_requested: bool,
    pub interruption_effect_requested: bool,
    pub recovery_effect_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitPushRunnerAuthoritySet {
    pub authority_set_id: String,
    pub authorities: Vec<GitPushRunnerAuthorityRecord>,
    pub skipped_preflight_ids: Vec<String>,
    pub runner_invocation_permitted: bool,
    pub shell_execution_performed: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitPushRunnerAuthorityRecord {
    pub authority_id: String,
    pub preflight_id: String,
    pub descriptor_id: String,
    pub admission_id: String,
    pub commit_preflight_id: String,
    pub commit_descriptor_id: String,
    pub commit_admission_id: String,
    pub branch_worktree_evidence_id: String,
    pub request_id: String,
    pub upstream_authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub operator_confirmation_ref: Option<String>,
    pub remote_target: Option<GitPushRemoteTarget>,
    pub status: GitPushRunnerAuthorityStatus,
    pub blockers: Vec<GitPushRunnerAuthorityBlocker>,
    pub runner_invocation_permitted: bool,
    pub shell_execution_performed: bool,
    pub push_executed: bool,
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitPushRunnerAuthorityStatus {
    ReadyForRunner,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitPushRunnerAuthorityBlocker {
    PreflightNotReady,
    OperatorEffectIntentMissing,
    PushExecutionNotConfirmed,
    MissingRemoteTarget,
    MissingRemoteName,
    MissingBranchName,
    RawOutputRetentionRequested,
    PullRequestRequested,
    ForgeEffectRequested,
    ProviderEffectRequested,
    CallbackEffectRequested,
    InterruptionEffectRequested,
    RecoveryEffectRequested,
    TaskMutationRequested,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitPushRunnerOperatorEffectIntent {
    Missing,
    Confirmed {
        confirmation_ref: String,
        allow_push_execution: bool,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct GitPushRunnerAuthorityContext {
    pub operator_effect_intent: GitPushRunnerOperatorEffectIntent,
    pub raw_output_retention_requested: bool,
    pub pull_request_requested: bool,
    pub forge_effect_requested: bool,
    pub provider_effect_requested: bool,
    pub callback_effect_requested: bool,
    pub interruption_effect_requested: bool,
    pub recovery_effect_requested: bool,
    pub task_mutation_requested: bool,
}
