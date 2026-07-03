//! Pure memory proposal review command rules.
//!
//! Reviewing a proposal mutates proposal metadata only. It does not create an
//! accepted memory record, write projections, sync provider-native memory, or
//! run embeddings.

use nucleus_core::RevisionId;
use nucleus_memory::{
    MemoryProposalStorageRecord, MemoryProposalStorageStatus, MemoryReviewStorageStatus,
};

/// Operator-visible review actions for memory proposals.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryProposalReviewAction {
    Queue,
    Defer,
    Reject,
    MarkReviewedForPromotion,
}

/// Proposed review command before storage is touched.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalReviewCommand {
    pub command_id: String,
    pub proposal_id: String,
    pub expected_revision: RevisionId,
    pub action: MemoryProposalReviewAction,
    pub reviewer_ref: Option<String>,
    pub note: Option<String>,
}

/// Review command admission result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MemoryProposalReviewDecision {
    Admitted(MemoryProposalReviewAdmission),
    Rejected(MemoryProposalReviewRejection),
}

/// Accepted review mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalReviewAdmission {
    pub command_id: String,
    pub proposal_id: String,
    pub expected_revision: RevisionId,
    pub next_proposal_status: MemoryProposalStorageStatus,
    pub next_review_status: MemoryReviewStorageStatus,
    pub reviewer_ref: Option<String>,
    pub note: Option<String>,
    pub no_effects: MemoryProposalReviewNoEffects,
}

/// Effects explicitly outside this command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalReviewNoEffects {
    pub accepted_memory_created: bool,
    pub projection_written: bool,
    pub embedding_generated: bool,
    pub provider_native_memory_synced: bool,
    pub automatic_extraction_run: bool,
}

impl MemoryProposalReviewNoEffects {
    pub fn proposal_only() -> Self {
        Self {
            accepted_memory_created: false,
            projection_written: false,
            embedding_generated: false,
            provider_native_memory_synced: false,
            automatic_extraction_run: false,
        }
    }
}

/// Why a memory proposal review command cannot run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MemoryProposalReviewRejection {
    EmptyCommandId,
    EmptyProposalId,
    EmptyExpectedRevision,
    EmptyReviewerRef,
    EmptyNote,
    ProposalIdMismatch {
        command_proposal_id: String,
        storage_proposal_id: String,
    },
    TerminalProposalStatus {
        status: MemoryProposalStorageStatus,
    },
}

/// Admit one proposal review command against an existing storage record.
pub fn admit_memory_proposal_review(
    command: MemoryProposalReviewCommand,
    proposal: &MemoryProposalStorageRecord,
) -> MemoryProposalReviewDecision {
    if command.command_id.trim().is_empty() {
        return MemoryProposalReviewDecision::Rejected(
            MemoryProposalReviewRejection::EmptyCommandId,
        );
    }
    if command.proposal_id.trim().is_empty() {
        return MemoryProposalReviewDecision::Rejected(
            MemoryProposalReviewRejection::EmptyProposalId,
        );
    }
    if command.expected_revision.0.trim().is_empty() {
        return MemoryProposalReviewDecision::Rejected(
            MemoryProposalReviewRejection::EmptyExpectedRevision,
        );
    }
    if matches!(command.reviewer_ref.as_deref(), Some(value) if value.trim().is_empty()) {
        return MemoryProposalReviewDecision::Rejected(
            MemoryProposalReviewRejection::EmptyReviewerRef,
        );
    }
    if matches!(command.note.as_deref(), Some(value) if value.trim().is_empty()) {
        return MemoryProposalReviewDecision::Rejected(MemoryProposalReviewRejection::EmptyNote);
    }
    if command.proposal_id != proposal.proposal_id {
        return MemoryProposalReviewDecision::Rejected(
            MemoryProposalReviewRejection::ProposalIdMismatch {
                command_proposal_id: command.proposal_id,
                storage_proposal_id: proposal.proposal_id.clone(),
            },
        );
    }
    if is_terminal_status(proposal.status) {
        return MemoryProposalReviewDecision::Rejected(
            MemoryProposalReviewRejection::TerminalProposalStatus {
                status: proposal.status,
            },
        );
    }

    let (next_proposal_status, next_review_status) = match command.action {
        MemoryProposalReviewAction::Queue => (
            MemoryProposalStorageStatus::ReviewRequested,
            MemoryReviewStorageStatus::Queued,
        ),
        MemoryProposalReviewAction::Defer => (
            MemoryProposalStorageStatus::Proposed,
            MemoryReviewStorageStatus::Deferred,
        ),
        MemoryProposalReviewAction::Reject => (
            MemoryProposalStorageStatus::Rejected,
            MemoryReviewStorageStatus::Rejected,
        ),
        MemoryProposalReviewAction::MarkReviewedForPromotion => (
            MemoryProposalStorageStatus::ReviewRequested,
            MemoryReviewStorageStatus::ReviewedForPromotion,
        ),
    };

    MemoryProposalReviewDecision::Admitted(MemoryProposalReviewAdmission {
        command_id: command.command_id,
        proposal_id: command.proposal_id,
        expected_revision: command.expected_revision,
        next_proposal_status,
        next_review_status,
        reviewer_ref: command.reviewer_ref,
        note: command.note,
        no_effects: MemoryProposalReviewNoEffects::proposal_only(),
    })
}

fn is_terminal_status(status: MemoryProposalStorageStatus) -> bool {
    matches!(
        status,
        MemoryProposalStorageStatus::Rejected
            | MemoryProposalStorageStatus::Stale
            | MemoryProposalStorageStatus::Superseded
            | MemoryProposalStorageStatus::Archived
    )
}

#[cfg(test)]
mod tests {
    use nucleus_memory::{
        MemoryConfidenceStorage, MemoryLinkStorageRefs, MemoryProposalStorageKind,
        MemoryProposalStorageScope, MemoryRetentionStoragePosture, MemoryReviewStorageState,
        MemorySensitivityStorage, MemorySourceStorageKind, MemorySourceStorageRef,
        MemorySupersessionStorageRefs, MEMORY_STORAGE_SCHEMA_VERSION,
    };

    use super::*;

    #[test]
    fn reviewed_for_promotion_is_proposal_only() {
        let decision = admit_memory_proposal_review(
            MemoryProposalReviewCommand {
                command_id: "command:memory:review".to_owned(),
                proposal_id: "memory-proposal:1".to_owned(),
                expected_revision: RevisionId("rev:memory-proposal:1".to_owned()),
                action: MemoryProposalReviewAction::MarkReviewedForPromotion,
                reviewer_ref: Some("user:tom".to_owned()),
                note: Some("Looks useful once accepted-memory authority exists.".to_owned()),
            },
            &proposal(MemoryProposalStorageStatus::Proposed),
        );

        let MemoryProposalReviewDecision::Admitted(admission) = decision else {
            panic!("expected admission");
        };

        assert_eq!(
            admission.next_proposal_status,
            MemoryProposalStorageStatus::ReviewRequested
        );
        assert_eq!(
            admission.next_review_status,
            MemoryReviewStorageStatus::ReviewedForPromotion
        );
        assert_eq!(admission.reviewer_ref, Some("user:tom".to_owned()));
        assert_eq!(
            admission.no_effects,
            MemoryProposalReviewNoEffects::proposal_only()
        );
    }

    #[test]
    fn terminal_proposals_cannot_be_reviewed_again() {
        let decision = admit_memory_proposal_review(
            MemoryProposalReviewCommand {
                command_id: "command:memory:review".to_owned(),
                proposal_id: "memory-proposal:1".to_owned(),
                expected_revision: RevisionId("rev:memory-proposal:1".to_owned()),
                action: MemoryProposalReviewAction::Queue,
                reviewer_ref: None,
                note: None,
            },
            &proposal(MemoryProposalStorageStatus::Archived),
        );

        assert_eq!(
            decision,
            MemoryProposalReviewDecision::Rejected(
                MemoryProposalReviewRejection::TerminalProposalStatus {
                    status: MemoryProposalStorageStatus::Archived,
                }
            )
        );
    }

    fn proposal(status: MemoryProposalStorageStatus) -> MemoryProposalStorageRecord {
        MemoryProposalStorageRecord {
            schema_version: MEMORY_STORAGE_SCHEMA_VERSION,
            proposal_id: "memory-proposal:1".to_owned(),
            scope: MemoryProposalStorageScope::Project {
                project_ref: "project:nucleus".to_owned(),
            },
            kind: MemoryProposalStorageKind::Decision,
            status,
            title: "Remember review boundary".to_owned(),
            summary: "Review updates proposal metadata only.".to_owned(),
            detail: None,
            source_refs: vec![MemorySourceStorageRef {
                kind: MemorySourceStorageKind::PlanningSession,
                source_ref: "planning-session:memory".to_owned(),
                evidence_ref: None,
            }],
            link_refs: MemoryLinkStorageRefs::default(),
            confidence: MemoryConfidenceStorage::Medium,
            review: MemoryReviewStorageState {
                status: MemoryReviewStorageStatus::NeedsHumanReview,
                reviewer_ref: None,
                note: None,
            },
            sensitivity: MemorySensitivityStorage::InternalProject,
            retention: MemoryRetentionStoragePosture::ReviewQueue,
            supersession: MemorySupersessionStorageRefs::default(),
            proposed_at: None,
            updated_at: None,
        }
    }
}
