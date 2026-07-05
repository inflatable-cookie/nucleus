use super::body::ControlResponseBodyDto;
use super::records::ControlAcceptedMemoryProjectionDiagnosticsDto;
use crate::accepted_memory_projection_diagnostics::AcceptedMemoryProjectionDiagnostics;

pub(super) fn accepted_memory_projection_diagnostics_body_dto(
    diagnostics: &AcceptedMemoryProjectionDiagnostics,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::AcceptedMemoryProjectionDiagnostics {
        diagnostics: ControlAcceptedMemoryProjectionDiagnosticsDto::from(diagnostics),
    }
}
