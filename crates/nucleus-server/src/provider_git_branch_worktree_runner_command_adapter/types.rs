use crate::provider_no_effects::{ForgeScmNoEffects};
use serde::{Deserialize, Serialize};

use crate::{GitBranchWorktreeMode, GitBranchWorktreeRunnerAuthoritySet};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeRunnerCommandAdapterInput {
    pub authorities: GitBranchWorktreeRunnerAuthoritySet,
    pub executable: String,
    pub repo_working_directory_ref: String,
    pub stdout_limit_bytes: usize,
    pub stderr_limit_bytes: usize,
    pub shell_passthrough_requested: bool,
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
pub struct GitBranchWorktreeRunnerCommandAdapterSet {
    pub command_set_id: String,
    pub commands: Vec<GitBranchWorktreeRunnerCommandAdapterRecord>,
    pub skipped_authority_ids: Vec<String>,
    pub executable_argv_created: bool,
    pub shell_passthrough_used: bool,
    pub shell_execution_performed: bool,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitBranchWorktreeRunnerCommandAdapterRecord {
    pub command_id: String,
    pub authority_id: String,
    pub handoff_id: String,
    pub preflight_id: String,
    pub descriptor_id: String,
    pub admission_id: String,
    pub request_id: String,
    pub upstream_authority_id: String,
    pub git_plan_id: String,
    pub task_id: String,
    pub repo_id: String,
    pub operator_ref: String,
    pub operator_confirmation_ref: Option<String>,
    pub worktree_mode: GitBranchWorktreeMode,
    pub command_kind: GitBranchWorktreeRunnerCommandKind,
    pub executable: String,
    pub argv: Vec<String>,
    pub repo_working_directory_ref: String,
    pub branch_ref: Option<String>,
    pub worktree_location_ref: Option<String>,
    pub stdout_limit_bytes: usize,
    pub stderr_limit_bytes: usize,
    pub status: GitBranchWorktreeRunnerCommandAdapterStatus,
    pub blockers: Vec<GitBranchWorktreeRunnerCommandAdapterBlocker>,
    pub executable_argv_created: bool,
    pub shell_passthrough_used: bool,
    pub shell_execution_performed: bool,
    pub checkout_requested: bool,
    pub branch_creation_requested: bool,
    pub worktree_creation_requested: bool,
    pub checkout_executed: bool,
    pub branch_created: bool,
    pub worktree_created: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeRunnerCommandKind {
    CheckoutTemporaryBranch,
    CreateIsolatedWorktree,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeRunnerCommandAdapterStatus {
    Ready,
    Blocked,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeRunnerCommandAdapterBlocker {
    AuthorityNotReady,
    MissingExecutable,
    MissingRepoWorkingDirectoryRef,
    MissingBranchRef,
    MissingIsolatedWorktreeLocationRef,
    ShellPassthroughRequested,
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
