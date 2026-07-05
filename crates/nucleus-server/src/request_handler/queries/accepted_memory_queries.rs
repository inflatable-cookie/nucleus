use nucleus_local_store::LocalStoreBackend;

use super::{
    accepted_memory, accepted_memory_projection_diagnostics,
    accepted_memory_projection_import_apply_diagnostics,
    accepted_memory_projection_import_diagnostics, accepted_memory_projection_write_diagnostics,
    accepted_memory_review_readiness, LocalControlRequestHandler,
};
use crate::control_api::{ServerControlError, ServerQueryKind, ServerQueryResult};

pub(super) fn accepted_memory_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: ServerQueryKind,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    match query {
        ServerQueryKind::AcceptedMemory(query) => {
            accepted_memory::accepted_memory_query(handler, query)
        }
        ServerQueryKind::AcceptedMemoryProjectionDiagnostics(query) => {
            accepted_memory_projection_diagnostics::accepted_memory_projection_diagnostics_query(
                handler, query,
            )
        }
        ServerQueryKind::AcceptedMemoryProjectionWriteDiagnostics(query) => {
            accepted_memory_projection_write_diagnostics::accepted_memory_projection_write_diagnostics_query(
                handler, query,
            )
        }
        ServerQueryKind::AcceptedMemoryProjectionImportDiagnostics(query) => {
            accepted_memory_projection_import_diagnostics::accepted_memory_projection_import_diagnostics_query(
                handler, query,
            )
        }
        ServerQueryKind::AcceptedMemoryProjectionImportApplyDiagnostics(query) => {
            accepted_memory_projection_import_apply_diagnostics::accepted_memory_projection_import_apply_diagnostics_query(
                handler, query,
            )
        }
        ServerQueryKind::AcceptedMemoryReviewReadiness(query) => {
            accepted_memory_review_readiness::accepted_memory_review_readiness_query(
                handler, query,
            )
        }
        _ => unreachable!("accepted memory query dispatcher received non-memory query"),
    }
}
