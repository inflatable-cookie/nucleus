//! Server-owned checkpoint and diff summary state helpers.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    decode_checkpoint_record, decode_diff_summary_record, encode_checkpoint_record,
    encode_diff_summary_record, EngineCheckpointRecord, EngineDiffSummaryRecord,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};

use crate::state::ServerStateService;

const CHECKPOINT_RECORD_PREFIX: &str = "checkpoint:";
const DIFF_SUMMARY_RECORD_PREFIX: &str = "diff:";

pub fn write_checkpoint_record<B>(
    state: &ServerStateService<B>,
    record: &EngineCheckpointRecord,
    revision_id: RevisionId,
    revision: RevisionExpectation,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let payload =
        encode_checkpoint_record(record).map_err(|error| LocalStoreError::InvalidRecord {
            reason: error.reason,
        })?;
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.checkpoint_id.0.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id,
            payload: json_payload(payload),
        },
        revision,
    )
}

pub fn write_diff_summary_record<B>(
    state: &ServerStateService<B>,
    record: &EngineDiffSummaryRecord,
    revision_id: RevisionId,
    revision: RevisionExpectation,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let payload =
        encode_diff_summary_record(record).map_err(|error| LocalStoreError::InvalidRecord {
            reason: error.reason,
        })?;
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.diff_id.0.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id,
            payload: json_payload(payload),
        },
        revision,
    )
}

pub fn read_checkpoint_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<EngineCheckpointRecord>>
where
    B: LocalStoreBackend,
{
    state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(CHECKPOINT_RECORD_PREFIX))
        .map(|record| {
            decode_checkpoint_record(&record.payload.bytes).map_err(|error| {
                LocalStoreError::InvalidRecord {
                    reason: error.reason,
                }
            })
        })
        .collect()
}

pub fn read_diff_summary_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<EngineDiffSummaryRecord>>
where
    B: LocalStoreBackend,
{
    state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(DIFF_SUMMARY_RECORD_PREFIX))
        .map(|record| {
            decode_diff_summary_record(&record.payload.bytes).map_err(|error| {
                LocalStoreError::InvalidRecord {
                    reason: error.reason,
                }
            })
        })
        .collect()
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_engine::{
        EngineCheckpointFamily, EngineCheckpointRecordId, EngineCheckpointRecoveryState,
        EngineCheckpointRef, EngineDiffSummaryConfidence, EngineDiffSummaryKind,
        EngineDiffSummaryRecordId,
    };
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn checkpoint_diff_state_writes_and_reads_typed_records() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let checkpoint = EngineCheckpointRecord {
            checkpoint_id: EngineCheckpointRecordId("checkpoint:task:1".to_owned()),
            family: EngineCheckpointFamily::TaskWork,
            primary_workflow_ref: EngineCheckpointRef::TaskId("task:1".to_owned()),
            project_ref: EngineCheckpointRef::ProjectId("project:1".to_owned()),
            source_ref: Some(EngineCheckpointRef::SnapshotRef("snapshot:1".to_owned())),
            scm_adapter_ref: Some(EngineCheckpointRef::ScmAdapterRef(
                "adapter:convergence".to_owned(),
            )),
            authority_host_ref: EngineCheckpointRef::AuthorityHostId("host:local".to_owned()),
            created_by_actor_ref: EngineCheckpointRef::ActorId("actor:user".to_owned()),
            causal_refs: vec![EngineCheckpointRef::CommandId("command:1".to_owned())],
            parent_checkpoint_refs: Vec::new(),
            artifact_refs: Vec::new(),
            summary: Some("checkpoint summary".to_owned()),
            recovery_state: EngineCheckpointRecoveryState::Available,
        };
        let diff = EngineDiffSummaryRecord {
            diff_id: EngineDiffSummaryRecordId("diff:checkpoint:1".to_owned()),
            kind: EngineDiffSummaryKind::Source,
            source_boundary_ref: EngineCheckpointRef::SnapshotRef("snapshot:before".to_owned()),
            target_boundary_ref: EngineCheckpointRef::SnapshotRef("snapshot:after".to_owned()),
            source_ref: Some(EngineCheckpointRef::RepoId("repo:1".to_owned())),
            adapter_ref: Some(EngineCheckpointRef::ScmAdapterRef("adapter:scm".to_owned())),
            generated_by_ref: EngineCheckpointRef::CommandId("command:diff".to_owned()),
            confidence: EngineDiffSummaryConfidence::Partial,
            summary: "one path changed".to_owned(),
            changed_paths: vec!["src/lib.rs".to_owned()],
            path_changes: Vec::new(),
            counts: nucleus_engine::EngineDiffSummaryCounts {
                modified: 1,
                ..nucleus_engine::EngineDiffSummaryCounts::default()
            },
            coverage: nucleus_engine::EngineDiffCoverageState::Complete,
            truncated: false,
            attribution_notice: None,
            evidence_refs: Vec::new(),
            artifact_refs: Vec::new(),
        };

        write_checkpoint_record(
            &state,
            &checkpoint,
            RevisionId("rev:checkpoint:1".to_owned()),
            RevisionExpectation::MustNotExist,
        )
        .expect("write checkpoint");
        write_diff_summary_record(
            &state,
            &diff,
            RevisionId("rev:diff:1".to_owned()),
            RevisionExpectation::MustNotExist,
        )
        .expect("write diff");

        assert_eq!(
            read_checkpoint_records(&state).expect("read checkpoints"),
            vec![checkpoint]
        );
        assert_eq!(
            read_diff_summary_records(&state).expect("read diffs"),
            vec![diff]
        );
    }
}
