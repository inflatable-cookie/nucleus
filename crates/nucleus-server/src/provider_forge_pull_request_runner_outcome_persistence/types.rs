use crate::provider_no_effects::ForgeScmNoEffects;
use serde::{Deserialize, Serialize};

use crate::{
    ForgePullRequestProvider, ForgePullRequestRunnerRequestAdapterBlocker,
    ForgePullRequestRunnerRequestAdapterSet, ForgePullRequestRunnerRequestAdapterStatus,
    ForgePullRequestTextSource, GitPushRemoteTarget,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgePullRequestRunnerOutcomePersistenceInput {
    pub requests: ForgePullRequestRunnerRequestAdapterSet,
    pub requested_status: ForgePullRequestRunnerOutcomeStatus,
    pub inspected_ref_count: usize,
    pub evidence_refs: Vec<String>,
    pub existing_outcome_ids: Vec<String>,
    pub raw_stdout_present: bool,
    pub raw_stderr_present: bool,
    pub raw_title_present: bool,
    pub raw_body_present: bool,
    pub provider_payload_present: bool,
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
pub struct ForgePullRequestRunnerOutcomePersistenceSet {
    pub outcome_set_id: String,
    pub records: Vec<ForgePullRequestRunnerOutcomePersistenceRecord>,
    pub shell_execution_performed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestRunnerOutcomePersistenceRecord {
    pub persisted_outcome_id: String,
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
    pub request_status: ForgePullRequestRunnerRequestAdapterStatus,
    pub request_blockers: Vec<ForgePullRequestRunnerRequestAdapterBlocker>,
    pub outcome_status: ForgePullRequestRunnerOutcomeStatus,
    pub persistence_status: ForgePullRequestRunnerOutcomePersistenceStatus,
    pub persistence_blockers: Vec<ForgePullRequestRunnerOutcomePersistenceBlocker>,
    pub duplicate_outcome_detected: bool,
    pub inspected_ref_count: usize,
    pub evidence_refs: Vec<String>,
    pub provider_request_prepared: bool,
    pub shell_execution_performed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgePullRequestRunnerOutcomeDiagnosticsRecord {
    pub diagnostics_id: String,
    pub outcome_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub duplicate_noop_count: usize,
    pub persistence_blocked_count: usize,
    pub blocker_count: usize,
    pub provider_request_prepared_count: usize,
    pub evidence_ref_count: usize,
    pub shell_execution_performed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestRunnerOutcomeStatus {
    Completed,
    Failed,
    Blocked,
    RepairRequired,
    DuplicateNoop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestRunnerOutcomePersistenceStatus {
    Persisted,
    DuplicateNoop,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgePullRequestRunnerOutcomePersistenceBlocker {
    MissingEvidenceRef,
    RawStdoutPresent,
    RawStderrPresent,
    RawTitlePresent,
    RawBodyPresent,
    ProviderPayloadPresent,
    RawOutputRetentionRequested,
    PullRequestCreationRequested,
    ForgeEffectRequested,
    ProviderEffectRequested,
    CallbackEffectRequested,
    InterruptionEffectRequested,
    RecoveryEffectRequested,
    TaskMutationRequested,
}
