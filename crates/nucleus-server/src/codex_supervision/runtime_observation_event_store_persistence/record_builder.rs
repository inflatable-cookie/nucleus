use nucleus_orchestration::{
    EventStreamRef, OrchestrationCommandId, OrchestrationEventId, OrchestrationEventRecord,
    OrchestrationEventStoreRecord,
};

use super::super::runtime_observation_event_identity::{
    CodexRuntimeObservationEventIdentityRecord, CodexRuntimeObservationEventIdentityStatus,
};
use super::super::runtime_observation_ingestion_cursor::CodexRuntimeObservationIngestionCursorStatus;
use super::types::{
    CodexRuntimeObservationEventStorePersistenceInput,
    CodexRuntimeObservationEventStorePersistenceRecord,
    CodexRuntimeObservationEventStorePersistenceStatus,
};
use super::EVENT_PERSISTENCE_PREFIX;

pub(super) fn persistence_record_from_input(
    input: &CodexRuntimeObservationEventStorePersistenceInput,
) -> CodexRuntimeObservationEventStorePersistenceRecord {
    let status = persistence_status(input);
    let event_store_record =
        if status == CodexRuntimeObservationEventStorePersistenceStatus::Persisted {
            Some(event_store_record_from_identity(&input.identity))
        } else {
            None
        };
    let repair_hint = match status {
        CodexRuntimeObservationEventStorePersistenceStatus::Persisted
        | CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop => None,
        CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly => input
            .cursor
            .repair_hint
            .clone()
            .or_else(|| Some("runtime observation not accepted by cursor".to_owned())),
        CodexRuntimeObservationEventStorePersistenceStatus::Blocked => {
            Some("runtime observation identity is blocked".to_owned())
        }
    };

    CodexRuntimeObservationEventStorePersistenceRecord {
        persistence_id: format!("{}{}", EVENT_PERSISTENCE_PREFIX, input.identity.identity_id),
        identity_id: input.identity.identity_id.clone(),
        event_id: event_store_record
            .as_ref()
            .map(|record| record.event_id.0.clone()),
        command_id: input.identity.command_id.clone(),
        stream_ref: input.identity.stream_ref.clone(),
        target_ref: input.identity.target_ref.clone(),
        provider_instance_id: input.identity.provider_instance_id.clone(),
        runtime_session_ref: input.identity.runtime_session_ref.clone(),
        binding_id: input.identity.binding_id.clone(),
        frame_source_id: input.identity.frame_source_id.clone(),
        decode_outcome_id: input.identity.decode_outcome_id.clone(),
        method: input.identity.method.clone(),
        observation_kind: format!("{:?}", input.identity.observation_kind),
        status,
        repair_hint,
        evidence_refs: input.cursor.evidence_refs.clone(),
        event_store_record,
        replay_runs_provider_work: false,
        raw_provider_material_retained: false,
        provider_io_executed: false,
        task_mutation_permitted: false,
    }
}

fn persistence_status(
    input: &CodexRuntimeObservationEventStorePersistenceInput,
) -> CodexRuntimeObservationEventStorePersistenceStatus {
    if input.identity.status == CodexRuntimeObservationEventIdentityStatus::Blocked
        || input.identity.raw_provider_material_retained
        || input.identity.provider_io_executed
        || input.identity.task_mutation_permitted
    {
        return CodexRuntimeObservationEventStorePersistenceStatus::Blocked;
    }
    if input.identity.status == CodexRuntimeObservationEventIdentityStatus::UnsupportedObservation {
        return CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly;
    }
    match input.cursor.status {
        CodexRuntimeObservationIngestionCursorStatus::Accepted => {
            CodexRuntimeObservationEventStorePersistenceStatus::Persisted
        }
        CodexRuntimeObservationIngestionCursorStatus::DuplicateNoop => {
            CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop
        }
        CodexRuntimeObservationIngestionCursorStatus::StaleBlocked
        | CodexRuntimeObservationIngestionCursorStatus::GapRepairRequired => {
            CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly
        }
        CodexRuntimeObservationIngestionCursorStatus::IdentityBlocked => {
            CodexRuntimeObservationEventStorePersistenceStatus::Blocked
        }
    }
}

pub(super) fn event_store_record_from_identity(
    identity: &CodexRuntimeObservationEventIdentityRecord,
) -> OrchestrationEventStoreRecord {
    let payload = OrchestrationEventRecord::runtime_observation_accepted(
        OrchestrationEventId(identity.event_id.clone()),
        OrchestrationCommandId(identity.command_id.clone()),
        Some(identity.target_ref.clone()),
    );
    OrchestrationEventStoreRecord::from_event(EventStreamRef(identity.stream_ref.clone()), payload)
}
