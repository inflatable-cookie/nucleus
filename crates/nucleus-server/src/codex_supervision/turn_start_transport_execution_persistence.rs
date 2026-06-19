//! Codex `turn/start` transport execution persistence.
//!
//! This module persists sanitized executor handoff evidence as runtime
//! receipts and runtime-observation events. It does not execute provider
//! writes, retain raw payloads or streams, retry writes, or mutate task state.

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

use super::turn_start_stdio_execution_envelope::{
    CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    CodexAppServerTurnStartStdioExecutionEnvelopeStatus,
};

/// Input for persisting one Codex `turn/start` transport execution handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartTransportExecutionPersistenceInput {
    pub envelope: CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    pub result: CodexAppServerTurnStartTransportExecutionResult,
}

/// Sanitized transport execution result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartTransportExecutionResult {
    AcceptedForExecutor,
    Blocked(String),
    Failed(String),
    Skipped(String),
}

/// Replay posture for a persisted transport execution attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartTransportExecutionReplayPolicy {
    InspectOnly,
}

/// Persistence refs produced for one transport execution handoff.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartTransportExecutionPersistenceRecord {
    pub execution_id: String,
    pub write_attempt_id: String,
    pub idempotency_key: String,
    pub receipt_id: EngineRuntimeReceiptRecordId,
    pub event_id: Option<OrchestrationEventId>,
    pub replay_policy: CodexAppServerTurnStartTransportExecutionReplayPolicy,
    pub provider_write_executed: bool,
    pub raw_payload_persisted: bool,
    pub raw_stream_persisted: bool,
    pub task_mutation_permitted: bool,
}

/// Persist sanitized transport execution evidence without provider I/O.
pub fn persist_codex_turn_start_transport_execution<B>(
    state: &ServerStateService<B>,
    input: CodexAppServerTurnStartTransportExecutionPersistenceInput,
) -> LocalStoreResult<CodexAppServerTurnStartTransportExecutionPersistenceRecord>
where
    B: LocalStoreBackend,
{
    let receipt = receipt_from_transport_execution(&input);
    let event = event_from_transport_execution(&input);

    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::MustNotExist,
    )?;

    if let Some(event) = &event {
        write_transport_execution_event(state, event)?;
    }

    Ok(CodexAppServerTurnStartTransportExecutionPersistenceRecord {
        execution_id: execution_id(&input.envelope),
        write_attempt_id: input.envelope.write_attempt_id,
        idempotency_key: input.envelope.idempotency_key,
        receipt_id: receipt.receipt_id,
        event_id: event.map(|event| event.event_id),
        replay_policy: CodexAppServerTurnStartTransportExecutionReplayPolicy::InspectOnly,
        provider_write_executed: false,
        raw_payload_persisted: false,
        raw_stream_persisted: false,
        task_mutation_permitted: false,
    })
}

fn receipt_from_transport_execution(
    input: &CodexAppServerTurnStartTransportExecutionPersistenceInput,
) -> EngineRuntimeReceiptRecord {
    let envelope = &input.envelope;
    let mut evidence_refs: Vec<EngineRuntimeReceiptRef> = envelope
        .evidence_refs
        .iter()
        .map(|value| EngineRuntimeReceiptRef::Custom(value.clone()))
        .collect();
    evidence_refs.extend([
        EngineRuntimeReceiptRef::Custom(format!("authority:{}", envelope.authority_id)),
        EngineRuntimeReceiptRef::Custom(format!("preflight:{}", envelope.preflight_id)),
        EngineRuntimeReceiptRef::Custom(format!("idempotency:{}", envelope.idempotency_key)),
    ]);

    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:codex-turn-start-transport-execution:{}",
            envelope.write_attempt_id
        )),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status: receipt_status(input),
        command_ref: Some(EngineRuntimeReceiptRef::Custom(
            envelope.send_command_id.clone(),
        )),
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(
            envelope.write_attempt_id.clone(),
        )),
        evidence_refs,
        artifact_refs: vec![EngineRuntimeReceiptRef::EventId(
            envelope.event_id.0.clone(),
        )],
        summary: Some(summary(input)),
    }
}

fn event_from_transport_execution(
    input: &CodexAppServerTurnStartTransportExecutionPersistenceInput,
) -> Option<OrchestrationEventStoreRecord> {
    if matches!(
        input.result,
        CodexAppServerTurnStartTransportExecutionResult::Skipped(_)
    ) {
        return None;
    }

    let envelope = &input.envelope;
    let payload = OrchestrationEventRecord::runtime_observation_accepted(
        OrchestrationEventId(format!(
            "event:codex-turn-start-transport-execution:{}",
            envelope.write_attempt_id
        )),
        OrchestrationCommandId(format!(
            "command:codex-turn-start-transport-execution:{}",
            envelope.send_command_id
        )),
        Some(envelope.provider_instance_id.clone()),
    );

    Some(OrchestrationEventStoreRecord::from_event(
        EventStreamRef(format!(
            "stream:codex-transport-execution:{}",
            envelope.provider_instance_id
        )),
        payload,
    ))
}

fn write_transport_execution_event<B>(
    state: &ServerStateService<B>,
    event: &OrchestrationEventStoreRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let payload = encode_orchestration_event_store_record(event).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.to_string(),
        }
    })?;

    state.event_journal().put(
        LocalStoreRecord {
            id: PersistenceRecordId(event.event_id.0.clone()),
            domain: PersistenceDomain::EventJournal,
            kind: PersistenceRecordKind::Event,
            revision_id: RevisionId(format!("rev:{}", event.event_id.0)),
            payload: LocalStoreRecordPayload {
                media_type: Some("application/json".to_owned()),
                bytes: payload,
            },
        },
        RevisionExpectation::MustNotExist,
    )
}

fn receipt_status(
    input: &CodexAppServerTurnStartTransportExecutionPersistenceInput,
) -> EngineRuntimeReceiptStatus {
    match &input.result {
        CodexAppServerTurnStartTransportExecutionResult::AcceptedForExecutor
            if input.envelope.status
                == CodexAppServerTurnStartStdioExecutionEnvelopeStatus::ReadyForExecutorHandoff =>
        {
            EngineRuntimeReceiptStatus::Accepted
        }
        CodexAppServerTurnStartTransportExecutionResult::AcceptedForExecutor => {
            EngineRuntimeReceiptStatus::Blocked
        }
        CodexAppServerTurnStartTransportExecutionResult::Blocked(_) => {
            EngineRuntimeReceiptStatus::Blocked
        }
        CodexAppServerTurnStartTransportExecutionResult::Failed(_) => {
            EngineRuntimeReceiptStatus::Failed
        }
        CodexAppServerTurnStartTransportExecutionResult::Skipped(_) => {
            EngineRuntimeReceiptStatus::Blocked
        }
    }
}

fn summary(input: &CodexAppServerTurnStartTransportExecutionPersistenceInput) -> String {
    match &input.result {
        CodexAppServerTurnStartTransportExecutionResult::AcceptedForExecutor => {
            "Codex turn/start transport execution accepted for executor handoff".to_owned()
        }
        CodexAppServerTurnStartTransportExecutionResult::Blocked(reason) => {
            format!("Codex turn/start transport execution blocked: {reason}")
        }
        CodexAppServerTurnStartTransportExecutionResult::Failed(reason) => {
            format!("Codex turn/start transport execution failed: {reason}")
        }
        CodexAppServerTurnStartTransportExecutionResult::Skipped(reason) => {
            format!("Codex turn/start transport execution skipped: {reason}")
        }
    }
}

fn execution_id(envelope: &CodexAppServerTurnStartStdioExecutionEnvelopeRecord) -> String {
    format!(
        "codex-turn-start-transport-execution:{}",
        envelope.write_attempt_id
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        CodexAppServerTurnStartStdioExecutionEnvelopeId, CodexAppServerTurnStartStdioPayloadRef,
    };
    use crate::provider_service_runtime::ProviderServiceId;
    use crate::provider_transport_write::ProviderTransportWriteTarget;
    use crate::runtime_receipt_state::read_runtime_receipts;
    use nucleus_local_store::SqliteBackend;
    use nucleus_orchestration::{decode_orchestration_event_store_record, OrchestrationEventKind};

    #[test]
    fn transport_execution_persists_receipt_and_event_without_write_or_raw_payload() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

        let persisted = persist_codex_turn_start_transport_execution(
            &state,
            CodexAppServerTurnStartTransportExecutionPersistenceInput {
                envelope: ready_envelope(),
                result: CodexAppServerTurnStartTransportExecutionResult::AcceptedForExecutor,
            },
        )
        .expect("persist execution");

        let receipts = read_runtime_receipts(&state).expect("read receipts");
        let events = state.event_journal().list().expect("read events");
        let event =
            decode_orchestration_event_store_record(&events[0].payload.bytes).expect("event");

        assert_eq!(receipts.len(), 1);
        assert_eq!(events.len(), 1);
        assert_eq!(receipts[0].receipt_id, persisted.receipt_id);
        assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Accepted);
        assert_eq!(
            receipts[0].family,
            EngineRuntimeReceiptEffectFamily::HarnessProvider
        );
        assert_eq!(event.event_id, persisted.event_id.expect("event id"));
        assert_eq!(
            event.kind,
            OrchestrationEventKind::RuntimeObservationAccepted
        );
        assert_eq!(
            persisted.replay_policy,
            CodexAppServerTurnStartTransportExecutionReplayPolicy::InspectOnly
        );
        assert!(!persisted.provider_write_executed);
        assert!(!persisted.raw_payload_persisted);
        assert!(!persisted.raw_stream_persisted);
        assert!(!persisted.task_mutation_permitted);

        for bytes in [&events[0].payload.bytes, &receipts_json(&receipts)] {
            let json = String::from_utf8(bytes.clone()).expect("json");
            for forbidden in [
                "raw_provider_payload",
                "raw_stdio_stream",
                "credential",
                "secret",
            ] {
                assert!(
                    !json.contains(forbidden),
                    "persisted transport execution leaked {forbidden}"
                );
            }
        }
    }

    #[test]
    fn blocked_transport_execution_remains_inspectable_without_task_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let mut envelope = ready_envelope();
        envelope.status = CodexAppServerTurnStartStdioExecutionEnvelopeStatus::Blocked;

        let persisted = persist_codex_turn_start_transport_execution(
            &state,
            CodexAppServerTurnStartTransportExecutionPersistenceInput {
                envelope,
                result: CodexAppServerTurnStartTransportExecutionResult::Blocked(
                    "operator confirmation missing".to_owned(),
                ),
            },
        )
        .expect("persist blocked execution");
        let receipts = read_runtime_receipts(&state).expect("read receipts");

        assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Blocked);
        assert!(persisted.event_id.is_some());
        assert!(!persisted.provider_write_executed);
        assert!(!persisted.task_mutation_permitted);
    }

    #[test]
    fn skipped_transport_execution_writes_receipt_without_event() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

        let persisted = persist_codex_turn_start_transport_execution(
            &state,
            CodexAppServerTurnStartTransportExecutionPersistenceInput {
                envelope: ready_envelope(),
                result: CodexAppServerTurnStartTransportExecutionResult::Skipped(
                    "replay saw existing idempotency key".to_owned(),
                ),
            },
        )
        .expect("persist skipped execution");
        let receipts = read_runtime_receipts(&state).expect("read receipts");
        let events = state.event_journal().list().expect("read events");

        assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Blocked);
        assert!(events.is_empty());
        assert_eq!(persisted.event_id, None);
        assert_eq!(
            persisted.replay_policy,
            CodexAppServerTurnStartTransportExecutionReplayPolicy::InspectOnly
        );
    }

    fn ready_envelope() -> CodexAppServerTurnStartStdioExecutionEnvelopeRecord {
        CodexAppServerTurnStartStdioExecutionEnvelopeRecord {
            envelope_id: CodexAppServerTurnStartStdioExecutionEnvelopeId(
                "codex-turn-start-stdio-execution:provider-transport-write:1".to_owned(),
            ),
            request_id: "codex-turn-start-request:1".to_owned(),
            method: "turn/start".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            service_id: Some(ProviderServiceId("provider-service:codex".to_owned())),
            send_command_id: "codex-turn-start-send:1".to_owned(),
            preflight_id: "codex-live-send-preflight:1".to_owned(),
            write_attempt_id: "provider-transport-write:1".to_owned(),
            receipt_id: "receipt:codex-turn-start-live-send:1".to_owned(),
            event_id: OrchestrationEventId("event:codex-turn-start-live-send:1".to_owned()),
            authority_id: "codex-transport-executor-authority:1".to_owned(),
            idempotency_key: "codex-turn-start:session:1:work:1".to_owned(),
            payload_ref: CodexAppServerTurnStartStdioPayloadRef {
                payload_ref: "payload-ref:turn-start:1".to_owned(),
                summary: "turn/start payload built from prompt ref".to_owned(),
                raw_payload_retained: false,
            },
            target: ProviderTransportWriteTarget::Stdio {
                endpoint_label: "stdio://codex-app-server".to_owned(),
            },
            status: CodexAppServerTurnStartStdioExecutionEnvelopeStatus::ReadyForExecutorHandoff,
            blockers: Vec::new(),
            evidence_refs: vec!["evidence:executor-handoff".to_owned()],
            provider_write_executed: false,
            raw_payload_retained: false,
            raw_stream_retained: false,
            callback_response_permitted: false,
            cancellation_permitted: false,
            task_mutation_permitted: false,
        }
    }

    fn receipts_json(receipts: &[EngineRuntimeReceiptRecord]) -> Vec<u8> {
        serde_json::to_vec(receipts).expect("receipt json")
    }
}
