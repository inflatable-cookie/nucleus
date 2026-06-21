use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreResult, RevisionExpectation,
};
use nucleus_orchestration::{
    encode_orchestration_event_store_record, OrchestrationEventStoreRecord,
};

use crate::state::ServerStateService;

use super::codec::{encode_persistence_record, json_error, json_payload};
use super::types::CodexRuntimeObservationEventStorePersistenceRecord;

pub(super) fn write_event_store_record<B>(
    state: &ServerStateService<B>,
    event: &OrchestrationEventStoreRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let payload = encode_orchestration_event_store_record(event).map_err(json_error)?;

    state.event_journal().put(
        LocalStoreRecord {
            id: PersistenceRecordId(event.event_id.0.clone()),
            domain: PersistenceDomain::EventJournal,
            kind: PersistenceRecordKind::Event,
            revision_id: RevisionId(format!("rev:{}", event.event_id.0)),
            payload: json_payload(payload),
        },
        RevisionExpectation::MustNotExist,
    )
}

pub(super) fn write_persistence_record<B>(
    state: &ServerStateService<B>,
    record: &CodexRuntimeObservationEventStorePersistenceRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.persistence_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.persistence_id)),
            payload: json_payload(encode_persistence_record(record)?),
        },
        RevisionExpectation::Any,
    )
}
