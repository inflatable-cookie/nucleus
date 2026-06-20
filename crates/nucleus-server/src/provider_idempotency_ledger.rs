//! Provider idempotency ledger records.
//!
//! These records reconcile durable provider effects across restart or
//! reconnect. They do not execute duplicate writes, retain raw provider
//! material, or grant client/task mutation authority.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerStateService;

const PROVIDER_IDEMPOTENCY_LEDGER_PREFIX: &str = "provider-idempotency-ledger:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderIdempotencyLedgerInput {
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub invocation_id: Option<String>,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub outcome_id: Option<String>,
    pub receipt_id: Option<String>,
    pub existing_write_attempt_ids: Vec<String>,
    pub existing_idempotency_keys: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub client_mutation_requested: bool,
    pub provider_write_requested: bool,
    pub raw_provider_material_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderIdempotencyLedgerRecord {
    pub ledger_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub invocation_id: Option<String>,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub outcome_id: Option<String>,
    pub receipt_id: Option<String>,
    pub status: ProviderIdempotencyLedgerStatus,
    pub evidence_refs: Vec<String>,
    pub duplicate_write_attempt_detected: bool,
    pub duplicate_idempotency_key_detected: bool,
    pub provider_write_permitted: bool,
    pub duplicate_provider_write_permitted: bool,
    pub reconciliation_record_returned: bool,
    pub client_mutation_authority_granted: bool,
    pub raw_provider_material_retained: bool,
    pub task_mutation_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderIdempotencyLedgerStatus {
    AcceptedForFirstWrite,
    DuplicateWriteAttemptReconciled,
    DuplicateIdempotencyKeyReconciled,
    Blocked(String),
}

pub fn persist_provider_idempotency_ledger<B>(
    state: &ServerStateService<B>,
    input: ProviderIdempotencyLedgerInput,
) -> LocalStoreResult<ProviderIdempotencyLedgerRecord>
where
    B: LocalStoreBackend,
{
    validate_input(&input)?;
    let record = ledger_record_from_input(input);

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.ledger_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.ledger_id)),
            payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

pub fn read_provider_idempotency_ledger_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ProviderIdempotencyLedgerRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(PROVIDER_IDEMPOTENCY_LEDGER_PREFIX))
        .map(|record| {
            serde_json::from_slice::<ProviderIdempotencyLedgerRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.ledger_id.cmp(&right.ledger_id));
    Ok(records)
}

fn validate_input(input: &ProviderIdempotencyLedgerInput) -> LocalStoreResult<()> {
    if input.command_id.trim().is_empty()
        || input.dispatch_attempt_id.trim().is_empty()
        || input.write_attempt_id.trim().is_empty()
        || input.idempotency_key.trim().is_empty()
        || input.evidence_refs.is_empty()
    {
        return invalid(
            "provider idempotency ledger requires command, dispatch, write, key, and evidence refs",
        );
    }
    if input
        .evidence_refs
        .iter()
        .chain(input.existing_write_attempt_ids.iter())
        .chain(input.existing_idempotency_keys.iter())
        .any(|value| value.trim().is_empty())
    {
        return invalid("provider idempotency ledger refs cannot be empty");
    }
    if input.client_mutation_requested
        || input.provider_write_requested
        || input.raw_provider_material_requested
        || input.task_mutation_requested
    {
        return invalid("provider idempotency ledger cannot request execution, raw material, or mutation authority");
    }

    Ok(())
}

fn ledger_record_from_input(
    input: ProviderIdempotencyLedgerInput,
) -> ProviderIdempotencyLedgerRecord {
    let duplicate_write_attempt = input
        .existing_write_attempt_ids
        .contains(&input.write_attempt_id);
    let duplicate_idempotency_key = input
        .existing_idempotency_keys
        .contains(&input.idempotency_key);
    let status = if duplicate_write_attempt {
        ProviderIdempotencyLedgerStatus::DuplicateWriteAttemptReconciled
    } else if duplicate_idempotency_key {
        ProviderIdempotencyLedgerStatus::DuplicateIdempotencyKeyReconciled
    } else {
        ProviderIdempotencyLedgerStatus::AcceptedForFirstWrite
    };

    ProviderIdempotencyLedgerRecord {
        ledger_id: format!(
            "{}{}:{}",
            PROVIDER_IDEMPOTENCY_LEDGER_PREFIX, input.command_id, input.write_attempt_id
        ),
        command_id: input.command_id,
        dispatch_attempt_id: input.dispatch_attempt_id,
        invocation_id: input.invocation_id,
        write_attempt_id: input.write_attempt_id,
        idempotency_key: input.idempotency_key,
        outcome_id: input.outcome_id,
        receipt_id: input.receipt_id,
        status,
        evidence_refs: unique_sorted(input.evidence_refs),
        duplicate_write_attempt_detected: duplicate_write_attempt,
        duplicate_idempotency_key_detected: duplicate_idempotency_key,
        provider_write_permitted: false,
        duplicate_provider_write_permitted: false,
        reconciliation_record_returned: duplicate_write_attempt || duplicate_idempotency_key,
        client_mutation_authority_granted: false,
        raw_provider_material_retained: false,
        task_mutation_permitted: false,
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn invalid<T>(reason: impl Into<String>) -> LocalStoreResult<T> {
    Err(LocalStoreError::InvalidRecord {
        reason: reason.into(),
    })
}

fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ServerStateService;
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn provider_idempotency_ledger_survives_reopen() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));
        let persisted = persist_provider_idempotency_ledger(&state, input()).expect("persist");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records = read_provider_idempotency_ledger_records(&reopened).expect("read");

        assert_eq!(records, vec![persisted]);
        assert_eq!(
            records[0].status,
            ProviderIdempotencyLedgerStatus::AcceptedForFirstWrite
        );
        assert!(!records[0].provider_write_permitted);
        assert!(!records[0].client_mutation_authority_granted);
    }

    #[test]
    fn provider_idempotency_ledger_detects_duplicate_write_attempts() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input();
        input.existing_write_attempt_ids = vec!["write:1".to_owned()];

        let record = persist_provider_idempotency_ledger(&state, input).expect("persist");

        assert_eq!(
            record.status,
            ProviderIdempotencyLedgerStatus::DuplicateWriteAttemptReconciled
        );
        assert!(record.duplicate_write_attempt_detected);
        assert!(record.reconciliation_record_returned);
        assert!(!record.duplicate_provider_write_permitted);
    }

    #[test]
    fn provider_idempotency_ledger_reconciles_replayed_commands_without_write() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input();
        input.existing_idempotency_keys = vec!["idempotency:1".to_owned()];

        let record = persist_provider_idempotency_ledger(&state, input).expect("persist");

        assert_eq!(
            record.status,
            ProviderIdempotencyLedgerStatus::DuplicateIdempotencyKeyReconciled
        );
        assert!(record.duplicate_idempotency_key_detected);
        assert!(!record.provider_write_permitted);
    }

    #[test]
    fn provider_idempotency_ledger_blocks_mutation_and_raw_requests() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input();
        input.provider_write_requested = true;
        input.raw_provider_material_requested = true;

        let error = persist_provider_idempotency_ledger(&state, input).expect_err("blocked");

        assert!(matches!(error, LocalStoreError::InvalidRecord { .. }));
        assert!(read_provider_idempotency_ledger_records(&state)
            .expect("read")
            .is_empty());
    }

    fn input() -> ProviderIdempotencyLedgerInput {
        ProviderIdempotencyLedgerInput {
            command_id: "command:1".to_owned(),
            dispatch_attempt_id: "dispatch:1".to_owned(),
            invocation_id: Some("invocation:1".to_owned()),
            write_attempt_id: "write:1".to_owned(),
            idempotency_key: "idempotency:1".to_owned(),
            outcome_id: Some("outcome:1".to_owned()),
            receipt_id: Some("receipt:1".to_owned()),
            existing_write_attempt_ids: Vec::new(),
            existing_idempotency_keys: Vec::new(),
            evidence_refs: vec!["evidence:ledger:1".to_owned()],
            client_mutation_requested: false,
            provider_write_requested: false,
            raw_provider_material_requested: false,
            task_mutation_requested: false,
        }
    }
}
