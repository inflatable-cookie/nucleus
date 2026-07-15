use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;

use crate::commands::{
    ProjectCommand, ProjectCreateCommand, ProjectLifecycleAction, ProjectLifecycleCommand,
};
use crate::ids::ServerCommandId;

use super::ControlProjectLifecycleActionDto;
use crate::control_envelope_dto::ControlApiCodecError;

pub(super) fn project_command_dto(
    command_id: &ServerCommandId,
    command: &ProjectCommand,
) -> Result<super::ControlCommandDto, ControlApiCodecError> {
    match command {
        ProjectCommand::Create(command) => Ok(super::ControlCommandDto::ProjectCreate {
            command_id: command_id.0.clone(),
            display_name: command.display_name.clone(),
            actor_ref: command.actor_ref.clone(),
            authority_host_ref: command.authority_host_ref.clone(),
            idempotency_key: command.idempotency_key.clone(),
        }),
        ProjectCommand::Lifecycle(command) => Ok(super::ControlCommandDto::ProjectLifecycle {
            command_id: command_id.0.clone(),
            project_id: command.project_id.0.clone(),
            action: action_dto(&command.action),
            expected_revision: command.expected_revision.0.clone(),
            display_name: match &command.action {
                ProjectLifecycleAction::Rename { display_name } => Some(display_name.clone()),
                _ => None,
            },
            actor_ref: command.actor_ref.clone(),
            authority_host_ref: command.authority_host_ref.clone(),
            idempotency_key: command.idempotency_key.clone(),
        }),
        ProjectCommand::RepairResource { .. } => Err(ControlApiCodecError::unsupported(
            "project resource repair command DTO is not implemented",
        )),
    }
}

pub(super) fn project_create_kind(
    command_id: String,
    display_name: String,
    actor_ref: String,
    authority_host_ref: String,
    idempotency_key: String,
) -> (ServerCommandId, crate::commands::ServerCommandKind) {
    (
        ServerCommandId(command_id),
        crate::commands::ServerCommandKind::Project(ProjectCommand::Create(ProjectCreateCommand {
            display_name,
            actor_ref,
            authority_host_ref,
            idempotency_key,
        })),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn project_lifecycle_kind(
    command_id: String,
    project_id: String,
    action: ControlProjectLifecycleActionDto,
    expected_revision: String,
    display_name: Option<String>,
    actor_ref: String,
    authority_host_ref: String,
    idempotency_key: String,
) -> Result<(ServerCommandId, crate::commands::ServerCommandKind), ControlApiCodecError> {
    let action = match action {
        ControlProjectLifecycleActionDto::Rename => ProjectLifecycleAction::Rename {
            display_name: display_name.ok_or_else(|| {
                ControlApiCodecError::malformed("project rename requires display_name")
            })?,
        },
        ControlProjectLifecycleActionDto::Park => ProjectLifecycleAction::Park,
        ControlProjectLifecycleActionDto::Archive => ProjectLifecycleAction::Archive,
        ControlProjectLifecycleActionDto::Restore => ProjectLifecycleAction::Restore,
        ControlProjectLifecycleActionDto::Delete => ProjectLifecycleAction::Delete,
    };
    Ok((
        ServerCommandId(command_id),
        crate::commands::ServerCommandKind::Project(ProjectCommand::Lifecycle(
            ProjectLifecycleCommand {
                project_id: ProjectId(project_id),
                expected_revision: RevisionId(expected_revision),
                actor_ref,
                authority_host_ref,
                idempotency_key,
                action,
            },
        )),
    ))
}

fn action_dto(action: &ProjectLifecycleAction) -> ControlProjectLifecycleActionDto {
    match action {
        ProjectLifecycleAction::Rename { .. } => ControlProjectLifecycleActionDto::Rename,
        ProjectLifecycleAction::Park => ControlProjectLifecycleActionDto::Park,
        ProjectLifecycleAction::Archive => ControlProjectLifecycleActionDto::Archive,
        ProjectLifecycleAction::Restore => ControlProjectLifecycleActionDto::Restore,
        ProjectLifecycleAction::Delete => ControlProjectLifecycleActionDto::Delete,
    }
}
