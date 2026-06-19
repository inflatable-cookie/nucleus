use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::EngineTaskAgentWorkUnitSourceRecord;
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};

use crate::state::ServerStateService;

use super::codec::{decode_source_record, encode_source_record};
use super::transitions::{validate_initial_source_record, validate_source_record_transition};
use super::validation::validate_source_record;

const MEDIA_TYPE: &str = "application/vnd.nucleus.task-agent-work-unit-source+json";

/// Write one task-agent work-unit source record into task history.
pub fn write_task_agent_work_unit_source_record<B>(
    state: &ServerStateService<B>,
    record: EngineTaskAgentWorkUnitSourceRecord,
    revision_id: RevisionId,
    expectation: RevisionExpectation,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    validate_source_record(&record)?;
    validate_transition_for_write(state, &record)?;
    state.task_history().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.source_id.0.clone()),
            domain: PersistenceDomain::TaskHistory,
            kind: PersistenceRecordKind::TaskHistoryEntry,
            revision_id,
            payload: LocalStoreRecordPayload {
                media_type: Some(MEDIA_TYPE.to_owned()),
                bytes: encode_source_record(record)?,
            },
        },
        expectation,
    )
}

fn validate_transition_for_write<B>(
    state: &ServerStateService<B>,
    record: &EngineTaskAgentWorkUnitSourceRecord,
) -> LocalStoreResult<()>
where
    B: LocalStoreBackend,
{
    let Some(previous_source_id) = &record.previous_source_id else {
        return validate_initial_source_record(record);
    };
    let previous = state
        .task_history()
        .get(&PersistenceRecordId(previous_source_id.0.clone()))?
        .ok_or_else(|| LocalStoreError::InvalidRecord {
            reason: format!("previous source record not found: {}", previous_source_id.0),
        })?;
    let previous = decode_persisted_record(previous)?;
    validate_source_record_transition(&previous, record)
}

/// Read all persisted task-agent work-unit source records from task history.
pub fn read_task_agent_work_unit_source_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<EngineTaskAgentWorkUnitSourceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = Vec::new();
    for record in state.task_history().list()? {
        if record.kind != PersistenceRecordKind::TaskHistoryEntry {
            continue;
        }
        if record.payload.media_type.as_deref() != Some(MEDIA_TYPE) {
            continue;
        }
        records.push(decode_persisted_record(record)?);
    }
    records.sort_by(|left, right| left.source_cursor.0.cmp(&right.source_cursor.0));
    Ok(records)
}

fn decode_persisted_record(
    record: LocalStoreRecord,
) -> LocalStoreResult<EngineTaskAgentWorkUnitSourceRecord> {
    if record.domain != PersistenceDomain::TaskHistory {
        return Err(LocalStoreError::InvalidRecord {
            reason: format!("expected task history record, got {:?}", record.domain),
        });
    }
    let source_record = decode_source_record(&record.payload.bytes)?;
    validate_source_record(&source_record)?;
    Ok(source_record)
}
