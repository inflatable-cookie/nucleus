//! JSON storage shape for memory proposal records.
//!
//! These payloads persist proposal-side memory state only. They do not store
//! raw transcripts, provider payloads, raw terminal streams, credentials,
//! secret values, or private notes by default.

use serde::{Deserialize, Serialize};

/// Current memory proposal storage schema version.
pub const MEMORY_STORAGE_SCHEMA_VERSION: u16 = 1;

/// Serializable memory proposal record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MemoryProposalStorageRecord {
    pub schema_version: u16,
    pub proposal_id: String,
    pub scope: MemoryProposalStorageScope,
    pub kind: MemoryProposalStorageKind,
    pub status: MemoryProposalStorageStatus,
    pub title: String,
    pub summary: String,
    pub detail: Option<String>,
    #[serde(default)]
    pub source_refs: Vec<MemorySourceStorageRef>,
    #[serde(default)]
    pub link_refs: MemoryLinkStorageRefs,
    pub confidence: MemoryConfidenceStorage,
    pub review: MemoryReviewStorageState,
    pub sensitivity: MemorySensitivityStorage,
    pub retention: MemoryRetentionStoragePosture,
    pub supersession: MemorySupersessionStorageRefs,
    pub proposed_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Serializable memory scope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryProposalStorageScope {
    Project { project_ref: String },
    Task { task_ref: String },
    AgentSession { agent_session_ref: String },
    RepoMembership { repo_membership_ref: String },
    Workspace { workspace_ref: String },
    UserPrivate,
}

/// Serializable memory kind.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryProposalStorageKind {
    Decision,
    Preference,
    Constraint,
    ArchitectureNote,
    ProjectFact,
    TaskContext,
    ValidationLesson,
    Risk,
    OpenQuestion,
    ConversationSummary,
    HandoffSummary,
    ResearchFinding,
    Other { label: String },
}

/// Serializable proposal status.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryProposalStorageStatus {
    Proposed,
    ReviewRequested,
    Rejected,
    Stale,
    Superseded,
    Archived,
}

/// Serializable source reference.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MemorySourceStorageRef {
    pub kind: MemorySourceStorageKind,
    pub source_ref: String,
    pub evidence_ref: Option<String>,
}

/// Serializable source category.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemorySourceStorageKind {
    PlanningSession,
    ExplorationSession,
    PlanningArtifact,
    TaskSeed,
    ResearchBrief,
    Task,
    AgentSession,
    SanitizedEvidence,
    ScmChange,
    Document,
    Custom { label: String },
}

/// Serializable cross-domain linkage refs.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct MemoryLinkStorageRefs {
    #[serde(default)]
    pub planning_session_refs: Vec<String>,
    #[serde(default)]
    pub exploration_session_refs: Vec<String>,
    #[serde(default)]
    pub planning_artifact_refs: Vec<String>,
    #[serde(default)]
    pub task_seed_refs: Vec<String>,
    #[serde(default)]
    pub research_brief_refs: Vec<String>,
    #[serde(default)]
    pub task_refs: Vec<String>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
}

impl MemoryLinkStorageRefs {
    /// Link refs do not grant mutation authority.
    pub fn grants_mutation_authority(&self) -> bool {
        false
    }
}

/// Serializable confidence signal.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryConfidenceStorage {
    Unknown,
    Low,
    Medium,
    High,
}

/// Serializable review state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MemoryReviewStorageState {
    pub status: MemoryReviewStorageStatus,
    pub reviewer_ref: Option<String>,
    pub note: Option<String>,
}

impl MemoryReviewStorageState {
    /// Review state does not create accepted memory records.
    pub fn mutates_accepted_memory(&self) -> bool {
        false
    }
}

/// Serializable review status.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryReviewStorageStatus {
    Unreviewed,
    Queued,
    NeedsHumanReview,
    ReviewedForPromotion,
    Rejected,
    Deferred,
}

/// Serializable sensitivity class.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemorySensitivityStorage {
    PublicProject,
    InternalProject,
    UserPrivate,
    SecretAdjacent,
    Restricted,
}

impl MemorySensitivityStorage {
    /// Secret values are never allowed in memory storage payloads.
    pub fn allows_secret_values(&self) -> bool {
        false
    }
}

/// Serializable retention posture.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryRetentionStoragePosture {
    ReviewQueue,
    ProjectContextCandidate,
    LocalOnly,
    Expires { reason: Option<String> },
    Archive,
}

impl MemoryRetentionStoragePosture {
    /// Retention does not grant projection authority.
    pub fn grants_projection_authority(&self) -> bool {
        false
    }
}

/// Serializable proposal-lineage refs.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct MemorySupersessionStorageRefs {
    #[serde(default)]
    pub supersedes: Vec<String>,
    #[serde(default)]
    pub superseded_by: Vec<String>,
}

/// Memory proposal storage codec error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalRecordCodecError {
    pub reason: String,
}

/// Encode a memory proposal storage record as JSON.
pub fn encode_memory_proposal_storage_payload(
    record: &MemoryProposalStorageRecord,
) -> Result<Vec<u8>, MemoryProposalRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

/// Decode a memory proposal storage record from JSON.
pub fn decode_memory_proposal_storage_record(
    bytes: &[u8],
) -> Result<MemoryProposalStorageRecord, MemoryProposalRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

fn codec_error(error: serde_json::Error) -> MemoryProposalRecordCodecError {
    MemoryProposalRecordCodecError {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage_record() -> MemoryProposalStorageRecord {
        MemoryProposalStorageRecord {
            schema_version: MEMORY_STORAGE_SCHEMA_VERSION,
            proposal_id: "memory-proposal:1".to_string(),
            scope: MemoryProposalStorageScope::Project {
                project_ref: "project:nucleus".to_string(),
            },
            kind: MemoryProposalStorageKind::Decision,
            status: MemoryProposalStorageStatus::Proposed,
            title: "Keep memory proposal-only".to_string(),
            summary: "Memory records start as reviewed proposals.".to_string(),
            detail: Some("Accepted memory authority is deferred.".to_string()),
            source_refs: vec![MemorySourceStorageRef {
                kind: MemorySourceStorageKind::PlanningSession,
                source_ref: "planning-session:memory-boundary".to_string(),
                evidence_ref: Some("evidence:boundary-card".to_string()),
            }],
            link_refs: MemoryLinkStorageRefs {
                planning_session_refs: vec!["planning-session:memory-boundary".to_string()],
                exploration_session_refs: vec!["exploration-session:shared-memory".to_string()],
                planning_artifact_refs: vec!["planning-artifact:memory-contract".to_string()],
                task_seed_refs: vec!["task-seed:memory-codec".to_string()],
                research_brief_refs: vec!["research-brief:harness-memory".to_string()],
                task_refs: vec!["task:memory-517".to_string()],
                evidence_refs: vec!["evidence:codec-test".to_string()],
            },
            confidence: MemoryConfidenceStorage::Medium,
            review: MemoryReviewStorageState {
                status: MemoryReviewStorageStatus::NeedsHumanReview,
                reviewer_ref: Some("human:tom".to_string()),
                note: Some("Review before promotion.".to_string()),
            },
            sensitivity: MemorySensitivityStorage::InternalProject,
            retention: MemoryRetentionStoragePosture::ReviewQueue,
            supersession: MemorySupersessionStorageRefs {
                supersedes: vec!["memory-proposal:old".to_string()],
                superseded_by: Vec::new(),
            },
            proposed_at: Some("2026-07-03T00:00:00Z".to_string()),
            updated_at: None,
        }
    }

    #[test]
    fn memory_proposal_storage_codec_round_trips_record() {
        let record = storage_record();

        let encoded = encode_memory_proposal_storage_payload(&record).unwrap();
        let decoded = decode_memory_proposal_storage_record(&encoded).unwrap();

        assert_eq!(decoded, record);
        assert_eq!(decoded.schema_version, MEMORY_STORAGE_SCHEMA_VERSION);
        assert_eq!(decoded.proposal_id, "memory-proposal:1");
        assert_eq!(decoded.source_refs.len(), 1);
        assert_eq!(decoded.link_refs.task_refs, vec!["task:memory-517"]);
    }

    #[test]
    fn storage_links_are_refs_only() {
        let record = storage_record();

        assert!(!record.link_refs.grants_mutation_authority());
        assert!(!record.review.mutates_accepted_memory());
        assert!(!record.retention.grants_projection_authority());
    }

    #[test]
    fn storage_shape_excludes_raw_payload_fields() {
        let encoded =
            String::from_utf8(encode_memory_proposal_storage_payload(&storage_record()).unwrap())
                .unwrap();

        assert!(!encoded.contains("raw_transcript"));
        assert!(!encoded.contains("provider_payload"));
        assert!(!encoded.contains("terminal_stream"));
        assert!(!encoded.contains("credential"));
        assert!(!encoded.contains("secret_value"));
        assert!(!encoded.contains("private_note"));
    }

    #[test]
    fn sensitivity_storage_never_allows_secret_values() {
        let sensitivities = [
            MemorySensitivityStorage::PublicProject,
            MemorySensitivityStorage::InternalProject,
            MemorySensitivityStorage::UserPrivate,
            MemorySensitivityStorage::SecretAdjacent,
            MemorySensitivityStorage::Restricted,
        ];

        assert!(sensitivities
            .iter()
            .all(|sensitivity| !sensitivity.allows_secret_values()));
    }

    #[test]
    fn decode_errors_are_reported() {
        let error = decode_memory_proposal_storage_record(b"{not-json").unwrap_err();

        assert!(!error.reason.is_empty());
    }
}
