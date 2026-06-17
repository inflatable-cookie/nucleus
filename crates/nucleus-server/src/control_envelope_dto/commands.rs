use serde::{Deserialize, Serialize};

use crate::commands::{
    ReadOnlyCommand, ServerCommand, ServerCommandKind, TaskCommand, TaskTransitionCommand,
};
use crate::ids::ServerCommandId;
use nucleus_core::RevisionId;
use nucleus_tasks::TaskId;

use super::ControlApiCodecError;

mod task_authoring;

use task_authoring::{
    task_create_dto, task_create_kind, task_update_dto, task_update_kind,
    ControlTaskAcceptanceCriterionDto,
};

/// Serializable command DTO for the first control envelope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControlCommandDto {
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

impl TryFrom<&ServerCommand> for ControlCommandDto {
    type Error = ControlApiCodecError;

    fn try_from(command: &ServerCommand) -> Result<Self, Self::Error> {
        match &command.kind {
            ServerCommandKind::Task(task_command) => task_command_dto(&command.id, task_command),
            ServerCommandKind::ReadOnlyCommand(read_only_command) => {
                Ok(read_only_command_dto(&command.id, read_only_command))
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
            } => Ok((
                ServerCommandId(command_id),
                ServerCommandKind::ReadOnlyCommand(ReadOnlyCommand {
                    project_id: nucleus_projects::ProjectId(project_id),
                    execution_host_id: crate::EngineHostId(execution_host_id),
                    executable,
                    argv,
                    working_directory: std::path::PathBuf::from(working_directory),
                    timeout_ms,
                    stdout_limit_bytes,
                    stderr_limit_bytes,
                    command_display,
                }),
            )),
        }
    }
}

fn read_only_command_dto(
    command_id: &ServerCommandId,
    command: &ReadOnlyCommand,
) -> ControlCommandDto {
    ControlCommandDto::ReadOnlyCommand {
        command_id: command_id.0.clone(),
        project_id: command.project_id.0.clone(),
        execution_host_id: command.execution_host_id.0.clone(),
        executable: command.executable.clone(),
        argv: command.argv.clone(),
        working_directory: command.working_directory.display().to_string(),
        timeout_ms: command.timeout_ms,
        stdout_limit_bytes: command.stdout_limit_bytes,
        stderr_limit_bytes: command.stderr_limit_bytes,
        command_display: command.command_display.clone(),
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
        TaskCommand::Update(command) => task_update_dto(command_id, command),
    };

    Ok(dto)
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
