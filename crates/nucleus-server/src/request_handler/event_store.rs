use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};
use nucleus_orchestration::{
    decode_orchestration_event_store_record, encode_orchestration_event_store_record,
    OrchestrationEventStoreRecord, OrchestrationEventStoreRepository,
};

use crate::state::ServerStateService;

pub(crate) struct ServerOrchestrationEventStore<'a, B>
where
    B: LocalStoreBackend,
{
    state: &'a ServerStateService<B>,
}

impl<'a, B> ServerOrchestrationEventStore<'a, B>
where
    B: LocalStoreBackend,
{
    pub(crate) fn new(state: &'a ServerStateService<B>) -> Self {
        Self { state }
    }
}

impl<B> OrchestrationEventStoreRepository for ServerOrchestrationEventStore<'_, B>
where
    B: LocalStoreBackend,
{
    type Error = LocalStoreError;

    fn append_event(&self, record: OrchestrationEventStoreRecord) -> Result<(), Self::Error> {
        let payload = encode_orchestration_event_store_record(&record).map_err(|error| {
            LocalStoreError::InvalidRecord {
                reason: error.to_string(),
            }
        })?;

        self.state.event_journal().put(
            LocalStoreRecord {
                id: PersistenceRecordId(record.event_id.0.clone()),
                domain: PersistenceDomain::EventJournal,
                kind: PersistenceRecordKind::Event,
                revision_id: RevisionId(format!("rev:{}", record.event_id.0)),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: payload,
                },
            },
            RevisionExpectation::MustNotExist,
        )?;

        Ok(())
    }

    fn list_events(&self) -> Result<Vec<OrchestrationEventStoreRecord>, Self::Error> {
        let mut records = self
            .state
            .event_journal()
            .list()?
            .iter()
            .map(|record| decode_orchestration_event_store_record(&record.payload.bytes))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| LocalStoreError::InvalidRecord {
                reason: error.to_string(),
            })?;
        records.sort_by(|left, right| left.event_id.0.cmp(&right.event_id.0));
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ServerStateService;
    use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
    use nucleus_local_store::{
        LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
    };
    use nucleus_orchestration::{
        EventStreamRef, OrchestrationCommandFamily, OrchestrationCommandId, OrchestrationEventId,
        OrchestrationEventRecord,
    };

    #[test]
    fn server_event_store_appends_and_lists_enveloped_events() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let store = ServerOrchestrationEventStore::new(&state);
        let payload = OrchestrationEventRecord::command_admitted(
            OrchestrationEventId("event:1".to_owned()),
            OrchestrationCommandId("command:1".to_owned()),
            OrchestrationCommandFamily::Task,
            Some("task:1".to_owned()),
        );
        let record = OrchestrationEventStoreRecord::from_event(
            EventStreamRef("stream:command-admission:task:1".to_owned()),
            payload,
        );

        store.append_event(record.clone()).expect("append event");
        let events = store.list_events().expect("list events");

        assert_eq!(events, vec![record]);
    }

    #[test]
    fn server_event_store_rejects_malformed_event_payloads() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        state
            .event_journal()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId("event:bad".to_owned()),
                    domain: PersistenceDomain::EventJournal,
                    kind: PersistenceRecordKind::Event,
                    revision_id: RevisionId("rev:event:bad".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: b"{not-json".to_vec(),
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("seed malformed event");

        let error = ServerOrchestrationEventStore::new(&state)
            .list_events()
            .expect_err("reject malformed event");

        assert!(matches!(error, LocalStoreError::InvalidRecord { .. }));
    }
}
