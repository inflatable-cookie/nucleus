use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};

use crate::ServerStateService;

use super::ProviderLiveReadPersistenceRecord;

pub(super) const LIVE_READ_PREFIX: &str = "provider-live-read-persistence:";

pub(super) fn write_live_read_record<B>(
    state: &ServerStateService<B>,
    record: &ProviderLiveReadPersistenceRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.persisted_live_read_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.persisted_live_read_id)),
            payload: json_payload(serde_json::to_vec(record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )
}

pub(super) fn decode_live_read_record(
    bytes: &[u8],
) -> LocalStoreResult<ProviderLiveReadPersistenceRecord> {
    serde_json::from_slice::<ProviderLiveReadPersistenceRecord>(bytes).map_err(json_error)
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}
