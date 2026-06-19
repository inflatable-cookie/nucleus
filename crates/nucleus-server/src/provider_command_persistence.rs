//! Provider command outcome persistence helpers.
//!
//! This module persists sanitized provider command outcomes as runtime receipts
//! and runtime observation events. It does not persist raw provider payloads or
//! mutate task state.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::EngineRuntimeReceiptRecordId;
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use nucleus_orchestration::{
    encode_orchestration_event_store_record, OrchestrationEventId, OrchestrationEventStoreRecord,
};

use crate::provider_command_reactor::{
    provider_runtime_outcome_from_reactor_outcome, ProviderCommandReactorOutcomeId,
    ProviderCommandReactorOutcomeRecord,
};
use crate::provider_runtime_orchestration::{
    event_store_record_from_provider_outcome, runtime_receipt_from_provider_outcome,
    ProviderRuntimeOutcomeId,
};
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::state::ServerStateService;

/// Persistence refs produced for one provider command outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCommandOutcomePersistenceRecord {
    pub outcome_id: ProviderCommandReactorOutcomeId,
    pub runtime_outcome_id: ProviderRuntimeOutcomeId,
    pub receipt_id: EngineRuntimeReceiptRecordId,
    pub event_id: OrchestrationEventId,
    pub raw_provider_payload_persisted: bool,
    pub task_mutation_permitted: bool,
}

/// Persist a provider command outcome as receipt plus event-store record.
pub fn persist_provider_command_outcome<B>(
    state: &ServerStateService<B>,
    outcome: &ProviderCommandReactorOutcomeRecord,
) -> LocalStoreResult<ProviderCommandOutcomePersistenceRecord>
where
    B: LocalStoreBackend,
{
    let runtime_outcome = provider_runtime_outcome_from_reactor_outcome(outcome);
    let receipt = runtime_receipt_from_provider_outcome(&runtime_outcome);
    let event = event_store_record_from_provider_outcome(&runtime_outcome);

    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::MustNotExist,
    )?;
    write_provider_runtime_event(state, &event)?;

    Ok(ProviderCommandOutcomePersistenceRecord {
        outcome_id: outcome.outcome_id.clone(),
        runtime_outcome_id: runtime_outcome.outcome_id,
        receipt_id: receipt.receipt_id,
        event_id: event.event_id,
        raw_provider_payload_persisted: false,
        task_mutation_permitted: false,
    })
}

fn write_provider_runtime_event<B>(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_command_reactor::{
        admit_provider_command, provider_command_dispatch_attempt,
        provider_command_reactor_outcome, queue_provider_command, ProviderCommandAdmissionInput,
        ProviderCommandCapabilityState, ProviderCommandId, ProviderCommandReactorId,
        ProviderCommandRequester,
    };
    use crate::provider_service_runtime::{
        ProviderCommandFamily, ProviderCommandLaneId, ProviderReactorReadinessState,
        ProviderRuntimeStreamId, ProviderServiceId,
    };
    use crate::runtime_receipt_state::read_runtime_receipts;
    use nucleus_agent_protocol::AdapterCommandStreamState;
    use nucleus_engine::{EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptStatus};
    use nucleus_local_store::SqliteBackend;
    use nucleus_orchestration::{decode_orchestration_event_store_record, OrchestrationEventKind};

    #[test]
    fn provider_command_outcome_persists_receipt_and_event_without_task_mutation() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        let outcome = reactor_outcome();

        let persisted =
            persist_provider_command_outcome(&state, &outcome).expect("persist outcome");
        let receipts = read_runtime_receipts(&state).expect("read receipts");
        let events = state.event_journal().list().expect("read event records");
        let event =
            decode_orchestration_event_store_record(&events[0].payload.bytes).expect("event");

        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receipt_id, persisted.receipt_id);
        assert_eq!(
            receipts[0].family,
            EngineRuntimeReceiptEffectFamily::HarnessProvider
        );
        assert_eq!(receipts[0].status, EngineRuntimeReceiptStatus::Completed);
        assert_eq!(events.len(), 1);
        assert_eq!(event.event_id, persisted.event_id);
        assert_eq!(
            event.kind,
            OrchestrationEventKind::RuntimeObservationAccepted
        );
        assert!(!persisted.raw_provider_payload_persisted);
        assert!(!persisted.task_mutation_permitted);

        for bytes in [&events[0].payload.bytes, &receipts_json(&receipts)] {
            let json = String::from_utf8(bytes.clone()).expect("json");
            for forbidden in ["raw_provider_payload", "credential", "secret"] {
                assert!(
                    !json.contains(forbidden),
                    "persisted provider data leaked {forbidden}"
                );
            }
        }
    }

    fn reactor_outcome() -> crate::ProviderCommandReactorOutcomeRecord {
        let admission = admit_provider_command(ProviderCommandAdmissionInput {
            command_id: ProviderCommandId("provider-command:persist".to_owned()),
            reactor_id: ProviderCommandReactorId("provider-reactor:codex".to_owned()),
            service_id: ProviderServiceId("provider-service:codex".to_owned()),
            command_lane_id: ProviderCommandLaneId("provider-command-lane:codex".to_owned()),
            stream_id: Some(ProviderRuntimeStreamId(
                "provider-event-stream:codex".to_owned(),
            )),
            family: ProviderCommandFamily::StartTurn,
            target_ref: Some("session:1".to_owned()),
            requester: ProviderCommandRequester::TaskAgent,
            capability: ProviderCommandCapabilityState::Supported,
            reactor_state: ProviderReactorReadinessState::ReadyForCommands,
            command_stream_state: AdapterCommandStreamState::Accepting,
            live_send_requested: false,
            task_mutation_requested: false,
            evidence_refs: vec!["evidence:provider-command".to_owned()],
        });
        let queued = queue_provider_command(&admission).expect("queued");
        let attempt = provider_command_dispatch_attempt(
            &queued,
            vec!["evidence:provider-command".to_owned()],
        )
        .expect("attempt");

        provider_command_reactor_outcome(&attempt)
    }

    fn receipts_json(receipts: &[nucleus_engine::EngineRuntimeReceiptRecord]) -> Vec<u8> {
        serde_json::to_vec(receipts).expect("receipt json")
    }
}
