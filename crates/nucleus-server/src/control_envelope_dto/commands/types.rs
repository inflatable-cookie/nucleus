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
