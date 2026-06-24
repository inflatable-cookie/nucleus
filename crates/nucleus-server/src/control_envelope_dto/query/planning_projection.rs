use nucleus_projects::ProjectId;

use crate::control_api::{PlanningProjectionFileWriteDiagnosticsQuery, ServerQueryKind};

use super::ControlApiCodecError;

pub(super) fn planning_projection_file_write_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "planning projection file-write diagnostics requires a project id",
        )),
        "diagnostics" => Ok(ServerQueryKind::PlanningProjectionFileWriteDiagnostics(
            PlanningProjectionFileWriteDiagnosticsQuery {
                project_id: ProjectId(project_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported planning projection file-write diagnostics action: {action}"
        ))),
    }
}
