//! Durable provider executor command persistence.
//!
//! This module stores sanitized provider executor command intent. It does not
//! dispatch commands, write to provider transports, retain raw provider
//! material, or mutate task state.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};

use crate::provider_durable_executor_command::{
    DurableProviderExecutorCommandRecord, DurableProviderExecutorCommandStatus,
};
use crate::state::ServerStateService;

const DURABLE_EXECUTOR_COMMAND_PREFIX: &str = "durable-provider-executor-command:";

/// Input for persisting one durable provider executor command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableProviderExecutorCommandPersistenceInput {
    pub command: DurableProviderExecutorCommandRecord,
}

/// Persistence refs produced for one durable provider executor command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableProviderExecutorCommandPersistenceRecord {
    pub command_id: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub persisted_record_id: PersistenceRecordId,
    pub provider_write_executed: bool,
    pub raw_provider_material_persisted: bool,
    pub raw_callback_material_persisted: bool,
    pub task_mutation_permitted: bool,
}

/// Persist one accepted durable provider executor command.
pub fn persist_durable_provider_executor_command<B>(
    state: &ServerStateService<B>,
    input: DurableProviderExecutorCommandPersistenceInput,
) -> LocalStoreResult<DurableProviderExecutorCommandPersistenceRecord>
where
    B: LocalStoreBackend,
{
    validate_command_for_persistence(state, &input.command)?;

    let persisted_record_id = PersistenceRecordId(persistence_id(&input.command));
    state.command_evidence().put(
        LocalStoreRecord {
            id: persisted_record_id.clone(),
            domain: PersistenceDomain::CommandEvidence,
            kind: PersistenceRecordKind::CommandEvidence,
            revision_id: RevisionId(format!("rev:{}", persisted_record_id.0)),
            payload: json_payload(encode_command_record(&input.command)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(DurableProviderExecutorCommandPersistenceRecord {
        command_id: input.command.command_id.0,
        write_attempt_id: input.command.write_attempt_id,
        idempotency_key: input.command.idempotency_key,
        persisted_record_id,
        provider_write_executed: false,
        raw_provider_material_persisted: false,
        raw_callback_material_persisted: false,
        task_mutation_permitted: false,
    })
}

/// Read persisted durable provider executor command records.
pub fn read_durable_provider_executor_command_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<DurableProviderExecutorCommandRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .command_evidence()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(DURABLE_EXECUTOR_COMMAND_PREFIX))
        .map(|record| decode_command_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.command_id.0.cmp(&right.command_id.0));
    Ok(records)
}

fn validate_command_for_persistence<B>(
    state: &ServerStateService<B>,
    command: &DurableProviderExecutorCommandRecord,
) -> LocalStoreResult<()>
where
    B: LocalStoreBackend,
{
    if command.status != DurableProviderExecutorCommandStatus::AcceptedForPersistence {
        return Err(LocalStoreError::InvalidRecord {
            reason: "durable provider executor command is not accepted for persistence".to_owned(),
        });
    }
    if !command.blockers.is_empty() {
        return Err(LocalStoreError::InvalidRecord {
            reason: format!(
                "durable provider executor command has blockers: {:?}",
                command.blockers
            ),
        });
    }
    if command.provider_write_executed
        || command.executor_invoked
        || command.client_authority_granted
        || command.raw_provider_material_retained
        || command.raw_callback_material_retained
        || command.task_mutation_permitted
        || command.review_acceptance_permitted
        || command.callback_answer_permitted
        || command.interruption_permitted
        || command.recovery_permitted
        || command.replacement_thread_promotion_permitted
        || command.scm_mutation_permitted
    {
        return Err(LocalStoreError::InvalidRecord {
            reason: "durable provider executor command contains forbidden authority".to_owned(),
        });
    }
    if read_durable_provider_executor_command_records(state)?
        .iter()
        .any(|record| record.write_attempt_id == command.write_attempt_id)
    {
        return Err(LocalStoreError::InvalidRecord {
            reason: format!(
                "duplicate durable provider executor write attempt id: {}",
                command.write_attempt_id
            ),
        });
    }

    Ok(())
}

fn encode_command_record(
    record: &DurableProviderExecutorCommandRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(record).map_err(json_error)
}

fn decode_command_record(bytes: &[u8]) -> LocalStoreResult<DurableProviderExecutorCommandRecord> {
    serde_json::from_slice(bytes).map_err(json_error)
}

fn persistence_id(command: &DurableProviderExecutorCommandRecord) -> String {
    format!(
        "{}{}",
        DURABLE_EXECUTOR_COMMAND_PREFIX, command.command_id.0
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        durable_provider_executor_command, DurableProviderExecutorCommandId,
        DurableProviderExecutorCommandInput, DurableProviderExecutorLane,
        DurableProviderExecutorMethod, ServerStateService,
    };
    use nucleus_local_store::SqliteBackend;

    fn command(command_id: &str, write_attempt_id: &str) -> DurableProviderExecutorCommandRecord {
        durable_provider_executor_command(DurableProviderExecutorCommandInput {
            command_id: DurableProviderExecutorCommandId(command_id.to_owned()),
            lane: DurableProviderExecutorLane::TaskBackedTurnStart,
            lane_admission_id: "task-work-live-executor-admission:1".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            runtime_session_ref: "runtime-session:1".to_owned(),
            write_attempt_id: write_attempt_id.to_owned(),
            idempotency_key: format!("idempotency:{write_attempt_id}"),
            task_id: Some("task:1".to_owned()),
            work_item_id: Some("work:1".to_owned()),
            method: DurableProviderExecutorMethod::TurnStart,
            evidence_refs: vec!["evidence:durable-command:1".to_owned()],
            operator_confirmation_ref: Some("operator-confirmation:1".to_owned()),
            client_authority_requested: false,
            invoke_executor_requested: false,
            raw_provider_material_requested: false,
            raw_callback_material_requested: false,
            task_mutation_requested: false,
            review_acceptance_requested: false,
            callback_answer_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            replacement_thread_promotion_requested: false,
            scm_mutation_requested: false,
        })
    }

    #[test]
    fn durable_provider_executor_command_persistence_survives_reopen() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));
        let command = command(
            "durable-provider-executor-command:1",
            "provider-transport-write:1",
        );

        let persisted = persist_durable_provider_executor_command(
            &state,
            DurableProviderExecutorCommandPersistenceInput {
                command: command.clone(),
            },
        )
        .expect("persist command");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records =
            read_durable_provider_executor_command_records(&reopened).expect("read commands");

        assert_eq!(records, vec![command]);
        assert_eq!(
            persisted.persisted_record_id.0,
            "durable-provider-executor-command:durable-provider-executor-command:1"
        );
        assert!(!persisted.provider_write_executed);
        assert!(!persisted.raw_provider_material_persisted);
        assert!(!persisted.raw_callback_material_persisted);
        assert!(!persisted.task_mutation_permitted);
    }

    #[test]
    fn durable_provider_executor_command_persistence_rejects_duplicate_command_id() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let command = command(
            "durable-provider-executor-command:1",
            "provider-transport-write:1",
        );

        persist_durable_provider_executor_command(
            &state,
            DurableProviderExecutorCommandPersistenceInput {
                command: command.clone(),
            },
        )
        .expect("first persist");
        let duplicate = persist_durable_provider_executor_command(
            &state,
            DurableProviderExecutorCommandPersistenceInput { command },
        );

        assert!(duplicate.is_err());
        assert_eq!(
            read_durable_provider_executor_command_records(&state)
                .expect("read commands")
                .len(),
            1
        );
    }

    #[test]
    fn durable_provider_executor_command_persistence_rejects_duplicate_write_attempt_id() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

        persist_durable_provider_executor_command(
            &state,
            DurableProviderExecutorCommandPersistenceInput {
                command: command(
                    "durable-provider-executor-command:1",
                    "provider-transport-write:1",
                ),
            },
        )
        .expect("first persist");
        let duplicate = persist_durable_provider_executor_command(
            &state,
            DurableProviderExecutorCommandPersistenceInput {
                command: command(
                    "durable-provider-executor-command:2",
                    "provider-transport-write:1",
                ),
            },
        );

        assert!(matches!(
            duplicate,
            Err(LocalStoreError::InvalidRecord { reason })
                if reason.contains("duplicate durable provider executor write attempt id")
        ));
        assert_eq!(
            read_durable_provider_executor_command_records(&state)
                .expect("read commands")
                .len(),
            1
        );
    }

    #[test]
    fn durable_provider_executor_command_persistence_rejects_blocked_or_authority_widened_records()
    {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let blocked = durable_provider_executor_command(DurableProviderExecutorCommandInput {
            operator_confirmation_ref: None,
            ..command(
                "durable-provider-executor-command:1",
                "provider-transport-write:1",
            )
            .into()
        });
        let mut authority_widened = command(
            "durable-provider-executor-command:2",
            "provider-transport-write:2",
        );
        authority_widened.provider_write_executed = true;

        let blocked_result = persist_durable_provider_executor_command(
            &state,
            DurableProviderExecutorCommandPersistenceInput { command: blocked },
        );
        let authority_result = persist_durable_provider_executor_command(
            &state,
            DurableProviderExecutorCommandPersistenceInput {
                command: authority_widened,
            },
        );

        assert!(blocked_result.is_err());
        assert!(authority_result.is_err());
        assert!(read_durable_provider_executor_command_records(&state)
            .expect("read commands")
            .is_empty());
    }

    #[test]
    fn durable_provider_executor_command_persistence_excludes_raw_provider_material_terms() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

        persist_durable_provider_executor_command(
            &state,
            DurableProviderExecutorCommandPersistenceInput {
                command: command(
                    "durable-provider-executor-command:1",
                    "provider-transport-write:1",
                ),
            },
        )
        .expect("persist command");

        let payloads = state
            .command_evidence()
            .list()
            .expect("command records")
            .into_iter()
            .map(|record| record.payload.bytes)
            .collect::<Vec<_>>();

        for payload in payloads {
            let json = String::from_utf8(payload).expect("json");
            for forbidden in [
                "raw_prompt",
                "raw_response",
                "raw_frame",
                "stdout",
                "stderr",
                "stream_delta",
                "credential",
                "secret",
            ] {
                assert!(
                    !json.contains(forbidden),
                    "persisted payload leaked {forbidden}"
                );
            }
        }
    }

    impl From<DurableProviderExecutorCommandRecord> for DurableProviderExecutorCommandInput {
        fn from(record: DurableProviderExecutorCommandRecord) -> Self {
            Self {
                command_id: record.command_id,
                lane: record.lane,
                lane_admission_id: record.lane_admission_id,
                provider_instance_id: record.provider_instance_id,
                runtime_session_ref: record.runtime_session_ref,
                write_attempt_id: record.write_attempt_id,
                idempotency_key: record.idempotency_key,
                task_id: record.task_id,
                work_item_id: record.work_item_id,
                method: record.method,
                evidence_refs: record.evidence_refs,
                operator_confirmation_ref: record.operator_confirmation_ref,
                client_authority_requested: false,
                invoke_executor_requested: false,
                raw_provider_material_requested: false,
                raw_callback_material_requested: false,
                task_mutation_requested: false,
                review_acceptance_requested: false,
                callback_answer_requested: false,
                interruption_requested: false,
                recovery_requested: false,
                replacement_thread_promotion_requested: false,
                scm_mutation_requested: false,
            }
        }
    }
}
