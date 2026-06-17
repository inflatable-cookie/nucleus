//! Server-owned runtime receipt state helpers.

use nucleus_command_policy::CommandExecutionStatus;
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    decode_runtime_receipt_record, encode_runtime_receipt_record, EngineRuntimeReceiptEffectFamily,
    EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId, EngineRuntimeReceiptRef,
    EngineRuntimeReceiptStatus,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};

use crate::read_only_command_control::ReadOnlyCommandControlResult;
use crate::state::ServerStateService;

pub fn runtime_receipt_from_read_only_command_result(
    result: &ReadOnlyCommandControlResult,
) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:{}:read-only-command",
            result.command_id.0
        )),
        family: EngineRuntimeReceiptEffectFamily::CommandExecution,
        status: receipt_status(&result.status),
        command_ref: Some(EngineRuntimeReceiptRef::CommandId(
            result.command_id.0.clone(),
        )),
        effect_ref: Some(EngineRuntimeReceiptRef::CommandRequestId(
            result.command_request_id.0.clone(),
        )),
        evidence_refs: vec![EngineRuntimeReceiptRef::CommandEvidenceId(
            result.evidence_id.0.clone(),
        )],
        artifact_refs: Vec::new(),
        summary: result.summary.clone(),
    }
}

pub fn write_runtime_receipt<B>(
    state: &ServerStateService<B>,
    receipt: &EngineRuntimeReceiptRecord,
    revision_id: RevisionId,
    revision: RevisionExpectation,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let payload =
        encode_runtime_receipt_record(receipt).map_err(|error| LocalStoreError::InvalidRecord {
            reason: error.reason,
        })?;
    let record = LocalStoreRecord {
        id: PersistenceRecordId(receipt.receipt_id.0.clone()),
        domain: PersistenceDomain::RuntimeEffects,
        kind: PersistenceRecordKind::RuntimeEffect,
        revision_id,
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    state.runtime_effects().put(record, revision)
}

pub fn read_runtime_receipts<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<EngineRuntimeReceiptRecord>>
where
    B: LocalStoreBackend,
{
    state
        .runtime_effects()
        .list()?
        .iter()
        .map(|record| {
            decode_runtime_receipt_record(&record.payload.bytes).map_err(|error| {
                LocalStoreError::InvalidRecord {
                    reason: error.reason,
                }
            })
        })
        .collect()
}

fn receipt_status(status: &CommandExecutionStatus) -> EngineRuntimeReceiptStatus {
    match status {
        CommandExecutionStatus::Accepted
        | CommandExecutionStatus::Queued
        | CommandExecutionStatus::Running => EngineRuntimeReceiptStatus::InProgress,
        CommandExecutionStatus::Rejected => EngineRuntimeReceiptStatus::Blocked,
        CommandExecutionStatus::Succeeded => EngineRuntimeReceiptStatus::Completed,
        CommandExecutionStatus::Failed => EngineRuntimeReceiptStatus::Failed,
        CommandExecutionStatus::Cancelled => EngineRuntimeReceiptStatus::Cancelled,
        CommandExecutionStatus::TimedOut => EngineRuntimeReceiptStatus::TimedOut,
        CommandExecutionStatus::BlockedByPolicy => EngineRuntimeReceiptStatus::Blocked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read_only_command_control::ReadOnlyCommandControlResult;
    use nucleus_command_policy::{
        CommandEvidenceId, CommandExecutionStatus, CommandOutputRetention, CommandRequestId,
    };
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn runtime_receipt_state_writes_and_reads_sanitized_record() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let result = ReadOnlyCommandControlResult {
            command_id: crate::ServerCommandId("command:receipt".to_owned()),
            command_request_id: CommandRequestId("command:receipt:request".to_owned()),
            evidence_id: CommandEvidenceId("command:receipt:evidence".to_owned()),
            status: CommandExecutionStatus::Succeeded,
            exit_status: Some(0),
            retention: CommandOutputRetention::SummaryOnly,
            summary: Some("sanitized summary".to_owned()),
            stdout_captured_bytes: 4,
            stderr_captured_bytes: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            events: 1,
            rejection: None,
        };
        let receipt = runtime_receipt_from_read_only_command_result(&result);

        let record = write_runtime_receipt(
            &state,
            &receipt,
            RevisionId("rev:receipt:1".to_owned()),
            RevisionExpectation::MustNotExist,
        )
        .expect("write receipt");
        let json = String::from_utf8(record.payload.bytes).expect("json");
        let receipts = read_runtime_receipts(&state).expect("read receipts");

        assert_eq!(receipts, vec![receipt]);
        for forbidden in [
            "raw_stdout",
            "raw_stderr",
            "terminal_stream",
            "shell_trace",
            "environment",
            "credential",
        ] {
            assert!(!json.contains(forbidden), "receipt leaked {forbidden}");
        }
    }
}
