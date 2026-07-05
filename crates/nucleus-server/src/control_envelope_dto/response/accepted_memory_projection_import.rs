use super::body::ControlResponseBodyDto;
use super::records::ControlAcceptedMemoryProjectionImportDiagnosticsDto;
use crate::accepted_memory_projection_import_diagnostics::AcceptedMemoryProjectionImportDiagnostics;

pub(super) fn accepted_memory_projection_import_diagnostics_body_dto(
    diagnostics: &AcceptedMemoryProjectionImportDiagnostics,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::AcceptedMemoryProjectionImportDiagnostics {
        diagnostics: ControlAcceptedMemoryProjectionImportDiagnosticsDto::from(diagnostics),
    }
}
