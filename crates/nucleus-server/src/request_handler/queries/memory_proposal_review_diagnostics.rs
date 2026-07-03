use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;
use nucleus_memory::decode_memory_proposal_storage_record;

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{
    MemoryProposalReviewDiagnosticsQuery, ServerControlError, ServerQueryResult,
};
use crate::memory_proposal_review_diagnostics::memory_proposal_review_diagnostics;

pub(super) fn memory_proposal_review_diagnostics_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: MemoryProposalReviewDiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut records = Vec::new();
    for record in handler
        .state()
        .shared_memory()
        .list()
        .map_err(storage_error)?
    {
        if record.kind != PersistenceRecordKind::SharedMemoryRecord {
            continue;
        }
        records.push(
            decode_memory_proposal_storage_record(&record.payload.bytes).map_err(|error| {
                ServerControlError::StorageUnavailable {
                    reason: format!("memory proposal decode failed: {}", error.reason),
                }
            })?,
        );
    }

    Ok(ServerQueryResult::MemoryProposalReviewDiagnostics(
        memory_proposal_review_diagnostics(query.project_id, records),
    ))
}
