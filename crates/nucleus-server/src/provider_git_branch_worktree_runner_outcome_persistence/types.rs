use crate::provider_no_effects::ForgeScmNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    GitBranchWorktreeMode, GitBranchWorktreeRunnerCommandAdapterBlocker,
    GitBranchWorktreeRunnerCommandAdapterSet, GitBranchWorktreeRunnerCommandAdapterStatus,
    GitBranchWorktreeRunnerCommandKind,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitBranchWorktreeRunnerOutcomePersistenceInput {
    pub commands: GitBranchWorktreeRunnerCommandAdapterSet,
    pub requested_status: GitBranchWorktreeRunnerOutcomeStatus,
    pub inspected_path_count: usize,
    pub affected_path_count: usize,
    pub evidence_refs: Vec<String>,
    pub existing_outcome_ids: Vec<String>,
    pub raw_stdout_present: bool,
    pub raw_stderr_present: bool,
    pub provider_payload_present: bool,
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
pub struct GitBranchWorktreeRunnerOutcomePersistenceSet {
    pub outcome_set_id: String,
    pub records: Vec<GitBranchWorktreeRunnerOutcomePersistenceRecord>,
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
pub struct GitBranchWorktreeRunnerOutcomePersistenceRecord {
    pub persisted_outcome_id: String,
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
    pub branch_ref: Option<String>,
    pub worktree_location_ref: Option<String>,
    pub command_status: GitBranchWorktreeRunnerCommandAdapterStatus,
    pub command_blockers: Vec<GitBranchWorktreeRunnerCommandAdapterBlocker>,
    pub outcome_status: GitBranchWorktreeRunnerOutcomeStatus,
    pub persistence_status: GitBranchWorktreeRunnerOutcomePersistenceStatus,
    pub persistence_blockers: Vec<GitBranchWorktreeRunnerOutcomePersistenceBlocker>,
    pub duplicate_outcome_detected: bool,
    pub inspected_path_count: usize,
    pub affected_path_count: usize,
    pub evidence_refs: Vec<String>,
    pub checkout_requested: bool,
    pub branch_creation_requested: bool,
    pub worktree_creation_requested: bool,
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
pub struct GitBranchWorktreeRunnerOutcomeDiagnosticsRecord {
    pub diagnostics_id: String,
    pub outcome_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub duplicate_noop_count: usize,
    pub persistence_blocked_count: usize,
    pub blocker_count: usize,
    pub primary_tree_count: usize,
    pub isolated_worktree_count: usize,
    pub evidence_ref_count: usize,
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
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeRunnerOutcomeStatus {
    Completed,
    Failed,
    Blocked,
    RepairRequired,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeRunnerOutcomePersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitBranchWorktreeRunnerOutcomePersistenceBlocker {
    MissingEvidenceRef,
    RawStdoutPresent,
    RawStderrPresent,
    ProviderPayloadPresent,
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
