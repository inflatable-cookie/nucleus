use serde::{Deserialize, Serialize};

use crate::{
    GitPushRemoteTarget, GitPushRunnerCommandAdapterBlocker, GitPushRunnerCommandAdapterSet,
    GitPushRunnerCommandAdapterStatus, GitPushRunnerCommandKind,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPushRunnerOutcomePersistenceInput {
    pub commands: GitPushRunnerCommandAdapterSet,
    pub requested_status: GitPushRunnerOutcomeStatus,
    pub inspected_path_count: usize,
    pub affected_path_count: usize,
    pub evidence_refs: Vec<String>,
    pub existing_outcome_ids: Vec<String>,
    pub raw_stdout_present: bool,
    pub raw_stderr_present: bool,
    pub provider_payload_present: bool,
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
pub struct GitPushRunnerOutcomePersistenceSet {
    pub outcome_set_id: String,
    pub records: Vec<GitPushRunnerOutcomePersistenceRecord>,
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
pub struct GitPushRunnerOutcomePersistenceRecord {
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
    pub command_kind: GitPushRunnerCommandKind,
    pub remote_target: Option<GitPushRemoteTarget>,
    pub command_status: GitPushRunnerCommandAdapterStatus,
    pub command_blockers: Vec<GitPushRunnerCommandAdapterBlocker>,
    pub outcome_status: GitPushRunnerOutcomeStatus,
    pub persistence_status: GitPushRunnerOutcomePersistenceStatus,
    pub persistence_blockers: Vec<GitPushRunnerOutcomePersistenceBlocker>,
    pub duplicate_outcome_detected: bool,
    pub inspected_path_count: usize,
    pub affected_path_count: usize,
    pub evidence_refs: Vec<String>,
    pub push_requested: bool,
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
pub struct GitPushRunnerOutcomeDiagnosticsRecord {
    pub diagnostics_id: String,
    pub outcome_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub duplicate_noop_count: usize,
    pub persistence_blocked_count: usize,
    pub blocker_count: usize,
    pub remote_target_count: usize,
    pub evidence_ref_count: usize,
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
pub enum GitPushRunnerOutcomeStatus {
    Completed,
    Failed,
    Blocked,
    RepairRequired,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitPushRunnerOutcomePersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitPushRunnerOutcomePersistenceBlocker {
    MissingEvidenceRef,
    RawStdoutPresent,
    RawStderrPresent,
    ProviderPayloadPresent,
    RawOutputRetentionRequested,
    PullRequestRequested,
    ForgeEffectRequested,
    ProviderEffectRequested,
    CallbackEffectRequested,
    InterruptionEffectRequested,
    RecoveryEffectRequested,
    TaskMutationRequested,
}
