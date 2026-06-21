use nucleus_orchestration::OrchestrationEventStoreRecord;

use super::super::runtime_observation_event_identity::CodexRuntimeObservationEventIdentityRecord;
use super::super::runtime_observation_ingestion_cursor::CodexRuntimeObservationIngestionCursorRecord;

/// Input for persisting one runtime observation event-store promotion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRuntimeObservationEventStorePersistenceInput {
    pub identity: CodexRuntimeObservationEventIdentityRecord,
    pub cursor: CodexRuntimeObservationIngestionCursorRecord,
}

/// Durable sanitized outcome for one runtime observation event-store promotion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRuntimeObservationEventStorePersistenceRecord {
    pub persistence_id: String,
    pub identity_id: String,
    pub event_id: Option<String>,
    pub command_id: String,
    pub stream_ref: String,
    pub target_ref: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub binding_id: String,
    pub frame_source_id: String,
    pub decode_outcome_id: String,
    pub method: Option<String>,
    pub observation_kind: String,
    pub status: CodexRuntimeObservationEventStorePersistenceStatus,
    pub repair_hint: Option<String>,
    pub evidence_refs: Vec<String>,
    pub event_store_record: Option<OrchestrationEventStoreRecord>,
    pub replay_runs_provider_work: bool,
    pub raw_provider_material_retained: bool,
    pub provider_io_executed: bool,
    pub task_mutation_permitted: bool,
}

/// Event-store persistence status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexRuntimeObservationEventStorePersistenceStatus {
    Persisted,
    DuplicateNoop,
    RepairEvidenceOnly,
    Blocked,
}
