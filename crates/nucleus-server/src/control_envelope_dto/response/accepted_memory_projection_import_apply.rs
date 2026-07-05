use super::body::ControlResponseBodyDto;
use super::records::ControlAcceptedMemoryProjectionImportApplyDiagnosticsDto;
use crate::accepted_memory_projection_import_apply_diagnostics::AcceptedMemoryProjectionImportApplyDiagnostics;

pub(super) fn accepted_memory_projection_import_apply_diagnostics_body_dto(
    diagnostics: &AcceptedMemoryProjectionImportApplyDiagnostics,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::AcceptedMemoryProjectionImportApplyDiagnostics {
        diagnostics: ControlAcceptedMemoryProjectionImportApplyDiagnosticsDto::from(diagnostics),
    }
}
