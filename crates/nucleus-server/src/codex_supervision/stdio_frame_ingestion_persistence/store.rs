use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreResult, RevisionExpectation,
};
use nucleus_orchestration::{
    encode_orchestration_event_store_record, OrchestrationEventStoreRecord,
};

use super::super::transport_receipts::codex_receipt_from_stdio_frame;
use super::codec::{decode_frame_ingestion_record, encode_frame_ingestion_record, json_payload};
use super::event_builder::observation_event_from_frame;
use super::record_builder::persistence_record_from_parts;
use super::types::{
    CodexAppServerStdioFrameIngestionPersistenceInput,
    CodexAppServerStdioFrameIngestionPersistenceRecord,
};
use super::INGESTION_RECORD_PREFIX;
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::state::ServerStateService;

/// Persist sanitized frame source, decode receipt, and optional observation event.
pub fn persist_codex_stdio_frame_ingestion<B>(
    state: &ServerStateService<B>,
    input: CodexAppServerStdioFrameIngestionPersistenceInput,
) -> LocalStoreResult<CodexAppServerStdioFrameIngestionPersistenceRecord>
where
    B: LocalStoreBackend,
{
    let receipt = codex_receipt_from_stdio_frame(&input.frame);
    let event = observation_event_from_frame(&input.frame);
    let record = persistence_record_from_parts(&input.frame, &receipt.receipt_id, &event);

    write_frame_ingestion_metadata(state, &record)?;
    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::MustNotExist,
    )?;

    if let Some(event) = &event {
        write_frame_ingestion_event(state, event)?;
    }

    Ok(record)
}

/// Read persisted Codex stdio frame ingestion records from server state.
pub fn read_codex_stdio_frame_ingestion_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CodexAppServerStdioFrameIngestionPersistenceRecord>>
where
    B: LocalStoreBackend,
{
    state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(INGESTION_RECORD_PREFIX))
        .map(|record| decode_frame_ingestion_record(&record.payload.bytes))
        .collect()
}

fn write_frame_ingestion_metadata<B>(
    state: &ServerStateService<B>,
    record: &CodexAppServerStdioFrameIngestionPersistenceRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let payload = encode_frame_ingestion_record(record)?;

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.ingestion_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.ingestion_id)),
            payload: json_payload(payload),
        },
        RevisionExpectation::MustNotExist,
    )
}

fn write_frame_ingestion_event<B>(
    state: &ServerStateService<B>,
    event: &OrchestrationEventStoreRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let payload = encode_orchestration_event_store_record(event).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.to_string(),
        }
    })?;

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
