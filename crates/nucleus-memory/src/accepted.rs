//! Accepted shared memory domain vocabulary.
//!
//! Accepted memory is server-owned project context. It is separate from
//! proposal records and does not imply projection, embedding, search, provider
//! sync, or UI authority.

use std::time::SystemTime;

use crate::ids::{MemoryId, MemoryProposalId};
use crate::proposals::{MemoryKind, MemoryScope, MemoryTimestamps};
use crate::refs::{MemoryLinkRefs, MemorySourceRef};
use crate::review::{
    MemoryConfidence, MemoryRetentionPosture, MemorySensitivity, MemorySupersessionRefs,
};

/// Authoritative accepted memory record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemory {
    pub id: MemoryId,
    pub source_proposal_id: Option<MemoryProposalId>,
    pub scope: MemoryScope,
    pub kind: MemoryKind,
    pub status: AcceptedMemoryStatus,
    pub title: String,
    pub body: AcceptedMemoryBody,
    pub source_refs: Vec<MemorySourceRef>,
    pub link_refs: MemoryLinkRefs,
    pub confidence: MemoryConfidence,
    pub sensitivity: MemorySensitivity,
    pub retention: MemoryRetentionPosture,
    pub actors: AcceptedMemoryActors,
    pub review: AcceptedMemoryReview,
    pub supersession: MemorySupersessionRefs,
    pub timestamps: MemoryTimestamps,
}

impl AcceptedMemory {
    /// Accepted memory is authoritative server context.
    pub fn is_authoritative_memory(&self) -> bool {
        true
    }
}

/// Accepted-memory lifecycle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryStatus {
    Accepted,
    Stale,
    Superseded,
    Archived,
}

impl AcceptedMemoryStatus {
    /// Accepted-memory statuses are never proposal-side statuses.
    pub fn is_proposal_status(&self) -> bool {
        false
    }
}

/// Sanitized accepted-memory body.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryBody {
    Summary {
        summary: String,
        detail: Option<String>,
    },
    StructuredRef {
        ref_id: String,
        summary: String,
    },
}

/// Actor refs recorded with accepted memory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryActors {
    pub created_by_ref: String,
    pub accepted_by_ref: String,
}

/// Review evidence for accepted memory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryReview {
    pub reviewer_ref: String,
    pub note: Option<String>,
}

/// Accepted-memory timestamps where known.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryTimestamps {
    pub created_at: Option<SystemTime>,
    pub accepted_at: Option<SystemTime>,
    pub updated_at: Option<SystemTime>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs::MemorySourceKind;

    #[test]
    fn accepted_memory_is_authoritative_but_not_projection_authority() {
        let memory = AcceptedMemory {
            id: MemoryId("memory:1".to_string()),
            source_proposal_id: Some(MemoryProposalId("memory-proposal:1".to_string())),
            scope: MemoryScope::Project("project:nucleus".to_string()),
            kind: MemoryKind::Decision,
            status: AcceptedMemoryStatus::Accepted,
            title: "Use server-owned memory".to_string(),
            body: AcceptedMemoryBody::Summary {
                summary: "Accepted memory is server-owned context.".to_string(),
                detail: None,
            },
            source_refs: vec![MemorySourceRef {
                kind: MemorySourceKind::PlanningArtifact,
                source_ref: "artifact:memory-boundary".to_string(),
                evidence_ref: Some("evidence:review".to_string()),
            }],
            link_refs: MemoryLinkRefs::empty(),
            confidence: MemoryConfidence::High,
            sensitivity: MemorySensitivity::InternalProject,
            retention: MemoryRetentionPosture::ProjectContextCandidate,
            actors: AcceptedMemoryActors {
                created_by_ref: "agent:steward".to_string(),
                accepted_by_ref: "operator:tom".to_string(),
            },
            review: AcceptedMemoryReview {
                reviewer_ref: "operator:tom".to_string(),
                note: Some("Reviewed for promotion.".to_string()),
            },
            supersession: MemorySupersessionRefs::empty(),
            timestamps: MemoryTimestamps {
                proposed_at: None,
                updated_at: None,
            },
        };

        assert!(memory.is_authoritative_memory());
        assert!(!memory.status.is_proposal_status());
        assert!(!memory.retention.grants_projection_authority());
    }
}
