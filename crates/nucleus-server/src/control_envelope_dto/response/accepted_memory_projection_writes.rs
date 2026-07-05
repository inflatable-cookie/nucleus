use super::body::ControlResponseBodyDto;
use super::records::ControlAcceptedMemoryProjectionWriteDiagnosticsDto;
use crate::accepted_memory_projection_write_diagnostics::AcceptedMemoryProjectionWriteDiagnostics;

pub(super) fn accepted_memory_projection_write_diagnostics_body_dto(
    diagnostics: &AcceptedMemoryProjectionWriteDiagnostics,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::AcceptedMemoryProjectionWriteDiagnostics {
        diagnostics: ControlAcceptedMemoryProjectionWriteDiagnosticsDto::from(diagnostics),
    }
}
