use super::body::ControlResponseBodyDto;
use super::records::ControlAcceptedMemoryActiveApplyDiagnosticsDto;
use crate::accepted_memory_active_apply_diagnostics::AcceptedMemoryActiveApplyDiagnostics;

pub(super) fn accepted_memory_active_apply_diagnostics_body_dto(
    diagnostics: &AcceptedMemoryActiveApplyDiagnostics,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::AcceptedMemoryActiveApplyDiagnostics {
        diagnostics: ControlAcceptedMemoryActiveApplyDiagnosticsDto::from(diagnostics),
    }
}
