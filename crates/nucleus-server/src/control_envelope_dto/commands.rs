use serde::{Deserialize, Serialize};

use crate::commands::{
    ServerCommand, ServerCommandKind, TaskCommand, TaskSeedPromotionCommand, TaskTransitionCommand,
};
use crate::ids::ServerCommandId;
use crate::memory_proposal_review_command::MemoryProposalReviewCommand;
use nucleus_core::RevisionId;
use nucleus_tasks::TaskId;

use super::ControlApiCodecError;

mod goal_authoring;
mod memory_proposal_review;
mod project_lifecycle;
mod read_only;
mod task_authoring;

use goal_authoring::{goal_command_dto, goal_create_kind, goal_update_kind};
use memory_proposal_review::{
    memory_proposal_review_action, memory_proposal_review_dto, ControlMemoryProposalReviewActionDto,
};
use project_lifecycle::{
    project_command_dto, project_create_kind, project_lifecycle_kind, project_resource_kind,
};
use read_only::{read_only_command_dto, read_only_command_kind};
use task_authoring::{
    task_create_dto, task_create_kind, task_update_dto, task_update_kind,
    ControlTaskAcceptanceCriterionDto,
};

/// Serializable command DTO for the first control envelope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControlCommandDto {
    ProjectCreate {
        command_id: String,
        display_name: String,
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
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlTaskCommandActionDto {
    Start,
    Block,
    Complete,
    Archive,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlProjectLifecycleActionDto {
    Rename,
    Park,
    Archive,
    Restore,
    Delete,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlProjectResourceActionDto {
    Attach,
    Update,
    Repair,
    Remove,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlProjectResourceRoleDto {
    Working,
    Management,
    Reference,
}

impl TryFrom<&ServerCommand> for ControlCommandDto {
    type Error = ControlApiCodecError;

    fn try_from(command: &ServerCommand) -> Result<Self, Self::Error> {
        match &command.kind {
            ServerCommandKind::Project(project_command) => {
                project_command_dto(&command.id, project_command)
            }
            ServerCommandKind::Task(task_command) => task_command_dto(&command.id, task_command),
            ServerCommandKind::Goal(goal_command) => goal_command_dto(&command.id, goal_command),
            ServerCommandKind::ReadOnlyCommand(read_only_command) => {
                Ok(read_only_command_dto(&command.id, read_only_command))
            }
            ServerCommandKind::MemoryProposalReview(review_command) => {
                Ok(memory_proposal_review_dto(&command.id, review_command))
            }
            _ => Err(ControlApiCodecError::unsupported(
                "command shape is not supported by the first command DTO",
            )),
        }
    }
}

impl ControlCommandDto {
    pub(crate) fn try_into_server_kind(
        self,
    ) -> Result<(ServerCommandId, ServerCommandKind), ControlApiCodecError> {
        match self {
            Self::ProjectCreate {
                command_id,
                display_name,
                actor_ref,
                authority_host_ref,
                idempotency_key,
            } => Ok(project_create_kind(
                command_id,
                display_name,
                actor_ref,
                authority_host_ref,
                idempotency_key,
            )),
            Self::ProjectLifecycle {
                command_id,
                project_id,
                action,
                expected_revision,
                display_name,
                actor_ref,
                authority_host_ref,
                idempotency_key,
            } => project_lifecycle_kind(
                command_id,
                project_id,
                action,
                expected_revision,
                display_name,
                actor_ref,
                authority_host_ref,
                idempotency_key,
            ),
            Self::ProjectResource {
                command_id,
                project_id,
                action,
                expected_revision,
                resource_id,
                locator,
                display_name,
                role,
                set_as_default,
                actor_ref,
                authority_host_ref,
                idempotency_key,
            } => project_resource_kind(
                command_id,
                project_id,
                action,
                expected_revision,
                resource_id,
                locator,
                display_name,
                role,
                set_as_default,
                actor_ref,
                authority_host_ref,
                idempotency_key,
            ),
            Self::Task {
                command_id,
                action,
                task_id,
                expected_revision,
                reason,
            } => transition_kind(command_id, action, task_id, expected_revision, reason),
            Self::TaskCreate {
                command_id,
                project_id,
                title,
                description,
                acceptance_criteria,
                importance,
                action_type,
                activity,
                agent_ready,
                required_context_refs,
                allowed_actions,
                stop_conditions,
                validation_commands,
            } => task_create_kind(
                command_id,
                project_id,
                title,
                description,
                acceptance_criteria,
                importance,
                action_type,
                activity,
                agent_ready,
                required_context_refs,
                allowed_actions,
                stop_conditions,
                validation_commands,
            ),
            Self::TaskUpdate {
                command_id,
                task_id,
                expected_revision,
                title,
                description,
                acceptance_criteria,
                importance,
                action_type,
                activity,
                agent_ready,
                required_context_refs,
                allowed_actions,
                stop_conditions,
                validation_commands,
            } => task_update_kind(
                command_id,
                task_id,
                expected_revision,
                title,
                description,
                acceptance_criteria,
                importance,
                action_type,
                activity,
                agent_ready,
                required_context_refs,
                allowed_actions,
                stop_conditions,
                validation_commands,
            ),
            Self::GoalCreate {
                command_id,
                project_id,
                title,
                desired_outcome,
                scope,
                status,
                owner_refs,
                ordered_task_refs,
                planning_artifact_refs,
                provenance_refs,
                stop_conditions,
                evidence_refs,
                current_next_task_ref,
                next_action,
            } => goal_create_kind(
                command_id,
                project_id,
                title,
                desired_outcome,
                scope,
                status,
                owner_refs,
                ordered_task_refs,
                planning_artifact_refs,
                provenance_refs,
                stop_conditions,
                evidence_refs,
                current_next_task_ref,
                next_action,
            ),
            Self::GoalUpdate {
                command_id,
                goal_id,
                expected_revision,
                title,
                desired_outcome,
                scope,
                owner_refs,
                ordered_task_refs,
                planning_artifact_refs,
                provenance_refs,
                stop_conditions,
                evidence_refs,
                current_next_task_ref,
                clear_current_next_task_ref,
                next_action,
                clear_next_action,
            } => goal_update_kind(
                command_id,
                goal_id,
                expected_revision,
                title,
                desired_outcome,
                scope,
                owner_refs,
                ordered_task_refs,
                planning_artifact_refs,
                provenance_refs,
                stop_conditions,
                evidence_refs,
                current_next_task_ref,
                clear_current_next_task_ref,
                next_action,
                clear_next_action,
            ),
            Self::TaskSeedPromotion {
                command_id,
                project_id,
                seed_id,
                expected_seed_revision,
                destination_task_id,
            } => Ok((
                ServerCommandId(command_id),
                ServerCommandKind::Task(TaskCommand::PromoteSeed(TaskSeedPromotionCommand {
                    project_id: nucleus_projects::ProjectId(project_id),
                    seed_id: nucleus_engine::EngineTaskSeedId(seed_id),
                    expected_seed_revision: expected_seed_revision.map(RevisionId),
                    destination_task_id: destination_task_id.map(TaskId),
                })),
            )),
            Self::MemoryProposalReview {
                command_id,
                action,
                proposal_id,
                expected_revision,
                reviewer_ref,
                note,
            } => Ok((
                ServerCommandId(command_id.clone()),
                ServerCommandKind::MemoryProposalReview(MemoryProposalReviewCommand {
                    command_id,
                    proposal_id,
                    expected_revision: RevisionId(expected_revision),
                    action: memory_proposal_review_action(action),
                    reviewer_ref,
                    note,
                }),
            )),
            Self::ReadOnlyCommand {
                command_id,
                project_id,
                execution_host_id,
                executable,
                argv,
                working_directory,
                timeout_ms,
                stdout_limit_bytes,
                stderr_limit_bytes,
                command_display,
            } => read_only_command_kind(
                command_id,
                project_id,
                execution_host_id,
                executable,
                argv,
                working_directory,
                timeout_ms,
                stdout_limit_bytes,
                stderr_limit_bytes,
                command_display,
            ),
        }
    }
}

fn task_command_dto(
    command_id: &ServerCommandId,
    task_command: &TaskCommand,
) -> Result<ControlCommandDto, ControlApiCodecError> {
    let dto = match task_command {
        TaskCommand::Start(command) => transition_command_dto(
            command_id,
            ControlTaskCommandActionDto::Start,
            &command.task_id,
            &command.expected_revision,
            None,
        ),
        TaskCommand::Block {
            task_id,
            reason,
            expected_revision,
        } => transition_command_dto(
            command_id,
            ControlTaskCommandActionDto::Block,
            task_id,
            expected_revision,
            Some(reason.clone()),
        ),
        TaskCommand::Complete(command) => transition_command_dto(
            command_id,
            ControlTaskCommandActionDto::Complete,
            &command.task_id,
            &command.expected_revision,
            None,
        ),
        TaskCommand::Archive(command) => transition_command_dto(
            command_id,
            ControlTaskCommandActionDto::Archive,
            &command.task_id,
            &command.expected_revision,
            None,
        ),
        TaskCommand::Create(command) => task_create_dto(command_id, command),
        TaskCommand::PromoteSeed(command) => task_seed_promotion_dto(command_id, command),
        TaskCommand::Update(command) => task_update_dto(command_id, command),
        TaskCommand::Delegate(_) => {
            return Err(ControlApiCodecError::unsupported(
                "task delegation command DTO is not defined yet",
            ));
        }
    };

    Ok(dto)
}

fn task_seed_promotion_dto(
    command_id: &ServerCommandId,
    command: &TaskSeedPromotionCommand,
) -> ControlCommandDto {
    ControlCommandDto::TaskSeedPromotion {
        command_id: command_id.0.clone(),
        project_id: command.project_id.0.clone(),
        seed_id: command.seed_id.0.clone(),
        expected_seed_revision: command
            .expected_seed_revision
            .as_ref()
            .map(|revision| revision.0.clone()),
        destination_task_id: command
            .destination_task_id
            .as_ref()
            .map(|task_id| task_id.0.clone()),
    }
}

fn transition_kind(
    command_id: String,
    action: ControlTaskCommandActionDto,
    task_id: String,
    expected_revision: Option<String>,
    reason: Option<String>,
) -> Result<(ServerCommandId, ServerCommandKind), ControlApiCodecError> {
    let command_id = ServerCommandId(command_id);
    let task_id = TaskId(task_id);
    let expected_revision = expected_revision.map(RevisionId);
    let kind = match action {
        ControlTaskCommandActionDto::Start => {
            reject_reason("start", reason)?;
            TaskCommand::Start(TaskTransitionCommand {
                task_id,
                expected_revision,
            })
        }
        ControlTaskCommandActionDto::Block => TaskCommand::Block {
            task_id,
            reason: required_reason(reason)?,
            expected_revision,
        },
        ControlTaskCommandActionDto::Complete => {
            reject_reason("complete", reason)?;
            TaskCommand::Complete(TaskTransitionCommand {
                task_id,
                expected_revision,
            })
        }
        ControlTaskCommandActionDto::Archive => {
            reject_reason("archive", reason)?;
            TaskCommand::Archive(TaskTransitionCommand {
                task_id,
                expected_revision,
            })
        }
    };

    Ok((command_id, ServerCommandKind::Task(kind)))
}

fn transition_command_dto(
    command_id: &ServerCommandId,
    action: ControlTaskCommandActionDto,
    task_id: &TaskId,
    expected_revision: &Option<RevisionId>,
    reason: Option<String>,
) -> ControlCommandDto {
    ControlCommandDto::Task {
        command_id: command_id.0.clone(),
        action,
        task_id: task_id.0.clone(),
        expected_revision: expected_revision
            .as_ref()
            .map(|revision| revision.0.clone()),
        reason,
    }
}

fn required_reason(reason: Option<String>) -> Result<String, ControlApiCodecError> {
    match reason {
        Some(reason) if !reason.trim().is_empty() => Ok(reason),
        _ => Err(ControlApiCodecError::malformed(
            "block task command requires a reason",
        )),
    }
}

fn reject_reason(action: &str, reason: Option<String>) -> Result<(), ControlApiCodecError> {
    if reason.is_some() {
        return Err(ControlApiCodecError::malformed(format!(
            "{action} task command does not accept a reason"
        )));
    }
    Ok(())
}
