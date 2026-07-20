use crate::provider_no_effects::ForgeScmNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    GitBranchWorktreeMode, GitCommitMessageSource, GitCommitRunnerCommandAdapterBlocker,
    GitCommitRunnerCommandAdapterSet, GitCommitRunnerCommandAdapterStatus,
    GitCommitRunnerCommandKind,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitRunnerOutcomePersistenceInput {
    pub commands: GitCommitRunnerCommandAdapterSet,
    pub requested_status: GitCommitRunnerOutcomeStatus,
    pub inspected_path_count: usize,
    pub affected_path_count: usize,
    pub evidence_refs: Vec<String>,
    pub existing_outcome_ids: Vec<String>,
    pub raw_stdout_present: bool,
    pub raw_stderr_present: bool,
    pub raw_commit_message_present: bool,
    pub provider_payload_present: bool,
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
pub struct GitCommitRunnerOutcomePersistenceSet {
    pub outcome_set_id: String,
    pub records: Vec<GitCommitRunnerOutcomePersistenceRecord>,
    pub shell_execution_performed: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitCommitRunnerOutcomePersistenceRecord {
    pub persisted_outcome_id: String,
    pub command_id: String,
    pub authority_id: String,
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
    pub command_kind: GitCommitRunnerCommandKind,
    pub commit_message_source: Option<GitCommitMessageSource>,
    pub commit_message_ref: Option<String>,
    pub command_status: GitCommitRunnerCommandAdapterStatus,
    pub command_blockers: Vec<GitCommitRunnerCommandAdapterBlocker>,
    pub outcome_status: GitCommitRunnerOutcomeStatus,
    pub persistence_status: GitCommitRunnerOutcomePersistenceStatus,
    pub persistence_blockers: Vec<GitCommitRunnerOutcomePersistenceBlocker>,
    pub duplicate_outcome_detected: bool,
    pub inspected_path_count: usize,
    pub affected_path_count: usize,
    pub evidence_refs: Vec<String>,
    pub commit_creation_requested: bool,
    pub shell_execution_performed: bool,
    pub commit_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitCommitRunnerOutcomeDiagnosticsRecord {
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
    pub commit_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitRunnerOutcomeStatus {
    Completed,
    Failed,
    Blocked,
    RepairRequired,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitRunnerOutcomePersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCommitRunnerOutcomePersistenceBlocker {
    MissingEvidenceRef,
    RawStdoutPresent,
    RawStderrPresent,
    RawCommitMessagePresent,
    ProviderPayloadPresent,
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
