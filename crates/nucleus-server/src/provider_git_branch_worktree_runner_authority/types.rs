use serde::{Deserialize, Serialize};

use crate::{GitBranchWorktreeExecutionHandoffSet, GitBranchWorktreeMode};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeRunnerAuthorityInput {
    pub handoffs: GitBranchWorktreeExecutionHandoffSet,
    pub operator_effect_intent: GitBranchWorktreeRunnerOperatorEffectIntent,
    pub target_refs: Vec<GitBranchWorktreeRunnerTargetRef>,
    pub raw_output_retention_requested: bool,
    pub commit_requested: bool,
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
pub struct GitBranchWorktreeRunnerAuthoritySet {
    pub authority_set_id: String,
    pub authorities: Vec<GitBranchWorktreeRunnerAuthorityRecord>,
    pub skipped_handoff_ids: Vec<String>,
    pub runner_invocation_permitted: bool,
    pub shell_execution_performed: bool,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
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
pub struct GitBranchWorktreeRunnerAuthorityRecord {
    pub authority_id: String,
    pub handoff_id: String,
    pub preflight_id: String,
    pub descriptor_id: String,
    pub admission_id: String,
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
    pub runner_action: GitBranchWorktreeRunnerAction,
    pub branch_ref: Option<String>,
    pub worktree_location_ref: Option<String>,
    pub status: GitBranchWorktreeRunnerAuthorityStatus,
    pub blockers: Vec<GitBranchWorktreeRunnerAuthorityBlocker>,
    pub runner_invocation_permitted: bool,
    pub shell_execution_performed: bool,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
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
pub enum GitBranchWorktreeRunnerAction {
    CheckoutTemporaryBranch,
    CreateIsolatedWorktree,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeRunnerAuthorityStatus {
    ReadyForRunner,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeRunnerAuthorityBlocker {
    HandoffNotAdmitted,
    OperatorEffectIntentMissing,
    PrimaryTreeCheckoutNotConfirmed,
    IsolatedWorktreeCreationNotConfirmed,
    MissingRunnerTarget,
    MissingBranchRef,
    MissingIsolatedWorktreeLocationRef,
    RawOutputRetentionRequested,
    CommitRequested,
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
pub enum GitBranchWorktreeRunnerOperatorEffectIntent {
    Missing,
    Confirmed {
        confirmation_ref: String,
        allow_primary_tree_checkout: bool,
        allow_isolated_worktree_creation: bool,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeRunnerTargetRef {
    pub handoff_id: String,
    pub branch_ref: Option<String>,
    pub worktree_location_ref: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct GitBranchWorktreeRunnerAuthorityContext {
    pub operator_effect_intent: GitBranchWorktreeRunnerOperatorEffectIntent,
    pub target_refs: Vec<GitBranchWorktreeRunnerTargetRef>,
    pub raw_output_retention_requested: bool,
    pub commit_requested: bool,
    pub push_requested: bool,
    pub pull_request_requested: bool,
    pub forge_effect_requested: bool,
    pub provider_effect_requested: bool,
    pub callback_effect_requested: bool,
    pub interruption_effect_requested: bool,
    pub recovery_effect_requested: bool,
    pub task_mutation_requested: bool,
}
