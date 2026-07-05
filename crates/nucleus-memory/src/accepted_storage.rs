//! JSON storage shape for accepted memory records.
//!
//! Accepted memory payloads are sanitized records. They do not store raw
//! transcripts, provider payloads, terminal streams, credentials, secret
//! values, or private notes.

use serde::{Deserialize, Serialize};

use crate::storage_shape::{
    MemoryConfidenceStorage, MemoryLinkStorageRefs, MemoryProposalStorageKind,
    MemoryProposalStorageScope, MemoryRetentionStoragePosture, MemorySensitivityStorage,
    MemorySourceStorageRef,
};

/// Current accepted-memory storage schema version.
pub const ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION: u16 = 1;

/// Serializable accepted memory record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AcceptedMemoryStorageRecord {
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
    pub actors: AcceptedMemoryStorageActors,
    pub review: AcceptedMemoryStorageReview,
    pub supersession: AcceptedMemorySupersessionStorageRefs,
    pub created_at: Option<String>,
    pub accepted_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Accepted-memory lifecycle.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedMemoryStorageStatus {
    Accepted,
    Stale,
    Superseded,
    Archived,
}

impl AcceptedMemoryStorageStatus {
    /// Accepted-memory statuses are not proposal statuses.
    pub fn is_proposal_status(&self) -> bool {
        false
    }
}

/// Serializable accepted-memory body.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcceptedMemoryStorageBody {
    Summary {
        summary: String,
        detail: Option<String>,
    },
    StructuredRef {
        ref_id: String,
        summary: String,
    },
}

/// Actor refs for accepted memory.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AcceptedMemoryStorageActors {
    pub created_by_ref: String,
    pub accepted_by_ref: String,
}

/// Review refs and sanitized note for accepted memory.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AcceptedMemoryStorageReview {
    pub reviewer_ref: String,
    pub note: Option<String>,
}

/// Accepted-memory supersession refs.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct AcceptedMemorySupersessionStorageRefs {
    #[serde(default)]
    pub supersedes: Vec<String>,
    #[serde(default)]
    pub superseded_by: Vec<String>,
}

/// Accepted-memory storage codec error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryRecordCodecError {
    pub reason: String,
}

/// Encode an accepted-memory storage record as JSON.
pub fn encode_accepted_memory_storage_payload(
    record: &AcceptedMemoryStorageRecord,
) -> Result<Vec<u8>, AcceptedMemoryRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

/// Decode an accepted-memory storage record from JSON.
pub fn decode_accepted_memory_storage_record(
    bytes: &[u8],
) -> Result<AcceptedMemoryStorageRecord, AcceptedMemoryRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

fn codec_error(error: serde_json::Error) -> AcceptedMemoryRecordCodecError {
    AcceptedMemoryRecordCodecError {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_shape::{
        MemoryProposalStorageKind, MemoryProposalStorageScope, MemoryRetentionStoragePosture,
        MemorySourceStorageKind,
    };

    fn storage_record() -> AcceptedMemoryStorageRecord {
        AcceptedMemoryStorageRecord {
            schema_version: ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
            memory_id: "memory:1".to_string(),
            source_proposal_id: Some("memory-proposal:1".to_string()),
            scope: MemoryProposalStorageScope::Project {
                project_ref: "project:nucleus".to_string(),
            },
            kind: MemoryProposalStorageKind::Decision,
            status: AcceptedMemoryStorageStatus::Accepted,
            title: "Use server-owned accepted memory".to_string(),
            body: AcceptedMemoryStorageBody::Summary {
                summary: "Accepted memory is durable server context.".to_string(),
                detail: Some("Proposal identity is retained as evidence only.".to_string()),
            },
            source_refs: vec![MemorySourceStorageRef {
                kind: MemorySourceStorageKind::PlanningArtifact,
                source_ref: "artifact:memory-boundary".to_string(),
                evidence_ref: Some("evidence:reviewed".to_string()),
            }],
            link_refs: MemoryLinkStorageRefs {
                planning_session_refs: vec!["planning-session:memory".to_string()],
                exploration_session_refs: Vec::new(),
                planning_artifact_refs: vec!["artifact:memory-boundary".to_string()],
                task_seed_refs: Vec::new(),
                research_brief_refs: Vec::new(),
                task_refs: Vec::new(),
                evidence_refs: vec!["evidence:reviewed".to_string()],
            },
            confidence: MemoryConfidenceStorage::High,
            sensitivity: MemorySensitivityStorage::InternalProject,
            retention: MemoryRetentionStoragePosture::ProjectContextCandidate,
            actors: AcceptedMemoryStorageActors {
                created_by_ref: "agent:steward".to_string(),
                accepted_by_ref: "operator:tom".to_string(),
            },
            review: AcceptedMemoryStorageReview {
                reviewer_ref: "operator:tom".to_string(),
                note: Some("Reviewed for promotion.".to_string()),
            },
            supersession: AcceptedMemorySupersessionStorageRefs {
                supersedes: vec!["memory:old".to_string()],
                superseded_by: Vec::new(),
            },
            created_at: Some("2026-07-05T00:00:00Z".to_string()),
            accepted_at: Some("2026-07-05T00:00:00Z".to_string()),
            updated_at: None,
        }
    }

    #[test]
    fn accepted_memory_storage_codec_round_trips_record() {
        let record = storage_record();

        let encoded = encode_accepted_memory_storage_payload(&record).unwrap();
        let decoded = decode_accepted_memory_storage_record(&encoded).unwrap();

        assert_eq!(decoded, record);
        assert_eq!(
            decoded.schema_version,
            ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION
        );
        assert_eq!(decoded.memory_id, "memory:1");
        assert_eq!(
            decoded.source_proposal_id.as_deref(),
            Some("memory-proposal:1")
        );
        assert!(!decoded.status.is_proposal_status());
    }

    #[test]
    fn accepted_memory_storage_shape_excludes_raw_payload_fields() {
        let encoded =
            String::from_utf8(encode_accepted_memory_storage_payload(&storage_record()).unwrap())
                .unwrap();

        for forbidden in [
            "raw_transcript",
            "provider_payload",
            "terminal_stream",
            "credential",
            "secret_value",
            "private_note",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "encoded memory leaked {forbidden}"
            );
        }
    }

    #[test]
    fn accepted_memory_storage_does_not_grant_follow_on_effects() {
        let record = storage_record();

        assert!(!record.link_refs.grants_mutation_authority());
        assert!(!record.retention.grants_projection_authority());
        assert!(!record.sensitivity.allows_secret_values());
    }

    #[test]
    fn decode_errors_are_reported() {
        let error = decode_accepted_memory_storage_record(b"{not-json").unwrap_err();

        assert!(!error.reason.is_empty());
    }
}
