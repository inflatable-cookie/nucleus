use super::accepted_memory::accepted_memory_body_dto;
use super::accepted_memory_active_apply::accepted_memory_active_apply_diagnostics_body_dto;
use super::accepted_memory_import_apply_review::accepted_memory_import_apply_review_diagnostics_body_dto;
use super::accepted_memory_projection::accepted_memory_projection_diagnostics_body_dto;
use super::accepted_memory_projection_import::accepted_memory_projection_import_diagnostics_body_dto;
use super::accepted_memory_projection_import_apply::accepted_memory_projection_import_apply_diagnostics_body_dto;
use super::accepted_memory_projection_writes::accepted_memory_projection_write_diagnostics_body_dto;
use super::accepted_memory_review::accepted_memory_review_readiness_body_dto;
use super::accepted_memory_review_receipt_storage::accepted_memory_review_receipt_storage_diagnostics_body_dto;
use super::body::ControlResponseBodyDto;
use crate::control_api::{ServerControlResponseBody, ServerQueryResult};

pub(super) fn accepted_memory_query_body_dto(
    body: &ServerControlResponseBody,
) -> Option<ControlResponseBodyDto> {
    match body {
        ServerControlResponseBody::Query(ServerQueryResult::AcceptedMemory(projection)) => {
            Some(accepted_memory_body_dto(projection))
        }
        ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryProjectionDiagnostics(diagnostics),
        ) => Some(accepted_memory_projection_diagnostics_body_dto(diagnostics)),
        ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryProjectionWriteDiagnostics(diagnostics),
        ) => Some(accepted_memory_projection_write_diagnostics_body_dto(
            diagnostics,
        )),
        ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryProjectionImportDiagnostics(diagnostics),
        ) => Some(accepted_memory_projection_import_diagnostics_body_dto(
            diagnostics,
        )),
        ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryProjectionImportApplyDiagnostics(diagnostics),
        ) => Some(accepted_memory_projection_import_apply_diagnostics_body_dto(diagnostics)),
        ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryImportApplyReviewDiagnostics(diagnostics),
        ) => Some(accepted_memory_import_apply_review_diagnostics_body_dto(
            diagnostics,
        )),
        ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryReviewReceiptStorageDiagnostics(diagnostics),
        ) => Some(accepted_memory_review_receipt_storage_diagnostics_body_dto(
            diagnostics,
        )),
        ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryActiveApplyDiagnostics(diagnostics),
        ) => Some(accepted_memory_active_apply_diagnostics_body_dto(
            diagnostics,
        )),
        ServerControlResponseBody::Query(ServerQueryResult::AcceptedMemoryReviewReadiness(
            readiness,
        )) => Some(accepted_memory_review_readiness_body_dto(readiness)),
        _ => None,
    }
}
