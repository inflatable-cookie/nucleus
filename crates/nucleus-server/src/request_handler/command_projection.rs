use nucleus_local_store::{LocalStoreBackend, LocalStoreError};
use nucleus_orchestration::{
    CommandAdmissionProjection, OrchestrationEventRecord, OrchestrationEventStoreRepository,
};

use super::event_store::ServerOrchestrationEventStore;
use crate::state::ServerStateService;

pub fn rebuild_command_admission_projection<B>(
    state: &ServerStateService<B>,
) -> Result<CommandAdmissionProjection, LocalStoreError>
where
    B: LocalStoreBackend,
{
    let events = ServerOrchestrationEventStore::new(state)
        .list_events()?
        .into_iter()
        .map(|event_store_record| event_store_record.into_payload())
        .collect::<Vec<OrchestrationEventRecord>>();

    Ok(CommandAdmissionProjection::rebuild(&events))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request_handler::command_events::append_command_admitted_event;
    use crate::state::ServerStateService;
    use nucleus_local_store::SqliteBackend;
    use nucleus_orchestration::{
        OrchestrationAcceptedCommand, OrchestrationCommandFamily, OrchestrationCommandId,
    };

    #[test]
    fn command_admission_projection_rebuilds_from_event_journal() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        append_command_admitted_event(
            &state,
            &OrchestrationAcceptedCommand {
                command_id: OrchestrationCommandId("command:task:1".to_owned()),
                family: OrchestrationCommandFamily::Task,
                target_ref: Some("task:1".to_owned()),
            },
        )
        .expect("append event");
        append_command_admitted_event(
            &state,
            &OrchestrationAcceptedCommand {
                command_id: OrchestrationCommandId("command:project:1".to_owned()),
                family: OrchestrationCommandFamily::Project,
                target_ref: Some("project:1".to_owned()),
            },
        )
        .expect("append project event");

        let projection = rebuild_command_admission_projection(&state).expect("rebuild projection");
        let replayed_projection =
            rebuild_command_admission_projection(&state).expect("replay projection");

        assert_eq!(projection, replayed_projection);
        assert_eq!(projection.admitted_total, 2);
        assert_eq!(projection.task_commands, 1);
        assert_eq!(
            projection.last_cursor.expect("cursor").source_event_id,
            "event:command:task:1:admitted"
        );
    }
}
