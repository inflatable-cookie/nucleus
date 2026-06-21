use nucleus_local_store::{LocalStoreError, LocalStoreRecordPayload, LocalStoreResult};
use nucleus_orchestration::{
    EventStreamRef, OrchestrationCommandId, OrchestrationEventId, OrchestrationEventRecord,
    OrchestrationEventStoreRecord,
};
use serde::{Deserialize, Serialize};

use super::types::{
    CodexRuntimeObservationEventStorePersistenceRecord,
    CodexRuntimeObservationEventStorePersistenceStatus,
};

pub(super) fn encode_persistence_record(
    record: &CodexRuntimeObservationEventStorePersistenceRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(&PersistenceRecordDto::from_record(record)).map_err(json_error)
}

pub(super) fn decode_persistence_record(
    bytes: &[u8],
) -> LocalStoreResult<CodexRuntimeObservationEventStorePersistenceRecord> {
    let dto: PersistenceRecordDto = serde_json::from_slice(bytes).map_err(json_error)?;
    dto.into_record()
}

pub(super) fn json_payload(bytes: Vec<u8>) -> LocalStoreRecordPayload {
    LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes,
    }
}

pub(super) fn json_error(error: impl ToString) -> LocalStoreError {
    LocalStoreError::InvalidRecord {
        reason: error.to_string(),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PersistenceRecordDto {
    persistence_id: String,
    identity_id: String,
    event_id: Option<String>,
    command_id: String,
    stream_ref: String,
    target_ref: String,
    provider_instance_id: String,
    runtime_session_ref: String,
    binding_id: String,
    frame_source_id: String,
    decode_outcome_id: String,
    method: Option<String>,
    observation_kind: String,
    status: String,
    repair_hint: Option<String>,
    evidence_refs: Vec<String>,
    replay_runs_provider_work: bool,
    raw_provider_material_retained: bool,
    provider_io_executed: bool,
    task_mutation_permitted: bool,
}

impl PersistenceRecordDto {
    fn from_record(record: &CodexRuntimeObservationEventStorePersistenceRecord) -> Self {
        Self {
            persistence_id: record.persistence_id.clone(),
            identity_id: record.identity_id.clone(),
            event_id: record.event_id.clone(),
            command_id: record.command_id.clone(),
            stream_ref: record.stream_ref.clone(),
            target_ref: record.target_ref.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            runtime_session_ref: record.runtime_session_ref.clone(),
            binding_id: record.binding_id.clone(),
            frame_source_id: record.frame_source_id.clone(),
            decode_outcome_id: record.decode_outcome_id.clone(),
            method: record.method.clone(),
            observation_kind: record.observation_kind.clone(),
            status: status_to_str(&record.status).to_owned(),
            repair_hint: record.repair_hint.clone(),
            evidence_refs: record.evidence_refs.clone(),
            replay_runs_provider_work: record.replay_runs_provider_work,
            raw_provider_material_retained: record.raw_provider_material_retained,
            provider_io_executed: record.provider_io_executed,
            task_mutation_permitted: record.task_mutation_permitted,
        }
    }

    fn into_record(self) -> LocalStoreResult<CodexRuntimeObservationEventStorePersistenceRecord> {
        let event_store_record = self.event_id.as_ref().map(|event_id| {
            let payload = OrchestrationEventRecord::runtime_observation_accepted(
                OrchestrationEventId(event_id.clone()),
                OrchestrationCommandId(self.command_id.clone()),
                Some(self.target_ref.clone()),
            );
            OrchestrationEventStoreRecord::from_event(
                EventStreamRef(self.stream_ref.clone()),
                payload,
            )
        });

        Ok(CodexRuntimeObservationEventStorePersistenceRecord {
            persistence_id: self.persistence_id,
            identity_id: self.identity_id,
            event_id: self.event_id,
            command_id: self.command_id,
            stream_ref: self.stream_ref,
            target_ref: self.target_ref,
            provider_instance_id: self.provider_instance_id,
            runtime_session_ref: self.runtime_session_ref,
            binding_id: self.binding_id,
            frame_source_id: self.frame_source_id,
            decode_outcome_id: self.decode_outcome_id,
            method: self.method,
            observation_kind: self.observation_kind,
            status: status_from_str(&self.status),
            repair_hint: self.repair_hint,
            evidence_refs: self.evidence_refs,
            event_store_record,
            replay_runs_provider_work: self.replay_runs_provider_work,
            raw_provider_material_retained: self.raw_provider_material_retained,
            provider_io_executed: self.provider_io_executed,
            task_mutation_permitted: self.task_mutation_permitted,
        })
    }
}

fn status_to_str(status: &CodexRuntimeObservationEventStorePersistenceStatus) -> &'static str {
    match status {
        CodexRuntimeObservationEventStorePersistenceStatus::Persisted => "persisted",
        CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop => "duplicate_noop",
        CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly => {
            "repair_evidence_only"
        }
        CodexRuntimeObservationEventStorePersistenceStatus::Blocked => "blocked",
    }
}

fn status_from_str(value: &str) -> CodexRuntimeObservationEventStorePersistenceStatus {
    match value {
        "persisted" => CodexRuntimeObservationEventStorePersistenceStatus::Persisted,
        "duplicate_noop" => CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop,
        "repair_evidence_only" => {
            CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly
        }
        _ => CodexRuntimeObservationEventStorePersistenceStatus::Blocked,
    }
}
