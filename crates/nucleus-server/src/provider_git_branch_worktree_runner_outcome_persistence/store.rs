use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};

use crate::ServerStateService;

use super::types::GitBranchWorktreeRunnerOutcomePersistenceRecord;

pub(super) const OUTCOME_PREFIX: &str = "git-branch-worktree-runner-outcome:";

pub(super) fn write_outcome_record<B>(
    state: &ServerStateService<B>,
    record: &GitBranchWorktreeRunnerOutcomePersistenceRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.persisted_outcome_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.persisted_outcome_id)),
            payload: json_payload(serde_json::to_vec(record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )
}

pub(super) fn decode_outcome_record(
    bytes: &[u8],
) -> LocalStoreResult<GitBranchWorktreeRunnerOutcomePersistenceRecord> {
    serde_json::from_slice::<GitBranchWorktreeRunnerOutcomePersistenceRecord>(bytes)
        .map_err(json_error)
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
