use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreResult, RevisionExpectation,
};

use super::codec::{decode_decode_outcome_record, encode_decode_outcome_record, json_payload};
use super::record_builder::decode_outcome_from_ingestion;
use super::types::{
    CodexAppServerDecodeOutcomePersistenceInput, CodexAppServerDecodeOutcomePersistenceRecord,
};
use super::validation::validate_ingestion_for_decode_outcome;
use super::DECODE_OUTCOME_PREFIX;
use crate::state::ServerStateService;

/// Persist one summarized decode outcome derived from sanitized ingestion.
pub fn persist_codex_decode_outcome<B>(
    state: &ServerStateService<B>,
    input: CodexAppServerDecodeOutcomePersistenceInput,
) -> LocalStoreResult<CodexAppServerDecodeOutcomePersistenceRecord>
where
    B: LocalStoreBackend,
{
    validate_ingestion_for_decode_outcome(&input.ingestion)?;
    let record = decode_outcome_from_ingestion(&input.ingestion);

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.outcome_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.outcome_id)),
            payload: json_payload(encode_decode_outcome_record(&record)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

/// Read persisted summarized Codex stdio decode outcomes.
pub fn read_codex_decode_outcome_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CodexAppServerDecodeOutcomePersistenceRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(DECODE_OUTCOME_PREFIX))
        .map(|record| decode_decode_outcome_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.outcome_id.cmp(&right.outcome_id));
    Ok(records)
}
