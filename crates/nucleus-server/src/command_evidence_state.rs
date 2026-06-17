//! Server-owned command evidence state helpers.

use nucleus_command_policy::{encode_command_evidence_storage_record, CommandEvidence};
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};

use crate::state::ServerStateService;

/// Write sanitized command evidence through the server state facade.
pub fn write_command_evidence<B>(
    state: &ServerStateService<B>,
    evidence: &CommandEvidence,
    revision_id: RevisionId,
    revision: RevisionExpectation,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let payload = encode_command_evidence_storage_record(evidence).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.reason,
        }
    })?;
    let record = LocalStoreRecord {
        id: PersistenceRecordId(evidence.id.0.clone()),
        domain: PersistenceDomain::CommandEvidence,
        kind: PersistenceRecordKind::CommandEvidence,
        revision_id,
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    state.command_evidence().put(record, revision)
}

#[cfg(test)]
mod tests {
    use nucleus_command_policy::{
        command_evidence_from_storage_record, decode_command_evidence_storage_record,
        CommandEvidenceId, CommandExecutionStatus, CommandOutputRetention, CommandRequestId,
    };
    use nucleus_local_store::SqliteBackend;

    use super::*;

    fn evidence() -> CommandEvidence {
        CommandEvidence {
            id: CommandEvidenceId("command:evidence:state".to_owned()),
            request_id: CommandRequestId("command:request:state".to_owned()),
            status: CommandExecutionStatus::BlockedByPolicy,
            exit_status: None,
            retention: CommandOutputRetention::SummaryOnly,
            summary: Some("blocked before execution".to_owned()),
            stdout_artifact_ref: None,
            stderr_artifact_ref: None,
        }
    }

    #[test]
    fn command_evidence_state_helper_writes_and_reads_sanitized_record() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let evidence = evidence();

        let record = write_command_evidence(
            &state,
            &evidence,
            RevisionId("rev:command-evidence:1".to_owned()),
            RevisionExpectation::MustNotExist,
        )
        .expect("write evidence");
        let stored = state
            .command_evidence()
            .get(&record.id)
            .expect("read evidence")
            .expect("evidence exists");
        let decoded =
            decode_command_evidence_storage_record(&stored.payload.bytes).expect("decode evidence");
        let restored = command_evidence_from_storage_record(&decoded);

        assert_eq!(restored, evidence);
    }

    #[test]
    fn command_evidence_state_helper_does_not_write_raw_output_fields() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let evidence = evidence();

        let record = write_command_evidence(
            &state,
            &evidence,
            RevisionId("rev:command-evidence:1".to_owned()),
            RevisionExpectation::MustNotExist,
        )
        .expect("write evidence");
        let json = String::from_utf8(record.payload.bytes).expect("json");

        for forbidden in [
            "raw_stdout",
            "raw_stderr",
            "stdout_bytes",
            "stderr_bytes",
            "terminal_stream",
            "shell_trace",
            "environment",
            "credential",
        ] {
            assert!(
                !json.contains(forbidden),
                "storage payload should not contain {forbidden}"
            );
        }
    }
}
