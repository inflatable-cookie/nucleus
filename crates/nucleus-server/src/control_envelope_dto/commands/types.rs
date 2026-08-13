//! Serializable command DTOs: the tagged command enum and its action and
//! policy enums.
//!
//! Split from the commands god file; behavior unchanged.

use serde::{Deserialize, Serialize};

use super::memory_proposal_review::ControlMemoryProposalReviewActionDto;
use super::task_authoring::ControlTaskAcceptanceCriterionDto;

/// Serializable command DTO for the first control envelope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControlCommandDto {
    ProjectCreate {
        command_id: String,
        display_name: String,
        #[serde(default)]
        transient: Option<bool>,
        actor_ref: String,
        authority_host_ref: String,
        idempotency_key: String,
    },
    ProjectLifecycle {
        command_id: String,
        project_id: String,
        action: ControlProjectLifecycleActionDto,
        expected_revision: String,
        display_name: Option<String>,
        actor_ref: String,
        authority_host_ref: String,
        idempotency_key: String,
    },
    ProjectResource {
        command_id: String,
        project_id: String,
        action: ControlProjectResourceActionDto,
        expected_revision: String,
        resource_id: Option<String>,
        locator: Option<String>,
        display_name: Option<String>,
        role: Option<ControlProjectResourceRoleDto>,
        set_as_default: Option<bool>,
        sync_policy: Option<ControlManagementProjectionSyncPolicyDto>,
        actor_ref: String,
        authority_host_ref: String,
        idempotency_key: String,
    },
    Task {
        command_id: String,
        action: ControlTaskCommandActionDto,
        task_id: String,
        expected_revision: Option<String>,
        reason: Option<String>,
    },
    TaskCreate {
        command_id: String,
        project_id: String,
        title: String,
        description: Option<String>,
        #[serde(default)]
        acceptance_criteria: Vec<ControlTaskAcceptanceCriterionDto>,
        importance: String,
        action_type: String,
        activity: Option<String>,
        agent_ready: bool,
        #[serde(default)]
        required_context_refs: Vec<String>,
        #[serde(default)]
        allowed_actions: Vec<String>,
        #[serde(default)]
        stop_conditions: Vec<String>,
        #[serde(default)]
        validation_commands: Vec<String>,
    },
    TaskUpdate {
        command_id: String,
        task_id: String,
        expected_revision: Option<String>,
        title: Option<String>,
        description: Option<Option<String>>,
        acceptance_criteria: Option<Vec<ControlTaskAcceptanceCriterionDto>>,
        importance: Option<String>,
        action_type: Option<String>,
        activity: Option<String>,
        agent_ready: Option<bool>,
        required_context_refs: Option<Vec<String>>,
        allowed_actions: Option<Vec<String>>,
        stop_conditions: Option<Vec<String>>,
        validation_commands: Option<Vec<String>>,
    },
    GoalCreate {
        command_id: String,
        project_id: String,
        title: String,
        desired_outcome: String,
        scope: String,
        status: String,
        #[serde(default)]
        owner_refs: Vec<String>,
        #[serde(default)]
        ordered_task_refs: Vec<String>,
        #[serde(default)]
        planning_artifact_refs: Vec<String>,
        #[serde(default)]
        provenance_refs: Vec<String>,
        #[serde(default)]
        stop_conditions: Vec<String>,
        #[serde(default)]
        evidence_refs: Vec<String>,
        current_next_task_ref: Option<String>,
        next_action: Option<String>,
    },
    GoalUpdate {
        command_id: String,
        goal_id: String,
        expected_revision: String,
        title: Option<String>,
        desired_outcome: Option<String>,
        scope: Option<String>,
        owner_refs: Option<Vec<String>>,
        ordered_task_refs: Option<Vec<String>>,
        planning_artifact_refs: Option<Vec<String>>,
        provenance_refs: Option<Vec<String>>,
        stop_conditions: Option<Vec<String>>,
        evidence_refs: Option<Vec<String>>,
        current_next_task_ref: Option<String>,
        clear_current_next_task_ref: bool,
        next_action: Option<String>,
        clear_next_action: bool,
    },
    TaskSeedPromotion {
        command_id: String,
        project_id: String,
        seed_id: String,
        expected_seed_revision: Option<String>,
        destination_task_id: Option<String>,
    },
    MemoryProposalReview {
        command_id: String,
        action: ControlMemoryProposalReviewActionDto,
        proposal_id: String,
        expected_revision: String,
        reviewer_ref: Option<String>,
        note: Option<String>,
    },
    ReadOnlyCommand {
        command_id: String,
        project_id: String,
        execution_host_id: String,
        executable: String,
        #[serde(default)]
        argv: Vec<String>,
        working_directory: String,
        timeout_ms: u64,
        stdout_limit_bytes: usize,
        stderr_limit_bytes: usize,
        command_display: Option<String>,
    },
    RunPropose {
        command_id: String,
        run_id: String,
        project_id: String,
        objective_scope: String,
        #[serde(default)]
        acceptance: Vec<String>,
        #[serde(default)]
        stop_conditions: Vec<String>,
        worktree_ref: Option<String>,
        provider_instance: String,
        provider_model: String,
        orchestrator_designation: Option<String>,
        token_budget: Option<u64>,
        time_budget_seconds: Option<u64>,
    },
    RunDispatchExecution {
        command_id: String,
        run_id: String,
        expected_revision: Option<String>,
        operator_ref: String,
    },
    RunTransition {
        command_id: String,
        run_id: String,
        action: ControlRunTransitionActionDto,
        expected_revision: Option<String>,
        reason: Option<String>,
    },
    RunDeliveryExecution {
        command_id: String,
        run_id: String,
        closeout_summary: String,
        #[serde(default)]
        closeout_evidence_refs: Vec<String>,
        closeout_diff_ref: Option<String>,
        operator_ref: String,
        commit_message: String,
        #[serde(default)]
        remote_target: String,
        #[serde(default)]
        pull_request_creation: Option<ControlForgePullRequestCreationScopeDto>,
        idempotency_key: String,
        expected_revision: Option<String>,
    },
}

/// Operator-confirmed PR-creation scope on the run delivery command DTO.
/// Mirrors the durable `ForgePullRequestCreationScope`: forge provider, base
/// and head refs, and title/body sources only — raw PR title/body text never
/// crosses the command boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub struct ControlForgePullRequestCreationScopeDto {
    pub forge_provider: ControlForgePullRequestProviderDto,
    pub base_branch: String,
    pub head_branch: String,
    pub title_source: ControlForgePullRequestTextSourceDto,
    pub body_source: ControlForgePullRequestTextSourceDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ControlForgePullRequestProviderDto {
    GitHub,
    GitLab,
    GenericForge,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ControlForgePullRequestTextSourceDto {
    OperatorProvided,
    AgentSuggested,
    GeneratedFromEvidence,
}

/// Supported task command actions for the first command DTO subset.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ControlTaskCommandActionDto {
    Start,
    Block,
    Complete,
    Archive,
}

/// Supported run lifecycle disposition actions for the first command DTO
/// subset (accept/reject are the operator dispositions on a delivered run).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ControlRunTransitionActionDto {
    Accept,
    Reject,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ControlProjectLifecycleActionDto {
    Rename,
    Park,
    Archive,
    Restore,
    Delete,
    Promote,
    ExpireTransient,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ControlProjectResourceActionDto {
    Attach,
    Update,
    Repair,
    Remove,
    SetManagementProjection,
    ClearManagementProjection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ControlManagementProjectionSyncPolicyDto {
    Manual,
    Assisted,
    Automatic,
    Reviewed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ControlProjectResourceRoleDto {
    Working,
    Management,
    Reference,
}
