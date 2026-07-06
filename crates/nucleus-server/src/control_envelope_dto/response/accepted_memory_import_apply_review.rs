use super::body::ControlResponseBodyDto;
use super::records::ControlAcceptedMemoryImportApplyReviewDiagnosticsDto;
use crate::accepted_memory_import_apply_review_diagnostics::AcceptedMemoryImportApplyReviewDiagnostics;

pub(super) fn accepted_memory_import_apply_review_diagnostics_body_dto(
    diagnostics: &AcceptedMemoryImportApplyReviewDiagnostics,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::AcceptedMemoryImportApplyReviewDiagnostics {
        diagnostics: ControlAcceptedMemoryImportApplyReviewDiagnosticsDto::from(diagnostics),
    }
}
