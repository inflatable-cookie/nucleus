use nucleus_local_store::{LocalStoreBackend, LocalStoreError};
use nucleus_orchestration::{
    EventStreamRef, OrchestrationAcceptedCommand, OrchestrationEventId, OrchestrationEventRecord,
    OrchestrationEventStoreRecord, OrchestrationEventStoreRepository,
};

use super::event_store::ServerOrchestrationEventStore;
use crate::state::ServerStateService;

pub(crate) fn append_command_admitted_event<B>(
    state: &ServerStateService<B>,
    accepted: &OrchestrationAcceptedCommand,
) -> Result<(), LocalStoreError>
where
    B: LocalStoreBackend,
{
    let event_id = OrchestrationEventId(format!("event:{}:admitted", accepted.command_id.0));
    let record = OrchestrationEventRecord::command_admitted(
        event_id.clone(),
        accepted.command_id.clone(),
        accepted.family.clone(),
        accepted.target_ref.clone(),
    );
    let event_store_record =
        OrchestrationEventStoreRecord::from_event(event_stream_ref(accepted), record);
    ServerOrchestrationEventStore::new(state).append_event(event_store_record)
}

fn event_stream_ref(accepted: &OrchestrationAcceptedCommand) -> EventStreamRef {
    let target = accepted
        .target_ref
        .as_deref()
        .unwrap_or("target:unassigned");

    EventStreamRef(format!("stream:command-admission:{target}"))
}
