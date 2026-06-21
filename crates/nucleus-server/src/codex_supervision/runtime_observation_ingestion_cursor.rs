//! Runtime observation ingestion cursor persistence.
//!
//! Cursor snapshots make accepted provider observations idempotent and
//! replay-safe. They do not read provider streams, invoke provider I/O, or
//! mutate task state.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerStateService;

use super::runtime_observation_event_identity::{
    CodexRuntimeObservationEventIdentityRecord, CodexRuntimeObservationEventIdentityStatus,
};

const CURSOR_PREFIX: &str = "codex-runtime-observation-cursor:";

/// Input for applying one runtime observation identity to its ingestion cursor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRuntimeObservationIngestionCursorInput {
    pub identity: CodexRuntimeObservationEventIdentityRecord,
}

/// Durable cursor snapshot for one runtime observation stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexRuntimeObservationIngestionCursorRecord {
    pub cursor_id: String,
    pub stream_ref: String,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub last_accepted_sequence: Option<u64>,
    pub accepted_identity_ids: Vec<String>,
    pub accepted_event_ids: Vec<String>,
    pub status: CodexRuntimeObservationIngestionCursorStatus,
    pub repair_required: bool,
    pub repair_hint: Option<String>,
    pub evidence_refs: Vec<String>,
    pub provider_io_executed: bool,
    pub task_mutation_permitted: bool,
}

/// Cursor status after applying one identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexRuntimeObservationIngestionCursorStatus {
    Accepted,
    DuplicateNoop,
    StaleBlocked,
    GapRepairRequired,
    IdentityBlocked,
}

/// Apply one identity to its persisted cursor snapshot.
pub fn apply_codex_runtime_observation_ingestion_cursor<B>(
    state: &ServerStateService<B>,
    input: CodexRuntimeObservationIngestionCursorInput,
) -> LocalStoreResult<CodexRuntimeObservationIngestionCursorRecord>
where
    B: LocalStoreBackend,
{
    let existing = read_cursor(state, &cursor_id(&input.identity.stream_ref))?;
    let next = next_cursor(existing, &input.identity);
    write_cursor(state, &next)?;
    Ok(next)
}

/// Read all persisted runtime observation ingestion cursors.
pub fn read_codex_runtime_observation_ingestion_cursors<B>(
    state: &ServerStateService<B>,
) -> LocalStoreResult<Vec<CodexRuntimeObservationIngestionCursorRecord>>
where
    B: LocalStoreBackend,
{
    let mut records = state
        .artifact_metadata()
        .list()?
        .into_iter()
        .filter(|record| record.id.0.starts_with(CURSOR_PREFIX))
        .map(|record| decode_cursor_record(&record.payload.bytes))
        .collect::<LocalStoreResult<Vec<_>>>()?;
    records.sort_by(|left, right| left.cursor_id.cmp(&right.cursor_id));
    Ok(records)
}

fn next_cursor(
    existing: Option<CodexRuntimeObservationIngestionCursorRecord>,
    identity: &CodexRuntimeObservationEventIdentityRecord,
) -> CodexRuntimeObservationIngestionCursorRecord {
    let mut cursor = existing.unwrap_or_else(|| empty_cursor(identity));
    cursor.provider_io_executed = false;
    cursor.task_mutation_permitted = false;

    if identity.status == CodexRuntimeObservationEventIdentityStatus::Blocked {
        cursor.status = CodexRuntimeObservationIngestionCursorStatus::IdentityBlocked;
        cursor.repair_required = true;
        cursor.repair_hint = Some("runtime observation identity is blocked".to_owned());
        cursor.evidence_refs.push(identity.identity_id.clone());
        return cursor;
    }

    if cursor
        .accepted_identity_ids
        .iter()
        .any(|value| value == &identity.identity_id)
        || cursor
            .accepted_event_ids
            .iter()
            .any(|value| value == &identity.event_id)
    {
        cursor.status = CodexRuntimeObservationIngestionCursorStatus::DuplicateNoop;
        cursor.repair_required = false;
        cursor.repair_hint = None;
        return cursor;
    }

    if let Some(last_sequence) = cursor.last_accepted_sequence {
        if identity.sequence <= last_sequence {
            cursor.status = CodexRuntimeObservationIngestionCursorStatus::StaleBlocked;
            cursor.repair_required = false;
            cursor.repair_hint = Some(format!(
                "observation sequence {} is not newer than cursor sequence {last_sequence}",
                identity.sequence
            ));
            return cursor;
        }
        if identity.sequence > last_sequence + 1 {
            cursor.status = CodexRuntimeObservationIngestionCursorStatus::GapRepairRequired;
            cursor.repair_required = true;
            cursor.repair_hint = Some(format!(
                "observation sequence gap: expected {}, got {}",
                last_sequence + 1,
                identity.sequence
            ));
            cursor.evidence_refs.push(identity.identity_id.clone());
            return cursor;
        }
    }

    cursor.status = CodexRuntimeObservationIngestionCursorStatus::Accepted;
    cursor.repair_required = false;
    cursor.repair_hint = None;
    cursor.last_accepted_sequence = Some(identity.sequence);
    cursor
        .accepted_identity_ids
        .push(identity.identity_id.clone());
    cursor.accepted_event_ids.push(identity.event_id.clone());
    cursor.evidence_refs.push(identity.identity_id.clone());
    cursor
}

fn empty_cursor(
    identity: &CodexRuntimeObservationEventIdentityRecord,
) -> CodexRuntimeObservationIngestionCursorRecord {
    CodexRuntimeObservationIngestionCursorRecord {
        cursor_id: cursor_id(&identity.stream_ref),
        stream_ref: identity.stream_ref.clone(),
        provider_instance_id: identity.provider_instance_id.clone(),
        runtime_session_ref: identity.runtime_session_ref.clone(),
        last_accepted_sequence: None,
        accepted_identity_ids: Vec::new(),
        accepted_event_ids: Vec::new(),
        status: CodexRuntimeObservationIngestionCursorStatus::Accepted,
        repair_required: false,
        repair_hint: None,
        evidence_refs: Vec::new(),
        provider_io_executed: false,
        task_mutation_permitted: false,
    }
}

fn read_cursor<B>(
    state: &ServerStateService<B>,
    cursor_id: &str,
) -> LocalStoreResult<Option<CodexRuntimeObservationIngestionCursorRecord>>
where
    B: LocalStoreBackend,
{
    state
        .artifact_metadata()
        .get(&PersistenceRecordId(cursor_id.to_owned()))?
        .map(|record| decode_cursor_record(&record.payload.bytes))
        .transpose()
}

fn write_cursor<B>(
    state: &ServerStateService<B>,
    cursor: &CodexRuntimeObservationIngestionCursorRecord,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    state.artifact_metadata().put(
        LocalStoreRecord {
            id: PersistenceRecordId(cursor.cursor_id.clone()),
            domain: PersistenceDomain::ArtifactMetadata,
            kind: PersistenceRecordKind::ArtifactMetadata,
            revision_id: RevisionId(format!(
                "rev:{}:{}",
                cursor.cursor_id,
                cursor.last_accepted_sequence.unwrap_or_default()
            )),
            payload: json_payload(encode_cursor_record(cursor)?),
        },
        RevisionExpectation::Any,
    )
}

fn cursor_id(stream_ref: &str) -> String {
    format!("{}{}", CURSOR_PREFIX, stream_ref)
}

fn encode_cursor_record(
    record: &CodexRuntimeObservationIngestionCursorRecord,
) -> LocalStoreResult<Vec<u8>> {
    serde_json::to_vec(&CursorRecordDto::from_record(record)).map_err(json_error)
}

fn decode_cursor_record(
    bytes: &[u8],
) -> LocalStoreResult<CodexRuntimeObservationIngestionCursorRecord> {
    let dto: CursorRecordDto = serde_json::from_slice(bytes).map_err(json_error)?;
    Ok(dto.into_record())
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

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CursorRecordDto {
    cursor_id: String,
    stream_ref: String,
    provider_instance_id: String,
    runtime_session_ref: String,
    last_accepted_sequence: Option<u64>,
    accepted_identity_ids: Vec<String>,
    accepted_event_ids: Vec<String>,
    status: String,
    repair_required: bool,
    repair_hint: Option<String>,
    evidence_refs: Vec<String>,
    provider_io_executed: bool,
    task_mutation_permitted: bool,
}

impl CursorRecordDto {
    fn from_record(record: &CodexRuntimeObservationIngestionCursorRecord) -> Self {
        Self {
            cursor_id: record.cursor_id.clone(),
            stream_ref: record.stream_ref.clone(),
            provider_instance_id: record.provider_instance_id.clone(),
            runtime_session_ref: record.runtime_session_ref.clone(),
            last_accepted_sequence: record.last_accepted_sequence,
            accepted_identity_ids: record.accepted_identity_ids.clone(),
            accepted_event_ids: record.accepted_event_ids.clone(),
            status: status_to_str(&record.status).to_owned(),
            repair_required: record.repair_required,
            repair_hint: record.repair_hint.clone(),
            evidence_refs: record.evidence_refs.clone(),
            provider_io_executed: record.provider_io_executed,
            task_mutation_permitted: record.task_mutation_permitted,
        }
    }

    fn into_record(self) -> CodexRuntimeObservationIngestionCursorRecord {
        CodexRuntimeObservationIngestionCursorRecord {
            cursor_id: self.cursor_id,
            stream_ref: self.stream_ref,
            provider_instance_id: self.provider_instance_id,
            runtime_session_ref: self.runtime_session_ref,
            last_accepted_sequence: self.last_accepted_sequence,
            accepted_identity_ids: self.accepted_identity_ids,
            accepted_event_ids: self.accepted_event_ids,
            status: status_from_str(&self.status),
            repair_required: self.repair_required,
            repair_hint: self.repair_hint,
            evidence_refs: self.evidence_refs,
            provider_io_executed: self.provider_io_executed,
            task_mutation_permitted: self.task_mutation_permitted,
        }
    }
}

fn status_to_str(status: &CodexRuntimeObservationIngestionCursorStatus) -> &'static str {
    match status {
        CodexRuntimeObservationIngestionCursorStatus::Accepted => "accepted",
        CodexRuntimeObservationIngestionCursorStatus::DuplicateNoop => "duplicate_noop",
        CodexRuntimeObservationIngestionCursorStatus::StaleBlocked => "stale_blocked",
        CodexRuntimeObservationIngestionCursorStatus::GapRepairRequired => "gap_repair_required",
        CodexRuntimeObservationIngestionCursorStatus::IdentityBlocked => "identity_blocked",
    }
}

fn status_from_str(value: &str) -> CodexRuntimeObservationIngestionCursorStatus {
    match value {
        "accepted" => CodexRuntimeObservationIngestionCursorStatus::Accepted,
        "duplicate_noop" => CodexRuntimeObservationIngestionCursorStatus::DuplicateNoop,
        "stale_blocked" => CodexRuntimeObservationIngestionCursorStatus::StaleBlocked,
        "gap_repair_required" => CodexRuntimeObservationIngestionCursorStatus::GapRepairRequired,
        "identity_blocked" => CodexRuntimeObservationIngestionCursorStatus::IdentityBlocked,
        _ => CodexRuntimeObservationIngestionCursorStatus::IdentityBlocked,
    }
}

#[cfg(test)]
mod tests;
