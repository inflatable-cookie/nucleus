use super::body::ControlResponseBodyDto;
use super::records::ControlAcceptedMemoryReviewReceiptStorageDiagnosticsDto;
use crate::accepted_memory_review_receipt_storage_diagnostics::AcceptedMemoryReviewReceiptStorageDiagnostics;

pub(super) fn accepted_memory_review_receipt_storage_diagnostics_body_dto(
    diagnostics: &AcceptedMemoryReviewReceiptStorageDiagnostics,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::AcceptedMemoryReviewReceiptStorageDiagnostics {
        diagnostics: ControlAcceptedMemoryReviewReceiptStorageDiagnosticsDto::from(diagnostics),
    }
}
