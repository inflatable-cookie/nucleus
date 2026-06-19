//! Codex live executor outcome persistence.
//!
//! This module stores sanitized live executor outcome metadata and runtime
//! receipts. It does not retain raw provider material, replay provider writes,
//! answer callbacks, cancel turns, resume sessions, or mutate task state.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use nucleus_orchestration::{
    encode_orchestration_event_store_record, EventStreamRef, OrchestrationCommandId,
    OrchestrationEventId, OrchestrationEventRecord, OrchestrationEventStoreRecord,
};

use crate::runtime_receipt_state::write_runtime_receipt;
use crate::state::ServerStateService;

use super::live_executor_outcome::{
    validate_codex_live_executor_outcome_record, CodexAppServerLiveExecutorOutcomeRecord,
    CodexAppServerLiveExecutorOutcomeStatus,
};

const LIVE_EXECUTOR_OUTCOME_PREFIX: &str = "codex-live-executor-outcome:";

/// Input for persisting one sanitized Codex live executor outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveExecutorOutcomePersistenceInput {
    pub outcome: CodexAppServerLiveExecutorOutcomeRecord,
}

/// Persistence refs produced for one Codex live executor outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerLiveExecutorOutcomePersistenceRecord {
    pub outcome_id: String,
    pub write_attempt_id: String,
    pub receipt_id: EngineRuntimeReceiptRecordId,
    pub event_id: Option<OrchestrationEventId>,
    pub replay_policy: CodexAppServerLiveExecutorOutcomeReplayPolicy,
    pub provider_write_executed: bool,
    pub raw_payload_persisted: bool,
    pub raw_stream_persisted: bool,
    pub task_mutation_permitted: bool,
}

/// Replay posture for live executor outcomes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerLiveExecutorOutcomeReplayPolicy {
    InspectOnly,
}

/// Persist one sanitized live executor outcome and its runtime receipt.
pub fn persist_codex_live_executor_outcome<B>(
    state: &ServerStateService<B>,
    input: CodexAppServerLiveExecutorOutcomePersistenceInput,
) -> LocalStoreResult<CodexAppServerLiveExecutorOutcomePersistenceRecord>
where
    B: LocalStoreBackend,
{
    validate_outcome_for_persistence(&input.outcome)?;

    let receipt = receipt_from_live_executor_outcome(&input.outcome);
    let event = event_from_live_executor_outcome(&input.outcome);
    let record = persistence_record_from_parts(&input.outcome, &receipt.receipt_id, &event);

    write_live_executor_outcome_metadata(state, &input.outcome)?;
    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::MustNotExist,
    )?;

    if let Some(event) = &event {
        write_live_executor_event(state, event)?;
    }

    Ok(record)
}

/// Read persisted Codex live executor outcome records from server state.
pub fn read_codex_live_executor_outcome_records<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CodexAppServerLiveExecutorOutcomeRecord>>
where
    B: LocalStoreBackend,
{
    state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(LIVE_EXECUTOR_OUTCOME_PREFIX))
        .map(|record| decode_live_executor_outcome_record(&record.payload.bytes))
        .collect()
}

fn write_live_executor_outcome_metadata<B>(
    state: &ServerStateService<B>,
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(persistence_id(outcome)),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!("rev:{}", persistence_id(outcome))),
            payload: json_payload(encode_live_executor_outcome_record(outcome)?),
        },
        RevisionExpectation::MustNotExist,
    )
}

fn write_live_executor_event<B>(
    state: &ServerStateService<B>,
    event: &OrchestrationEventStoreRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let payload = encode_orchestration_event_store_record(event).map_err(json_error)?;

    state.event_journal().put(
        LocalStoreRecord {
            id: PersistenceRecordId(event.event_id.0.clone()),
            domain: PersistenceDomain::EventJournal,
            kind: PersistenceRecordKind::Event,
            revision_id: RevisionId(format!("rev:{}", event.event_id.0)),
            payload: json_payload(payload),
        },
        RevisionExpectation::MustNotExist,
    )
}

fn receipt_from_live_executor_outcome(
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
) -> EngineRuntimeReceiptRecord {
    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:codex-live-executor:{}",
            outcome.write_attempt_id
        )),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: receipt_status(&outcome.status),
        command_ref: Some(EngineRuntimeReceiptRef::Custom(
            outcome.write_attempt_id.clone(),
        )),
        effect_ref: outcome
            .turn_id
            .as_ref()
            .map(|turn_id| EngineRuntimeReceiptRef::Custom(turn_id.clone())),
        evidence_refs: receipt_evidence_refs(outcome),
        artifact_refs: Vec::new(),
        summary: Some(receipt_summary(outcome)),
    }
}

fn event_from_live_executor_outcome(
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
) -> Option<OrchestrationEventStoreRecord> {
    if !matches!(
        outcome.status,
        CodexAppServerLiveExecutorOutcomeStatus::Accepted
            | CodexAppServerLiveExecutorOutcomeStatus::Completed
    ) {
        return None;
    }

    let payload = OrchestrationEventRecord::runtime_observation_accepted(
        OrchestrationEventId(format!(
            "event:codex-live-executor:{}",
            outcome.write_attempt_id
        )),
        OrchestrationCommandId(format!(
            "command:codex-live-executor:{}",
            outcome.write_attempt_id
        )),
        Some(outcome.provider_instance_id.clone()),
    );

    Some(OrchestrationEventStoreRecord::from_event(
        EventStreamRef(format!(
            "stream:codex-live-executor:{}",
            outcome.provider_instance_id
        )),
        payload,
    ))
}

fn persistence_record_from_parts(
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
    receipt_id: &EngineRuntimeReceiptRecordId,
    event: &Option<OrchestrationEventStoreRecord>,
) -> CodexAppServerLiveExecutorOutcomePersistenceRecord {
    CodexAppServerLiveExecutorOutcomePersistenceRecord {
        outcome_id: outcome.outcome_id.0.clone(),
        write_attempt_id: outcome.write_attempt_id.clone(),
        receipt_id: receipt_id.clone(),
        event_id: event.as_ref().map(|event| event.event_id.clone()),
        replay_policy: CodexAppServerLiveExecutorOutcomeReplayPolicy::InspectOnly,
        provider_write_executed: outcome.provider_write_executed,
        raw_payload_persisted: false,
        raw_stream_persisted: false,
        task_mutation_permitted: false,
    }
}

fn receipt_status(status: &CodexAppServerLiveExecutorOutcomeStatus) -> EngineRuntimeReceiptStatus {
    match status {
        CodexAppServerLiveExecutorOutcomeStatus::Accepted => EngineRuntimeReceiptStatus::Accepted,
        CodexAppServerLiveExecutorOutcomeStatus::Completed => EngineRuntimeReceiptStatus::Completed,
        CodexAppServerLiveExecutorOutcomeStatus::Failed(_) => EngineRuntimeReceiptStatus::Failed,
        CodexAppServerLiveExecutorOutcomeStatus::TimedOut => EngineRuntimeReceiptStatus::TimedOut,
        CodexAppServerLiveExecutorOutcomeStatus::Blocked(_) => EngineRuntimeReceiptStatus::Blocked,
        CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(_) => {
            EngineRuntimeReceiptStatus::RecoveryRequired
        }
    }
}

fn receipt_evidence_refs(
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
) -> Vec<EngineRuntimeReceiptRef> {
    outcome
        .evidence_refs
        .iter()
        .chain(outcome.receipt_refs.iter())
        .map(|value| EngineRuntimeReceiptRef::Custom(value.clone()))
        .collect()
}

fn receipt_summary(outcome: &CodexAppServerLiveExecutorOutcomeRecord) -> String {
    format!(
        "Codex live executor {:?}: provider_write_executed={}, notifications={}, server_requests={}, cleanup={:?}",
        outcome.status,
        outcome.provider_write_executed,
        outcome.notification_count,
        outcome.server_request_count,
        outcome.cleanup_status
    )
}

fn validate_outcome_for_persistence(
    outcome: &CodexAppServerLiveExecutorOutcomeRecord,
) -> LocalStoreResult<()> {
    validate_codex_live_executor_outcome_record(outcome).map_err(|errors| {
        LocalStoreError::InvalidRecord {
            reason: format!("invalid Codex live executor outcome: {errors:?}"),
        }
    })
}

fn encode_live_executor_outcome_record(
    record: &CodexAppServerLiveExecutorOutcomeRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(record).map_err(json_error)
}

fn decode_live_executor_outcome_record(
    bytes: &[u8],
) -> LocalStoreResult<CodexAppServerLiveExecutorOutcomeRecord> {
    serde_json::from_slice(bytes).map_err(json_error)
}

fn persistence_id(outcome: &CodexAppServerLiveExecutorOutcomeRecord) -> String {
    format!(
        "{}{}",
        LIVE_EXECUTOR_OUTCOME_PREFIX, outcome.write_attempt_id
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
mod tests;
