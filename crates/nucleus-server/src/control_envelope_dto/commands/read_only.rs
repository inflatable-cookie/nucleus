use crate::commands::{ReadOnlyCommand, ServerCommandKind};
use crate::control_envelope_dto::{ControlApiCodecError, ControlCommandDto};
use crate::ids::ServerCommandId;

pub(super) fn read_only_command_dto(
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

#[allow(clippy::too_many_arguments)]
pub(super) fn read_only_command_kind(
    command_id: String,
    project_id: String,
    execution_host_id: String,
    executable: String,
    argv: Vec<String>,
    working_directory: String,
    timeout_ms: u64,
    stdout_limit_bytes: usize,
    stderr_limit_bytes: usize,
    command_display: Option<String>,
) -> Result<(ServerCommandId, ServerCommandKind), ControlApiCodecError> {
    Ok((
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
    ))
}
