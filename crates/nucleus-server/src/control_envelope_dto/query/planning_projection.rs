use nucleus_projects::ProjectId;

use crate::control_api::{
    PlanningCapturePublicationDiagnosticsQuery, PlanningProjectionFileWriteDiagnosticsQuery,
    PlanningProjectionImportActiveApplyDiagnosticsQuery,
    PlanningProjectionImportApplyDiagnosticsQuery, PlanningProjectionImportDiagnosticsQuery,
    ServerQueryKind,
};

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

pub(super) fn planning_capture_publication_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "planning capture publication diagnostics requires a project id",
        )),
        "diagnostics" => Ok(ServerQueryKind::PlanningCapturePublicationDiagnostics(
            PlanningCapturePublicationDiagnosticsQuery {
                project_id: ProjectId(project_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported planning capture publication diagnostics action: {action}"
        ))),
    }
}

pub(super) fn planning_projection_import_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "planning projection import diagnostics requires a project id",
        )),
        "diagnostics" => Ok(ServerQueryKind::PlanningProjectionImportDiagnostics(
            PlanningProjectionImportDiagnosticsQuery {
                project_id: ProjectId(project_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported planning projection import diagnostics action: {action}"
        ))),
    }
}

pub(super) fn planning_projection_import_apply_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "planning projection import apply diagnostics requires a project id",
        )),
        "diagnostics" => Ok(ServerQueryKind::PlanningProjectionImportApplyDiagnostics(
            PlanningProjectionImportApplyDiagnosticsQuery {
                project_id: ProjectId(project_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported planning projection import apply diagnostics action: {action}"
        ))),
    }
}

pub(super) fn planning_projection_import_active_apply_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "planning projection import active apply diagnostics requires a project id",
        )),
        "diagnostics" => Ok(
            ServerQueryKind::PlanningProjectionImportActiveApplyDiagnostics(
                PlanningProjectionImportActiveApplyDiagnosticsQuery {
                    project_id: ProjectId(project_id),
                },
            ),
        ),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported planning projection import active apply diagnostics action: {action}"
        ))),
    }
}
