//! Memory proposal record vocabulary.
//!
//! Proposals are reviewable evidence. They are not accepted project memory and
//! do not mutate authoritative project context.

use std::time::SystemTime;

use crate::ids::MemoryProposalId;
use crate::refs::MemorySourceRef;
use crate::review::{
    MemoryConfidence, MemoryRetentionPosture, MemoryReviewState, MemorySensitivity,
    MemorySupersessionRefs,
};

/// Reviewable proposed memory record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposal {
    pub id: MemoryProposalId,
    pub scope: MemoryScope,
    pub kind: MemoryKind,
    pub status: MemoryProposalStatus,
    pub title: MemoryProposalTitle,
    pub payload: MemoryProposalPayload,
    pub source_refs: Vec<MemorySourceRef>,
    pub confidence: MemoryConfidence,
    pub review: MemoryReviewState,
    pub sensitivity: MemorySensitivity,
    pub retention: MemoryRetentionPosture,
    pub supersession: MemorySupersessionRefs,
    pub timestamps: MemoryTimestamps,
}

impl MemoryProposal {
    /// Proposal records are evidence only until a separate accepted-memory
    /// authority exists.
    pub fn is_authoritative_memory(&self) -> bool {
        false
    }
}

/// Scope for a memory proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MemoryScope {
    Project(String),
    Task(String),
    AgentSession(String),
    RepoMembership(String),
    Workspace(String),
    UserPrivate,
}

impl MemoryScope {
    /// Scope routes review. It does not grant visibility or projection
    /// authority.
    pub fn grants_visibility_authority(&self) -> bool {
        false
    }
}

/// Memory proposal category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MemoryKind {
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
    Other(String),
}

impl MemoryKind {
    /// Kind is a routing hint. It does not grant projection authority.
    pub fn grants_projection_authority(&self) -> bool {
        false
    }
}

/// Proposal-side status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryProposalStatus {
    Proposed,
    ReviewRequested,
    Rejected,
    Stale,
    Superseded,
    Archived,
}

impl MemoryProposalStatus {
    /// Proposal statuses do not represent accepted project memory.
    pub fn is_accepted_memory(&self) -> bool {
        false
    }
}

/// Human-readable proposal title.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalTitle(pub String);

/// Sanitized proposal payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalPayload {
    pub summary: String,
    pub detail: Option<String>,
}

/// Proposal timestamps where known.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryTimestamps {
    pub proposed_at: Option<SystemTime>,
    pub updated_at: Option<SystemTime>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs::MemorySourceKind;

    fn proposal() -> MemoryProposal {
        MemoryProposal {
            id: MemoryProposalId("memory-proposal:1".to_string()),
            scope: MemoryScope::Project("project:nucleus".to_string()),
            kind: MemoryKind::Decision,
            status: MemoryProposalStatus::Proposed,
            title: MemoryProposalTitle("Keep memory proposal-only".to_string()),
            payload: MemoryProposalPayload {
                summary: "Memory records start as reviewed proposals.".to_string(),
                detail: Some("Accepted memory authority is a later lane.".to_string()),
            },
            source_refs: vec![MemorySourceRef {
                kind: MemorySourceKind::PlanningSession,
                source_ref: "planning-session:memory-boundary".to_string(),
                evidence_ref: Some("evidence:boundary-card".to_string()),
            }],
            confidence: MemoryConfidence::Medium,
            review: MemoryReviewState::default(),
            sensitivity: MemorySensitivity::InternalProject,
            retention: MemoryRetentionPosture::ReviewQueue,
            supersession: MemorySupersessionRefs::empty(),
            timestamps: MemoryTimestamps {
                proposed_at: None,
                updated_at: None,
            },
        }
    }

    #[test]
    fn proposed_memory_is_not_authoritative_memory() {
        let proposal = proposal();

        assert!(!proposal.is_authoritative_memory());
        assert!(!proposal.status.is_accepted_memory());
    }

    #[test]
    fn proposal_statuses_do_not_include_accepted_memory() {
        let statuses = [
            MemoryProposalStatus::Proposed,
            MemoryProposalStatus::ReviewRequested,
            MemoryProposalStatus::Rejected,
            MemoryProposalStatus::Stale,
            MemoryProposalStatus::Superseded,
            MemoryProposalStatus::Archived,
        ];

        assert!(statuses.iter().all(|status| !status.is_accepted_memory()));
    }

    #[test]
    fn scope_and_kind_do_not_grant_authority() {
        let proposal = proposal();

        assert!(!proposal.scope.grants_visibility_authority());
        assert!(!proposal.kind.grants_projection_authority());
    }

    #[test]
    fn source_refs_are_not_memory_identity() {
        let proposal = proposal();
        let source_ref = &proposal.source_refs[0];

        assert_ne!(proposal.id.0, source_ref.source_ref);
        assert_eq!(source_ref.kind, MemorySourceKind::PlanningSession);
    }

    #[test]
    fn proposal_review_state_does_not_mutate_accepted_memory() {
        let mut proposal = proposal();
        proposal.review = MemoryReviewState {
            status: crate::review::MemoryReviewStatus::NeedsHumanReview,
            reviewer_ref: Some("human:tom".to_string()),
            note: Some("Check before promotion.".to_string()),
        };

        assert!(!proposal.review.mutates_accepted_memory());
        assert!(!proposal.is_authoritative_memory());
    }
}
