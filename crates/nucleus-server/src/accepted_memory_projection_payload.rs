//! Sanitized accepted-memory projection file payloads.
//!
//! Payloads are the file-format boundary for `nucleus/memory/<memory-id>.toml`.
//! They are pure data and codec helpers. They do not read or write files, call
//! SCM/forge providers, run embeddings, sync provider memory, mutate tasks, or
//! expose raw provider/runtime payloads.

use nucleus_memory::{
    AcceptedMemoryStorageBody, AcceptedMemoryStorageRecord, AcceptedMemoryStorageReview,
    AcceptedMemoryStorageStatus, AcceptedMemorySupersessionStorageRefs, MemoryConfidenceStorage,
    MemoryLinkStorageRefs, MemoryProposalStorageKind, MemoryProposalStorageScope,
    MemoryRetentionStoragePosture, MemorySensitivityStorage, MemorySourceStorageRef,
    ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};

pub const ACCEPTED_MEMORY_PROJECTION_FILE_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AcceptedMemoryProjectionPayload {
    pub schema_version: u16,
    pub memory_id: String,
    pub source_proposal_id: Option<String>,
    pub scope: MemoryProposalStorageScope,
    pub kind: MemoryProposalStorageKind,
    pub status: AcceptedMemoryStorageStatus,
    pub title: String,
    pub body: AcceptedMemoryStorageBody,
    #[serde(default)]
    pub source_refs: Vec<MemorySourceStorageRef>,
    #[serde(default)]
    pub link_refs: MemoryLinkStorageRefs,
    pub confidence: MemoryConfidenceStorage,
    pub sensitivity: MemorySensitivityStorage,
    pub retention: MemoryRetentionStoragePosture,
    pub accepted_by_ref: String,
    pub review: AcceptedMemoryStorageReview,
    pub supersession: AcceptedMemorySupersessionStorageRefs,
    pub created_at: Option<String>,
    pub accepted_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionPayloadCodecError {
    pub reason: String,
}

impl AcceptedMemoryProjectionPayload {
    pub fn from_accepted_memory_record(
        record: &AcceptedMemoryStorageRecord,
    ) -> Result<Self, AcceptedMemoryProjectionPayloadCodecError> {
        if record.schema_version != ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION {
            return Err(AcceptedMemoryProjectionPayloadCodecError {
                reason: format!(
                    "unsupported accepted memory storage schema: {}",
                    record.schema_version
                ),
            });
        }

        Ok(Self {
            schema_version: ACCEPTED_MEMORY_PROJECTION_FILE_SCHEMA_VERSION,
            memory_id: record.memory_id.clone(),
            source_proposal_id: record.source_proposal_id.clone(),
            scope: record.scope.clone(),
            kind: record.kind.clone(),
            status: record.status,
            title: record.title.clone(),
            body: record.body.clone(),
            source_refs: record.source_refs.clone(),
            link_refs: record.link_refs.clone(),
            confidence: record.confidence,
            sensitivity: record.sensitivity,
            retention: record.retention.clone(),
            accepted_by_ref: record.actors.accepted_by_ref.clone(),
            review: record.review.clone(),
            supersession: record.supersession.clone(),
            created_at: record.created_at.clone(),
            accepted_at: record.accepted_at.clone(),
            updated_at: record.updated_at.clone(),
        })
    }
}

pub fn encode_accepted_memory_projection_payload(
    payload: &AcceptedMemoryProjectionPayload,
) -> Result<Vec<u8>, AcceptedMemoryProjectionPayloadCodecError> {
    toml::to_string_pretty(payload)
        .map(|text| text.into_bytes())
        .map_err(|error| AcceptedMemoryProjectionPayloadCodecError {
            reason: error.to_string(),
        })
}

pub fn decode_accepted_memory_projection_payload(
    bytes: &[u8],
) -> Result<AcceptedMemoryProjectionPayload, AcceptedMemoryProjectionPayloadCodecError> {
    let text =
        std::str::from_utf8(bytes).map_err(|error| AcceptedMemoryProjectionPayloadCodecError {
            reason: error.to_string(),
        })?;
    let payload: AcceptedMemoryProjectionPayload =
        toml::from_str(text).map_err(|error| AcceptedMemoryProjectionPayloadCodecError {
            reason: error.to_string(),
        })?;
    if payload.schema_version != ACCEPTED_MEMORY_PROJECTION_FILE_SCHEMA_VERSION {
        return Err(AcceptedMemoryProjectionPayloadCodecError {
            reason: format!(
                "unsupported accepted memory projection schema: {}",
                payload.schema_version
            ),
        });
    }
    Ok(payload)
}
