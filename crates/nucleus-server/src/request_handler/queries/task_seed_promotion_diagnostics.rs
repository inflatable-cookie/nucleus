use nucleus_core::{PersistenceRecordId, PersistenceRecordKind};
use nucleus_engine::{decode_task_seed_storage_record, task_seed_from_storage_record};
use nucleus_local_store::LocalStoreBackend;

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{
    ServerControlError, ServerQueryResult, TaskSeedPromotionDiagnosticsQuery,
};
use crate::planning_task_seed_promotion_diagnostics::planning_task_seed_promotion_diagnostics;

pub(super) fn task_seed_promotion_diagnostics_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: TaskSeedPromotionDiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut records = Vec::new();
    for record in handler.state().planning().list().map_err(storage_error)? {
        if record.kind != PersistenceRecordKind::TaskSeed {
            continue;
        }
        let storage_record =
            decode_task_seed_storage_record(&record.payload.bytes).map_err(|error| {
                ServerControlError::StorageUnavailable {
                    reason: format!("planning task seed decode failed: {}", error.reason),
                }
            })?;
        records.push(task_seed_from_storage_record(&storage_record));
    }

    let state = handler.state();
    Ok(ServerQueryResult::TaskSeedPromotionDiagnostics(
        planning_task_seed_promotion_diagnostics(query.project_id, records, |task_ref| {
            state
                .tasks()
                .get(&PersistenceRecordId(task_ref.to_owned()))
                .ok()
                .flatten()
                .is_some()
        }),
    ))
}

#[cfg(test)]
mod tests;
