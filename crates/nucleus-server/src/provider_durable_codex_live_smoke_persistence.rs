//! Durable Codex live-smoke evidence persistence.
//!
//! Persistence stores sanitized smoke evidence and, for first write attempts,
//! an accepted live-executor outcome/receipt. It does not execute provider I/O
//! or retain raw provider material.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::codex_supervision::{
    codex_live_executor_outcome_record, persist_codex_live_executor_outcome,
    CodexAppServerLiveExecutorCleanupStatus, CodexAppServerLiveExecutorMethod,
    CodexAppServerLiveExecutorOutcomeInput, CodexAppServerLiveExecutorOutcomePersistenceInput,
    CodexAppServerLiveExecutorOutcomePersistenceRecord, CodexAppServerLiveExecutorOutcomeStatus,
};
use crate::provider_retention_policy::{
    provider_retention_policy, ProviderRetentionPolicyInput, ProviderRetentionPolicyStatus,
};
use crate::state::ServerStateService;
use crate::{DurableCodexLiveSmokeBoundaryStatus, DurableCodexLiveSmokeDispatchRunRecord};

const DURABLE_CODEX_LIVE_SMOKE_EVIDENCE_PREFIX: &str = "durable-codex-live-smoke-evidence:";

/// Input for durable live-smoke persistence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableCodexLiveSmokeEvidencePersistenceInput {
    pub run: DurableCodexLiveSmokeDispatchRunRecord,
    pub live_outcome: Option<CodexAppServerLiveExecutorOutcomeInput>,
    pub existing_write_attempt_ids: Vec<String>,
    pub persistence_evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub raw_provider_material_present: bool,
    pub raw_stream_present: bool,
    pub secret_material_present: bool,
    pub credential_material_present: bool,
    pub unbounded_local_path_present: bool,
}

/// Persisted durable live-smoke evidence summary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurableCodexLiveSmokeEvidenceRecord {
    pub evidence_id: String,
    pub run_id: String,
    pub boundary_id: String,
    pub command_id: String,
    pub dispatch_attempt_id: String,
    pub handoff_id: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub status: DurableCodexLiveSmokeEvidenceStatus,
    pub retention_status: ProviderRetentionPolicyStatus,
    pub live_executor_outcome_id: Option<String>,
    pub runtime_receipt_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub final_turn_status: Option<String>,
    pub method_sequence_count: usize,
    pub notification_count: usize,
    pub server_request_count: usize,
    pub cleanup_status: CodexAppServerLiveExecutorCleanupStatus,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub duplicate_write_attempt_detected: bool,
    pub provider_write_executed: bool,
    pub executor_invoked: bool,
    pub raw_provider_material_retained: bool,
    pub raw_stream_retained: bool,
    pub task_mutation_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCodexLiveSmokeEvidenceStatus {
    Persisted,
    DuplicateWriteAttemptNoop,
    Blocked(String),
}

/// Persist durable live-smoke evidence and read-only outcome refs.
pub fn persist_durable_codex_live_smoke_evidence<B>(
    state: &ServerStateService<B>,
    input: DurableCodexLiveSmokeEvidencePersistenceInput,
) -> LocalStoreResult<DurableCodexLiveSmokeEvidenceRecord>
where
    B: LocalStoreBackend,
{
    validate_input(&input)?;

    let duplicate_write = input
        .existing_write_attempt_ids
        .contains(&input.run.boundary.write_attempt_id);
    if duplicate_write {
        return Ok(evidence_record(
            input,
            None,
            None,
            true,
            ProviderRetentionPolicyStatus::Blocked,
        ));
    }

    let retention = provider_retention_policy(retention_input(&input));
    if retention.status != ProviderRetentionPolicyStatus::AcceptedReferenceOnly {
        return Ok(evidence_record(input, None, None, false, retention.status));
    }

    let outcome_input = input
        .live_outcome
        .clone()
        .unwrap_or_else(|| live_outcome_input(&input.run));
    let outcome = codex_live_executor_outcome_record(outcome_input);
    let outcome_summary = DurableCodexLiveSmokeOutcomeSummary::from(&outcome);
    let live_persistence = persist_codex_live_executor_outcome(
        state,
        CodexAppServerLiveExecutorOutcomePersistenceInput { outcome },
    )?;
    let record = evidence_record(
        input,
        Some(live_persistence),
        Some(outcome_summary),
        false,
        retention.status,
    );

    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(record.evidence_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", record.evidence_id)),
            payload: json_payload(serde_json::to_vec(&record).map_err(json_error)?),
        },
        RevisionExpectation::MustNotExist,
    )?;

    Ok(record)
}

/// Read durable live-smoke evidence records.
pub fn read_durable_codex_live_smoke_evidence_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<DurableCodexLiveSmokeEvidenceRecord>>
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
                .starts_with(DURABLE_CODEX_LIVE_SMOKE_EVIDENCE_PREFIX)
        })
        .map(|record| {
            serde_json::from_slice::<DurableCodexLiveSmokeEvidenceRecord>(&record.payload.bytes)
                .map_err(json_error)
        })
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.evidence_id.cmp(&right.evidence_id));
    Ok(records)
}

fn validate_input(input: &DurableCodexLiveSmokeEvidencePersistenceInput) -> LocalStoreResult<()> {
    if input.run.run_id.trim().is_empty()
        || input.run.boundary.write_attempt_id.trim().is_empty()
        || input.persistence_evidence_refs.is_empty()
    {
        return invalid(
            "durable live smoke evidence requires run, write attempt, and evidence refs",
        );
    }
    if input
        .persistence_evidence_refs
        .iter()
        .chain(input.artifact_refs.iter())
        .chain(input.existing_write_attempt_ids.iter())
        .any(|value| value.trim().is_empty())
    {
        return invalid("durable live smoke evidence refs cannot be empty");
    }
    if input.run.provider_write_executed
        || input.run.executor_invoked
        || input.run.raw_provider_material_retained
        || input.run.task_mutation_permitted
    {
        return invalid("durable live smoke persistence cannot persist widened authority");
    }
    Ok(())
}

fn evidence_record(
    input: DurableCodexLiveSmokeEvidencePersistenceInput,
    live_persistence: Option<CodexAppServerLiveExecutorOutcomePersistenceRecord>,
    outcome_summary: Option<DurableCodexLiveSmokeOutcomeSummary>,
    duplicate_write: bool,
    retention_status: ProviderRetentionPolicyStatus,
) -> DurableCodexLiveSmokeEvidenceRecord {
    let status = if duplicate_write {
        DurableCodexLiveSmokeEvidenceStatus::DuplicateWriteAttemptNoop
    } else if retention_status != ProviderRetentionPolicyStatus::AcceptedReferenceOnly {
        DurableCodexLiveSmokeEvidenceStatus::Blocked("retention policy blocked".to_owned())
    } else {
        DurableCodexLiveSmokeEvidenceStatus::Persisted
    };
    let mut evidence_refs = input.run.boundary.evidence_refs.clone();
    evidence_refs.extend(input.persistence_evidence_refs);

    DurableCodexLiveSmokeEvidenceRecord {
        evidence_id: format!(
            "{}{}",
            DURABLE_CODEX_LIVE_SMOKE_EVIDENCE_PREFIX, input.run.boundary.write_attempt_id
        ),
        run_id: input.run.run_id,
        boundary_id: input.run.boundary.boundary_id.0,
        command_id: input.run.command.command_id.0,
        dispatch_attempt_id: input.run.dispatch_admission.dispatch_attempt_id,
        handoff_id: input.run.handoff.handoff_id.0,
        provider_instance_id: input.run.boundary.provider_instance_id,
        runtime_session_ref: input.run.boundary.runtime_session_ref,
        write_attempt_id: input.run.boundary.write_attempt_id,
        idempotency_key: input.run.boundary.idempotency_key,
        status,
        retention_status,
        live_executor_outcome_id: live_persistence
            .as_ref()
            .map(|persistence| persistence.outcome_id.clone()),
        runtime_receipt_id: live_persistence
            .as_ref()
            .map(|persistence| persistence.receipt_id.0.clone()),
        thread_id: outcome_summary
            .as_ref()
            .and_then(|summary| summary.thread_id.clone()),
        turn_id: outcome_summary
            .as_ref()
            .and_then(|summary| summary.turn_id.clone()),
        final_turn_status: outcome_summary
            .as_ref()
            .and_then(|summary| summary.final_turn_status.clone()),
        method_sequence_count: outcome_summary
            .as_ref()
            .map(|summary| summary.method_sequence_count)
            .unwrap_or_default(),
        notification_count: outcome_summary
            .as_ref()
            .map(|summary| summary.notification_count)
            .unwrap_or_default(),
        server_request_count: outcome_summary
            .as_ref()
            .map(|summary| summary.server_request_count)
            .unwrap_or_default(),
        cleanup_status: outcome_summary
            .as_ref()
            .map(|summary| summary.cleanup_status.clone())
            .unwrap_or(CodexAppServerLiveExecutorCleanupStatus::Unknown),
        evidence_refs: unique_sorted(evidence_refs),
        artifact_refs: unique_sorted(input.artifact_refs),
        duplicate_write_attempt_detected: duplicate_write,
        provider_write_executed: live_persistence
            .as_ref()
            .map(|persistence| persistence.provider_write_executed)
            .unwrap_or(false),
        executor_invoked: false,
        raw_provider_material_retained: false,
        raw_stream_retained: false,
        task_mutation_permitted: false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DurableCodexLiveSmokeOutcomeSummary {
    thread_id: Option<String>,
    turn_id: Option<String>,
    final_turn_status: Option<String>,
    method_sequence_count: usize,
    notification_count: usize,
    server_request_count: usize,
    cleanup_status: CodexAppServerLiveExecutorCleanupStatus,
}

impl From<&crate::CodexAppServerLiveExecutorOutcomeRecord> for DurableCodexLiveSmokeOutcomeSummary {
    fn from(outcome: &crate::CodexAppServerLiveExecutorOutcomeRecord) -> Self {
        Self {
            thread_id: outcome.thread_id.clone(),
            turn_id: outcome.turn_id.clone(),
            final_turn_status: outcome.final_turn_status.clone(),
            method_sequence_count: outcome.method_sequence.len(),
            notification_count: outcome.notification_count,
            server_request_count: outcome.server_request_count,
            cleanup_status: outcome.cleanup_status.clone(),
        }
    }
}

fn retention_input(
    input: &DurableCodexLiveSmokeEvidencePersistenceInput,
) -> ProviderRetentionPolicyInput {
    ProviderRetentionPolicyInput {
        record_ref: input.run.boundary.boundary_id.0.clone(),
        evidence_refs: input.persistence_evidence_refs.clone(),
        artifact_refs: input.artifact_refs.clone(),
        raw_payload_present: input.raw_provider_material_present,
        raw_stream_present: input.raw_stream_present,
        secret_material_present: input.secret_material_present,
        credential_material_present: input.credential_material_present,
        unbounded_local_path_present: input.unbounded_local_path_present,
        artifact_policy_approved: true,
        diagnostics_requested: true,
    }
}

fn live_outcome_input(
    run: &DurableCodexLiveSmokeDispatchRunRecord,
) -> CodexAppServerLiveExecutorOutcomeInput {
    CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: run.boundary.provider_instance_id.clone(),
        write_attempt_id: run.boundary.write_attempt_id.clone(),
        receipt_refs: vec![format!("receipt:durable-live-smoke:{}", run.run_id)],
        thread_id: None,
        turn_id: None,
        final_turn_status: None,
        status: match run.boundary.status {
            DurableCodexLiveSmokeBoundaryStatus::DryRunEligible
            | DurableCodexLiveSmokeBoundaryStatus::EligibleForExplicitLiveProviderWrite => {
                CodexAppServerLiveExecutorOutcomeStatus::Accepted
            }
            DurableCodexLiveSmokeBoundaryStatus::Blocked => {
                CodexAppServerLiveExecutorOutcomeStatus::Blocked(
                    "durable live smoke boundary blocked".to_owned(),
                )
            }
        },
        method_sequence: vec![CodexAppServerLiveExecutorMethod::TurnStart],
        notification_count: 0,
        server_request_count: 0,
        cleanup_status: CodexAppServerLiveExecutorCleanupStatus::NotRequired,
        evidence_refs: run.boundary.evidence_refs.clone(),
        provider_write_executed: false,
    }
}

fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
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
    use crate::{
        durable_codex_live_smoke_dispatch_run, read_codex_live_executor_outcome_records,
        DurableCodexLiveSmokeDispatchRunInput, DurableCodexLiveSmokeIntent, ServerStateService,
    };
    use nucleus_local_store::SqliteBackend;

    #[test]
    fn durable_codex_live_smoke_persistence_survives_reopen() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db = temp_dir.path().join("nucleus.sqlite");
        let state = ServerStateService::new(SqliteBackend::new(db.clone()));

        let record =
            persist_durable_codex_live_smoke_evidence(&state, input()).expect("persist smoke");

        let reopened = ServerStateService::new(SqliteBackend::new(db));
        let records =
            read_durable_codex_live_smoke_evidence_records(&reopened).expect("read smoke");
        let outcomes = read_codex_live_executor_outcome_records(&reopened).expect("read outcomes");

        assert_eq!(records, vec![record]);
        assert_eq!(outcomes.len(), 1);
        assert!(records[0].runtime_receipt_id.is_some());
        assert_eq!(records[0].method_sequence_count, 1);
        assert!(!records[0].raw_provider_material_retained);
        assert!(!records[0].raw_stream_retained);
    }

    #[test]
    fn durable_codex_live_smoke_persistence_duplicate_write_attempt_is_noop() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input();
        input
            .existing_write_attempt_ids
            .push(input.run.boundary.write_attempt_id.clone());

        let record =
            persist_durable_codex_live_smoke_evidence(&state, input).expect("duplicate noop");
        let records = read_durable_codex_live_smoke_evidence_records(&state).expect("read smoke");

        assert_eq!(
            record.status,
            DurableCodexLiveSmokeEvidenceStatus::DuplicateWriteAttemptNoop
        );
        assert!(record.duplicate_write_attempt_detected);
        assert!(records.is_empty());
        assert!(!record.provider_write_executed);
    }

    #[test]
    fn durable_codex_live_smoke_persistence_blocks_raw_material() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut input = input();
        input.raw_provider_material_present = true;
        input.raw_stream_present = true;

        let record =
            persist_durable_codex_live_smoke_evidence(&state, input).expect("blocked evidence");

        assert!(matches!(
            record.status,
            DurableCodexLiveSmokeEvidenceStatus::Blocked(_)
        ));
        assert_eq!(
            record.retention_status,
            ProviderRetentionPolicyStatus::Blocked
        );
        assert!(record.runtime_receipt_id.is_none());
        assert!(!record.raw_provider_material_retained);
        assert!(!record.raw_stream_retained);
    }

    fn input() -> DurableCodexLiveSmokeEvidencePersistenceInput {
        DurableCodexLiveSmokeEvidencePersistenceInput {
            run: durable_codex_live_smoke_dispatch_run(DurableCodexLiveSmokeDispatchRunInput {
                intent: DurableCodexLiveSmokeIntent::DryRunOnly,
                run_id: "persistence".to_owned(),
                provider_instance_id: "codex:persistence".to_owned(),
                runtime_session_ref: "runtime-session:persistence".to_owned(),
                task_id: "task:persistence".to_owned(),
                work_item_id: "work:persistence".to_owned(),
                operator_confirmation_ref: "operator-confirmation:persistence".to_owned(),
                evidence_refs: vec!["evidence:persistence:command".to_owned()],
            }),
            live_outcome: None,
            existing_write_attempt_ids: Vec::new(),
            persistence_evidence_refs: vec!["evidence:persistence".to_owned()],
            artifact_refs: vec!["artifact:persistence-summary".to_owned()],
            raw_provider_material_present: false,
            raw_stream_present: false,
            secret_material_present: false,
            credential_material_present: false,
            unbounded_local_path_present: false,
        }
    }
}
