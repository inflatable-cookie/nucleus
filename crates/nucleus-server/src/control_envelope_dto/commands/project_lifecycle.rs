use nucleus_core::RevisionId;
use nucleus_projects::{ProjectId, ProjectResourceId, ProjectResourceRole};

use crate::commands::{
    ProjectCommand, ProjectCreateCommand, ProjectLifecycleAction, ProjectLifecycleCommand,
    ProjectResourceAction, ProjectResourceCommand,
};
use crate::ids::ServerCommandId;

use super::{
    ControlProjectLifecycleActionDto, ControlProjectResourceActionDto,
    ControlProjectResourceRoleDto,
};
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
        ProjectCommand::Resource(command) => Ok(resource_command_dto(command_id, command)),
    }
}

fn resource_command_dto(
    command_id: &ServerCommandId,
    command: &ProjectResourceCommand,
) -> super::ControlCommandDto {
    let (action, resource_id, locator, display_name, role, set_as_default) = match &command.action {
        ProjectResourceAction::Attach { locator } => (
            ControlProjectResourceActionDto::Attach,
            None,
            Some(locator.to_string_lossy().into_owned()),
            None,
            None,
            None,
        ),
        ProjectResourceAction::Update {
            resource_id,
            display_name,
            role,
            set_as_default,
        } => (
            ControlProjectResourceActionDto::Update,
            Some(resource_id.0.clone()),
            None,
            display_name.clone(),
            role.as_ref().map(role_dto),
            *set_as_default,
        ),
        ProjectResourceAction::Repair {
            resource_id,
            locator,
        } => (
            ControlProjectResourceActionDto::Repair,
            Some(resource_id.0.clone()),
            Some(locator.to_string_lossy().into_owned()),
            None,
            None,
            None,
        ),
        ProjectResourceAction::Remove { resource_id } => (
            ControlProjectResourceActionDto::Remove,
            Some(resource_id.0.clone()),
            None,
            None,
            None,
            None,
        ),
    };
    super::ControlCommandDto::ProjectResource {
        command_id: command_id.0.clone(),
        project_id: command.project_id.0.clone(),
        action,
        expected_revision: command.expected_revision.0.clone(),
        resource_id,
        locator,
        display_name,
        role,
        set_as_default,
        actor_ref: command.actor_ref.clone(),
        authority_host_ref: command.authority_host_ref.clone(),
        idempotency_key: command.idempotency_key.clone(),
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

#[allow(clippy::too_many_arguments)]
pub(super) fn project_resource_kind(
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
) -> Result<(ServerCommandId, crate::commands::ServerCommandKind), ControlApiCodecError> {
    let required_resource_id = || {
        resource_id.clone().map(ProjectResourceId).ok_or_else(|| {
            ControlApiCodecError::malformed("project resource action requires resource_id")
        })
    };
    let required_locator = || {
        locator
            .clone()
            .filter(|value| !value.trim().is_empty())
            .map(std::path::PathBuf::from)
            .ok_or_else(|| {
                ControlApiCodecError::malformed("project resource action requires locator")
            })
    };
    let action = match action {
        ControlProjectResourceActionDto::Attach => ProjectResourceAction::Attach {
            locator: required_locator()?,
        },
        ControlProjectResourceActionDto::Update => ProjectResourceAction::Update {
            resource_id: required_resource_id()?,
            display_name,
            role: role.map(role_from_dto),
            set_as_default,
        },
        ControlProjectResourceActionDto::Repair => ProjectResourceAction::Repair {
            resource_id: required_resource_id()?,
            locator: required_locator()?,
        },
        ControlProjectResourceActionDto::Remove => ProjectResourceAction::Remove {
            resource_id: required_resource_id()?,
        },
    };
    Ok((
        ServerCommandId(command_id),
        crate::commands::ServerCommandKind::Project(ProjectCommand::Resource(
            ProjectResourceCommand {
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

fn role_dto(role: &ProjectResourceRole) -> ControlProjectResourceRoleDto {
    match role {
        ProjectResourceRole::Working => ControlProjectResourceRoleDto::Working,
        ProjectResourceRole::Management => ControlProjectResourceRoleDto::Management,
        ProjectResourceRole::Reference => ControlProjectResourceRoleDto::Reference,
    }
}

fn role_from_dto(role: ControlProjectResourceRoleDto) -> ProjectResourceRole {
    match role {
        ControlProjectResourceRoleDto::Working => ProjectResourceRole::Working,
        ControlProjectResourceRoleDto::Management => ProjectResourceRole::Management,
        ControlProjectResourceRoleDto::Reference => ProjectResourceRole::Reference,
    }
}
