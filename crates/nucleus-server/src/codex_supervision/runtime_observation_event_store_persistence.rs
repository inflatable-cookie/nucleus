//! Runtime observation event-store persistence.
//!
//! This module promotes accepted runtime observation identities into
//! orchestration event-store records. Rejected observations are persisted only
//! as sanitized repair evidence.

use nucleus_core::PersistenceRecordId;
use nucleus_local_store::{LocalStoreBackend, LocalStoreResult};

use crate::state::ServerStateService;

mod codec;
mod record_builder;
mod store;
mod types;

pub use types::{
    CodexRuntimeObservationEventStorePersistenceInput,
    CodexRuntimeObservationEventStorePersistenceRecord,
    CodexRuntimeObservationEventStorePersistenceStatus,
};

use codec::decode_persistence_record;
use record_builder::persistence_record_from_input;
use store::{write_event_store_record, write_persistence_record};

const EVENT_PERSISTENCE_PREFIX: &str = "codex-runtime-observation-event-persistence:";

/// Persist one accepted runtime observation as an orchestration event.
pub fn persist_codex_runtime_observation_event_store<B>(
    state: &ServerStateService<B>,
    input: CodexRuntimeObservationEventStorePersistenceInput,
) -> LocalStoreResult<CodexRuntimeObservationEventStorePersistenceRecord>
where
    B: LocalStoreBackend,
{
    let mut record = persistence_record_from_input(&input);

    if record.status == CodexRuntimeObservationEventStorePersistenceStatus::Persisted {
        if state
            .event_journal()
            .get(&PersistenceRecordId(
                record
                    .event_id
                    .clone()
                    .expect("event id for persisted record"),
            ))?
            .is_some()
        {
            record.status = CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop;
            record.event_store_record = None;
        } else if let Some(event_store_record) = &record.event_store_record {
            write_event_store_record(state, event_store_record)?;
        }
    }

    write_persistence_record(state, &record)?;
    Ok(record)
}

/// Read persisted runtime observation event-store promotion records.
pub fn read_codex_runtime_observation_event_store_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CodexRuntimeObservationEventStorePersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(EVENT_PERSISTENCE_PREFIX))
        .map(|record| decode_persistence_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.persistence_id.cmp(&right.persistence_id));
    Ok(records)
}

#[cfg(test)]
mod tests;
