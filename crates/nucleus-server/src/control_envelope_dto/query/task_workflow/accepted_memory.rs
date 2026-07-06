use nucleus_projects::ProjectId;

use crate::control_api::{
    AcceptedMemoryActiveApplyDiagnosticsQuery, AcceptedMemoryImportApplyReviewDiagnosticsQuery,
    AcceptedMemoryProjectionDiagnosticsQuery, AcceptedMemoryProjectionImportApplyDiagnosticsQuery,
    AcceptedMemoryProjectionImportDiagnosticsQuery, AcceptedMemoryProjectionWriteDiagnosticsQuery,
    AcceptedMemoryQuery, AcceptedMemoryReviewReadinessQuery,
    AcceptedMemoryReviewReceiptStorageDiagnosticsQuery, ServerQueryKind,
};

use super::super::super::ControlApiCodecError;

pub(in crate::control_envelope_dto::query) fn accepted_memory_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "memory" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "accepted memory query requires a project id",
        )),
        "memory" => Ok(ServerQueryKind::AcceptedMemory(AcceptedMemoryQuery {
            project_id: ProjectId(project_id),
        })),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported accepted memory query action: {action}"
        ))),
    }
}

pub(in crate::control_envelope_dto::query) fn accepted_memory_projection_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "accepted memory projection diagnostics query requires a project id",
        )),
        "diagnostics" => Ok(ServerQueryKind::AcceptedMemoryProjectionDiagnostics(
            AcceptedMemoryProjectionDiagnosticsQuery {
                project_id: ProjectId(project_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported accepted memory projection diagnostics query action: {action}"
        ))),
    }
}

pub(in crate::control_envelope_dto::query) fn accepted_memory_projection_write_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "accepted memory projection write diagnostics query requires a project id",
        )),
        "diagnostics" => Ok(ServerQueryKind::AcceptedMemoryProjectionWriteDiagnostics(
            AcceptedMemoryProjectionWriteDiagnosticsQuery {
                project_id: ProjectId(project_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported accepted memory projection write diagnostics query action: {action}"
        ))),
    }
}

pub(in crate::control_envelope_dto::query) fn accepted_memory_projection_import_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "accepted memory projection import diagnostics query requires a project id",
        )),
        "diagnostics" => Ok(ServerQueryKind::AcceptedMemoryProjectionImportDiagnostics(
            AcceptedMemoryProjectionImportDiagnosticsQuery {
                project_id: ProjectId(project_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported accepted memory projection import diagnostics query action: {action}"
        ))),
    }
}

pub(in crate::control_envelope_dto::query) fn accepted_memory_projection_import_apply_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "accepted memory projection import apply diagnostics query requires a project id",
        )),
        "diagnostics" => Ok(
            ServerQueryKind::AcceptedMemoryProjectionImportApplyDiagnostics(
                AcceptedMemoryProjectionImportApplyDiagnosticsQuery {
                    project_id: ProjectId(project_id),
                },
            ),
        ),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported accepted memory projection import apply diagnostics query action: {action}"
        ))),
    }
}

pub(in crate::control_envelope_dto::query) fn accepted_memory_import_apply_review_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "accepted memory import apply review diagnostics query requires a project id",
        )),
        "diagnostics" => Ok(ServerQueryKind::AcceptedMemoryImportApplyReviewDiagnostics(
            AcceptedMemoryImportApplyReviewDiagnosticsQuery {
                project_id: ProjectId(project_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported accepted memory import apply review diagnostics query action: {action}"
        ))),
    }
}

pub(in crate::control_envelope_dto::query) fn accepted_memory_review_receipt_storage_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "accepted memory review receipt storage diagnostics query requires a project id",
        )),
        "diagnostics" => Ok(
            ServerQueryKind::AcceptedMemoryReviewReceiptStorageDiagnostics(
                AcceptedMemoryReviewReceiptStorageDiagnosticsQuery {
                    project_id: ProjectId(project_id),
                },
            ),
        ),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported accepted memory review receipt storage diagnostics query action: {action}"
        ))),
    }
}

pub(in crate::control_envelope_dto::query) fn accepted_memory_active_apply_diagnostics_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "accepted memory active apply diagnostics query requires a project id",
        )),
        "diagnostics" => Ok(ServerQueryKind::AcceptedMemoryActiveApplyDiagnostics(
            AcceptedMemoryActiveApplyDiagnosticsQuery {
                project_id: ProjectId(project_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported accepted memory active apply diagnostics query action: {action}"
        ))),
    }
}

pub(in crate::control_envelope_dto::query) fn accepted_memory_review_readiness_query_from_action(
    action: &str,
    project_id: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "diagnostics" if project_id.trim().is_empty() => Err(ControlApiCodecError::unsupported(
            "accepted memory review readiness query requires a project id",
        )),
        "diagnostics" => Ok(ServerQueryKind::AcceptedMemoryReviewReadiness(
            AcceptedMemoryReviewReadinessQuery {
                project_id: ProjectId(project_id),
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported accepted memory review readiness query action: {action}"
        ))),
    }
}
