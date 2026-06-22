use serde::{Deserialize, Serialize};

use crate::{GitBranchWorktreeMode, GitCommitMessageSource, GitCommitPreflightSet};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitRunnerAuthorityInput {
    pub preflights: GitCommitPreflightSet,
    pub operator_effect_intent: GitCommitRunnerOperatorEffectIntent,
    pub target_refs: Vec<GitCommitRunnerTargetRef>,
    pub raw_output_retention_requested: bool,
    pub push_requested: bool,
    pub pull_request_requested: bool,
    pub forge_effect_requested: bool,
    pub provider_effect_requested: bool,
    pub callback_effect_requested: bool,
    pub interruption_effect_requested: bool,
    pub recovery_effect_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitCommitRunnerAuthoritySet {
    pub authority_set_id: String,
    pub authorities: Vec<GitCommitRunnerAuthorityRecord>,
    pub skipped_preflight_ids: Vec<String>,
    pub runner_invocation_permitted: bool,
    pub shell_execution_performed: bool,
    pub commit_created: bool,
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
pub struct GitCommitRunnerAuthorityRecord {
    pub authority_id: String,
    pub preflight_id: String,
    pub descriptor_id: String,
    pub admission_id: String,
    pub branch_worktree_evidence_id: String,
    pub branch_worktree_outcome_id: String,
    pub branch_worktree_handoff_id: String,
    pub branch_worktree_preflight_id: String,
    pub branch_worktree_descriptor_id: String,
    pub branch_worktree_admission_id: String,
    pub dry_run_evidence_id: String,
    pub dry_run_outcome_id: String,
    pub dry_run_handoff_id: String,
    pub request_id: String,
    pub upstream_authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub operator_confirmation_ref: Option<String>,
    pub worktree_mode: GitBranchWorktreeMode,
    pub commit_message_source: Option<GitCommitMessageSource>,
    pub commit_message_ref: Option<String>,
    pub status: GitCommitRunnerAuthorityStatus,
    pub blockers: Vec<GitCommitRunnerAuthorityBlocker>,
    pub runner_invocation_permitted: bool,
    pub shell_execution_performed: bool,
    pub commit_created: bool,
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
pub enum GitCommitRunnerAuthorityStatus {
    ReadyForRunner,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitRunnerAuthorityBlocker {
    PreflightNotReady,
    OperatorEffectIntentMissing,
    CommitCreationNotConfirmed,
    MissingRunnerTarget,
    MissingCommitMessageRef,
    RawOutputRetentionRequested,
    PushRequested,
    PullRequestRequested,
    ForgeEffectRequested,
    ProviderEffectRequested,
    CallbackEffectRequested,
    InterruptionEffectRequested,
    RecoveryEffectRequested,
    TaskMutationRequested,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitCommitRunnerOperatorEffectIntent {
    Missing,
    Confirmed {
        confirmation_ref: String,
        allow_commit_creation: bool,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitRunnerTargetRef {
    pub preflight_id: String,
    pub commit_message_ref: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct GitCommitRunnerAuthorityContext {
    pub operator_effect_intent: GitCommitRunnerOperatorEffectIntent,
    pub target_refs: Vec<GitCommitRunnerTargetRef>,
    pub raw_output_retention_requested: bool,
    pub push_requested: bool,
    pub pull_request_requested: bool,
    pub forge_effect_requested: bool,
    pub provider_effect_requested: bool,
    pub callback_effect_requested: bool,
    pub interruption_effect_requested: bool,
    pub recovery_effect_requested: bool,
    pub task_mutation_requested: bool,
}
