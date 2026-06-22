use nucleus_engine::EngineTaskTimelineProjection;
use nucleus_local_store::LocalStoreBackend;
use nucleus_orchestration::{OrchestrationEventRecord, OrchestrationEventStoreRepository};

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{ServerControlError, ServerQueryResult, TaskTimelineQuery};
use crate::request_handler::event_store::ServerOrchestrationEventStore;

pub(super) fn task_timeline_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: TaskTimelineQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let events = ServerOrchestrationEventStore::new(handler.state())
        .list_events()
        .map_err(storage_error)?
        .into_iter()
        .map(|event_store_record| event_store_record.into_payload())
        .collect::<Vec<OrchestrationEventRecord>>();
    let projection = EngineTaskTimelineProjection::rebuild(query.task_id, &events);

    Ok(ServerQueryResult::TaskTimeline(projection))
}
