//! Review, sensitivity, confidence, and retention vocabulary.
//!
//! This module will hold policy-facing value records. It must not store
//! secrets, raw transcripts, provider payloads, raw terminal streams, or
//! private notes by default.

use crate::ids::MemoryProposalId;

/// Confidence signal attached to a proposed memory.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryConfidence {
    Unknown,
    Low,
    Medium,
    High,
}

/// Review state for a memory proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryReviewState {
    pub status: MemoryReviewStatus,
    pub reviewer_ref: Option<String>,
    pub note: Option<String>,
}

impl Default for MemoryReviewState {
    fn default() -> Self {
        Self {
            status: MemoryReviewStatus::Unreviewed,
            reviewer_ref: None,
            note: None,
        }
    }
}

impl MemoryReviewState {
    /// Review state can recommend follow-up, but it does not create accepted
    /// memory records.
    pub fn mutates_accepted_memory(&self) -> bool {
        false
    }
}

/// Review queue status for a memory proposal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryReviewStatus {
    Unreviewed,
    Queued,
    NeedsHumanReview,
    ReviewedForPromotion,
    Rejected,
    Deferred,
}

/// Sensitivity class for a memory proposal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemorySensitivity {
    PublicProject,
    InternalProject,
    UserPrivate,
    SecretAdjacent,
    Restricted,
}

impl MemorySensitivity {
    /// Secret material is never stored as memory payload.
    pub fn allows_secret_values(&self) -> bool {
        false
    }

    /// User-private and restricted proposal records are not shared project
    /// context by default.
    pub fn is_project_shared_by_default(&self) -> bool {
        matches!(
            self,
            MemorySensitivity::PublicProject | MemorySensitivity::InternalProject
        )
    }

    /// Secret-adjacent proposals may retain sanitized context only.
    pub fn requires_sanitized_summary_only(&self) -> bool {
        matches!(self, MemorySensitivity::SecretAdjacent)
    }
}

/// Retention posture for a memory proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MemoryRetentionPosture {
    ReviewQueue,
    ProjectContextCandidate,
    LocalOnly,
    Expires { reason: Option<String> },
    Archive,
}

impl MemoryRetentionPosture {
    /// Retention posture does not grant projection authority.
    pub fn grants_projection_authority(&self) -> bool {
        false
    }
}

/// Supersession links between memory proposals.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemorySupersessionRefs {
    pub supersedes: Vec<MemoryProposalId>,
    pub superseded_by: Vec<MemoryProposalId>,
}

impl MemorySupersessionRefs {
    /// Empty supersession refs for a proposal with no replacement lineage.
    pub fn empty() -> Self {
        Self {
            supersedes: Vec::new(),
            superseded_by: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_restricted_memory_are_not_shared_by_default() {
        assert!(!MemorySensitivity::UserPrivate.is_project_shared_by_default());
        assert!(!MemorySensitivity::Restricted.is_project_shared_by_default());
        assert!(MemorySensitivity::InternalProject.is_project_shared_by_default());
    }

    #[test]
    fn secret_adjacent_memory_requires_sanitized_summary_only() {
        assert!(MemorySensitivity::SecretAdjacent.requires_sanitized_summary_only());
        assert!(!MemorySensitivity::SecretAdjacent.allows_secret_values());
    }

    #[test]
    fn retention_does_not_grant_projection_authority() {
        let retentions = [
            MemoryRetentionPosture::ReviewQueue,
            MemoryRetentionPosture::ProjectContextCandidate,
            MemoryRetentionPosture::LocalOnly,
            MemoryRetentionPosture::Expires {
                reason: Some("short-lived review note".to_string()),
            },
            MemoryRetentionPosture::Archive,
        ];

        assert!(retentions
            .iter()
            .all(|retention| !retention.grants_projection_authority()));
    }

    #[test]
    fn supersession_refs_are_memory_proposal_lineage_only() {
        let refs = MemorySupersessionRefs {
            supersedes: vec![MemoryProposalId("memory-proposal:old".to_string())],
            superseded_by: vec![MemoryProposalId("memory-proposal:new".to_string())],
        };

        assert_eq!(refs.supersedes[0].0, "memory-proposal:old");
        assert_eq!(refs.superseded_by[0].0, "memory-proposal:new");
    }

    #[test]
    fn review_state_does_not_mutate_accepted_memory() {
        let review = MemoryReviewState {
            status: MemoryReviewStatus::ReviewedForPromotion,
            reviewer_ref: Some("human:reviewer".to_string()),
            note: Some("Ready for a future acceptance command.".to_string()),
        };

        assert!(!review.mutates_accepted_memory());
    }
}
