use nucleus_engine::{EngineTaskReadinessInput, EngineTaskReadinessProjection};
use nucleus_local_store::LocalStoreBackend;
use nucleus_tasks::{decode_task_storage_record, task_from_storage_record};

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{ServerControlError, ServerQueryResult, TaskReadinessQuery};

pub(super) fn task_readiness_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: TaskReadinessQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut tasks = Vec::new();
    for record in handler.state().tasks().list().map_err(storage_error)? {
        let storage_record =
            decode_task_storage_record(&record.payload.bytes).map_err(|error| {
                ServerControlError::StorageUnavailable {
                    reason: format!("task record decode failed: {}", error.reason),
                }
            })?;
        let task = task_from_storage_record(&storage_record);
        tasks.push(EngineTaskReadinessInput::from(&task));
    }

    Ok(ServerQueryResult::TaskReadiness(
        EngineTaskReadinessProjection::from_tasks(query.project_id, tasks),
    ))
}

#[cfg(test)]
mod tests;
