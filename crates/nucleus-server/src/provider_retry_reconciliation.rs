//! Provider retry reconciliation records.
//!
//! These records decide whether a provider effect may be retried, reconciled,
//! or repaired. They do not perform retries, execute provider writes, retain
//! raw provider material, or mutate tasks.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerStateService;

const PROVIDER_RETRY_RECONCILIATION_PREFIX: &str = "provider-retry-reconciliation:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRetryReconciliationInput {
    pub original_command_id: String,
    pub original_write_attempt_id: String,
    pub original_outcome_id: Option<String>,
    pub original_receipt_id: Option<String>,
    pub retry_attempt_id: String,
    pub retry_idempotency_key: String,
    pub latest_status: ProviderRetryObservedStatus,
    pub repair_evidence_refs: Vec<String>,
    pub retry_requested: bool,
    pub operator_retry_authority: bool,
    pub duplicate_write_detected: bool,
    pub raw_provider_material_requested: bool,
    pub task_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRetryObservedStatus {
    Failed,
    TimedOut,
    Completed,
    CleanupRequired,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderRetryReconciliationRecord {
    pub reconciliation_id: String,
    pub original_command_id: String,
    pub original_write_attempt_id: String,
    pub original_outcome_id: Option<String>,
    pub original_receipt_id: Option<String>,
    pub retry_attempt_id: String,
    pub retry_idempotency_key: String,
    pub latest_status: ProviderRetryObservedStatus,
    pub decision: ProviderRetryReconciliationDecision,
    pub evidence_refs: Vec<String>,
    pub retry_permitted: bool,
    pub retry_executed: bool,
    pub completed_effect_reconciled: bool,
    pub manual_repair_required: bool,
    pub raw_provider_material_retained: bool,
    pub task_mutation_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRetryReconciliationDecision {
    SafeRetryAvailable,
    UnsafeRetryBlocked(String),
    AlreadyCompleted,
    ManualRepairRequired(String),
}

pub fn persist_provider_retry_reconciliation<B>(
    state: &ServerStateService<B>,
    input: ProviderRetryReconciliationInput,
) -> LocalStoreResult<ProviderRetryReconciliationRecord>
where
    B: LocalStoreBackend,
{
    validate_input(&input)?;
    let record = reconciliation_record_from_input(input);

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.reconciliation_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.reconciliation_id)),
            payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

pub fn read_provider_retry_reconciliation_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<ProviderRetryReconciliationRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| {
            record
                .id
                .0
                .starts_with(PROVIDER_RETRY_RECONCILIATION_PREFIX)
        })
        .map(|record| {
            serde_json::from_slice::<ProviderRetryReconciliationRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.reconciliation_id.cmp(&right.reconciliation_id));
    Ok(records)
}

fn validate_input(input: &ProviderRetryReconciliationInput) -> LocalStoreResult<()> {
    if input.original_command_id.trim().is_empty()
        || input.original_write_attempt_id.trim().is_empty()
        || input.retry_attempt_id.trim().is_empty()
        || input.retry_idempotency_key.trim().is_empty()
        || input.repair_evidence_refs.is_empty()
    {
        return invalid(
            "provider retry reconciliation requires original refs, retry refs, and repair evidence",
        );
    }
    if input
        .repair_evidence_refs
        .iter()
        .any(|value| value.trim().is_empty())
    {
        return invalid("provider retry reconciliation evidence refs cannot be empty");
    }
    if input.raw_provider_material_requested || input.task_mutation_requested {
        return invalid(
            "provider retry reconciliation cannot request raw material or task mutation",
        );
    }

    Ok(())
}

fn reconciliation_record_from_input(
    input: ProviderRetryReconciliationInput,
) -> ProviderRetryReconciliationRecord {
    let decision = decision(&input);
    let retry_permitted = matches!(
        decision,
        ProviderRetryReconciliationDecision::SafeRetryAvailable
    );
    let completed_effect_reconciled = matches!(
        decision,
        ProviderRetryReconciliationDecision::AlreadyCompleted
    );
    let manual_repair_required = matches!(
        decision,
        ProviderRetryReconciliationDecision::ManualRepairRequired(_)
    );

    ProviderRetryReconciliationRecord {
        reconciliation_id: format!(
            "{}{}:{}",
            PROVIDER_RETRY_RECONCILIATION_PREFIX,
            input.original_write_attempt_id,
            input.retry_attempt_id
        ),
        original_command_id: input.original_command_id,
        original_write_attempt_id: input.original_write_attempt_id,
        original_outcome_id: input.original_outcome_id,
        original_receipt_id: input.original_receipt_id,
        retry_attempt_id: input.retry_attempt_id,
        retry_idempotency_key: input.retry_idempotency_key,
        latest_status: input.latest_status,
        decision,
        evidence_refs: unique_sorted(input.repair_evidence_refs),
        retry_permitted,
        retry_executed: false,
        completed_effect_reconciled,
        manual_repair_required,
        raw_provider_material_retained: false,
        task_mutation_permitted: false,
    }
}

fn decision(input: &ProviderRetryReconciliationInput) -> ProviderRetryReconciliationDecision {
    if matches!(input.latest_status, ProviderRetryObservedStatus::Completed) {
        return ProviderRetryReconciliationDecision::AlreadyCompleted;
    }
    if input.duplicate_write_detected {
        return ProviderRetryReconciliationDecision::UnsafeRetryBlocked(
            "duplicate write attempt detected".to_owned(),
        );
    }
    if matches!(
        input.latest_status,
        ProviderRetryObservedStatus::CleanupRequired | ProviderRetryObservedStatus::Unknown
    ) {
        return ProviderRetryReconciliationDecision::ManualRepairRequired(
            "provider state is uncertain".to_owned(),
        );
    }
    if input.retry_requested && input.operator_retry_authority {
        ProviderRetryReconciliationDecision::SafeRetryAvailable
    } else {
        ProviderRetryReconciliationDecision::UnsafeRetryBlocked(
            "retry requires explicit operator authority".to_owned(),
        )
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
    fn provider_retry_reconciliation_records_safe_retry_without_execution() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let record = persist_provider_retry_reconciliation(&state, input()).expect("persist");

        assert_eq!(
            record.decision,
            ProviderRetryReconciliationDecision::SafeRetryAvailable
        );
        assert!(record.retry_permitted);
        assert!(!record.retry_executed);
        assert!(!record.task_mutation_permitted);
    }

    #[test]
    fn provider_retry_reconciliation_blocks_unsafe_retry() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input();
        input.operator_retry_authority = false;

        let record = persist_provider_retry_reconciliation(&state, input).expect("persist");

        assert!(matches!(
            record.decision,
            ProviderRetryReconciliationDecision::UnsafeRetryBlocked(_)
        ));
        assert!(!record.retry_permitted);
    }

    #[test]
    fn provider_retry_reconciliation_reconciles_completed_effects_after_reopen() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));
        let mut input = input();
        input.latest_status = ProviderRetryObservedStatus::Completed;
        let persisted = persist_provider_retry_reconciliation(&state, input).expect("persist");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records = read_provider_retry_reconciliation_records(&reopened).expect("read");

        assert_eq!(records, vec![persisted]);
        assert!(records[0].completed_effect_reconciled);
        assert!(!records[0].retry_permitted);
    }

    #[test]
    fn provider_retry_reconciliation_records_manual_repair_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input();
        input.latest_status = ProviderRetryObservedStatus::Unknown;

        let record = persist_provider_retry_reconciliation(&state, input).expect("persist");

        assert!(record.manual_repair_required);
        assert!(matches!(
            record.decision,
            ProviderRetryReconciliationDecision::ManualRepairRequired(_)
        ));
    }

    fn input() -> ProviderRetryReconciliationInput {
        ProviderRetryReconciliationInput {
            original_command_id: "command:1".to_owned(),
            original_write_attempt_id: "write:1".to_owned(),
            original_outcome_id: Some("outcome:1".to_owned()),
            original_receipt_id: Some("receipt:1".to_owned()),
            retry_attempt_id: "retry:1".to_owned(),
            retry_idempotency_key: "retry-key:1".to_owned(),
            latest_status: ProviderRetryObservedStatus::Failed,
            repair_evidence_refs: vec!["evidence:retry:1".to_owned()],
            retry_requested: true,
            operator_retry_authority: true,
            duplicate_write_detected: false,
            raw_provider_material_requested: false,
            task_mutation_requested: false,
        }
    }
}
