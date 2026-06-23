use nucleus_core::PersistenceRecordKind;
use nucleus_engine::{
    decode_task_seed_storage_record, task_seed_from_storage_record,
    EngineTaskSeedCandidateProjection,
};
use nucleus_local_store::LocalStoreBackend;

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{PlanningTaskSeedsQuery, ServerControlError, ServerQueryResult};

pub(super) fn planning_task_seeds_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: PlanningTaskSeedsQuery,
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

    Ok(ServerQueryResult::PlanningTaskSeeds(
        EngineTaskSeedCandidateProjection::from_records(query.project_id, records),
    ))
}

#[cfg(test)]
mod tests;
