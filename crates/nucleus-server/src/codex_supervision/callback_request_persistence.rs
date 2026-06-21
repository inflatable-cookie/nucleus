//! Codex callback request persistence.
//!
//! This module stores sanitized callback wait-state records. It does not retain
//! raw callback material, answer callbacks, perform provider I/O, or mutate
//! task state.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreResult, RevisionExpectation,
};

use crate::state::ServerStateService;

mod codec;
mod record_builder;
mod types;
mod validation;

pub use types::{
    CodexAppServerCallbackRequestPersistenceInput, CodexAppServerCallbackRequestPersistenceRecord,
    CodexAppServerCallbackRequestPersistenceWaitState,
};

use codec::{decode_callback_request_record, encode_callback_request_record, json_payload};
use record_builder::persistence_record_from_input;
use validation::validate_request_for_persistence;

const CALLBACK_REQUEST_PREFIX: &str = "codex-callback-request:";

/// Persist one sanitized Codex callback request record.
pub fn persist_codex_callback_request<B>(
    state: &ServerStateService<B>,
    input: CodexAppServerCallbackRequestPersistenceInput,
) -> LocalStoreResult<CodexAppServerCallbackRequestPersistenceRecord>
where
    B: LocalStoreBackend,
{
    validate_request_for_persistence(&input.request, &input.runtime_receipt_refs)?;
    let record = persistence_record_from_input(input);

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.persistence_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.persistence_id)),
            payload: json_payload(encode_callback_request_record(&record)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

/// Read persisted sanitized Codex callback request records.
pub fn read_codex_callback_request_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CodexAppServerCallbackRequestPersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(CALLBACK_REQUEST_PREFIX))
        .map(|record| decode_callback_request_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.persistence_id.cmp(&right.persistence_id));
    Ok(records)
}

#[cfg(test)]
mod tests;
