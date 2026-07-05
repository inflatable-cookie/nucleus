//! Proposal-to-accepted-memory admission rules.
//!
//! Admission is pure. It can prepare an accepted-memory storage record, but it
//! does not write shared memory, projections, embeddings, provider memory, SCM,
//! tasks, or UI state.

use crate::accepted_storage::{
    AcceptedMemoryStorageActors, AcceptedMemoryStorageBody, AcceptedMemoryStorageRecord,
    AcceptedMemoryStorageReview, AcceptedMemoryStorageStatus,
    AcceptedMemorySupersessionStorageRefs, ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
};
use crate::storage_shape::{
    MemoryProposalStorageRecord, MemoryProposalStorageStatus, MemoryReviewStorageStatus,
    MemorySensitivityStorage,
};

/// Accepted-memory admission request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalAcceptanceCommand {
    pub admission_id: String,
    pub memory_id: String,
    pub proposal_id: String,
    pub created_by_ref: String,
    pub accepted_by_ref: String,
    pub accepted_at: Option<String>,
    pub evidence_refs: Vec<String>,
}

/// Admission outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalAcceptanceAdmission {
    pub admission_id: String,
    pub memory_id: String,
    pub proposal_id: String,
    pub status: MemoryProposalAcceptanceAdmissionStatus,
    pub blockers: Vec<MemoryProposalAcceptanceBlocker>,
    pub accepted_record: Option<AcceptedMemoryStorageRecord>,
    pub evidence_refs: Vec<String>,
    pub no_effects: MemoryProposalAcceptanceNoEffects,
}

/// Admission status before persistence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryProposalAcceptanceAdmissionStatus {
    Admitted,
    Blocked,
}

/// Why a proposal cannot be admitted for accepted-memory persistence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MemoryProposalAcceptanceBlocker {
    MissingAdmissionId,
    MissingMemoryId,
    MissingProposalId,
    MissingCreatedByRef,
    MissingAcceptedByRef,
    MissingReviewerRef,
    MissingEvidenceRef,
    ProposalIdMismatch {
        command_proposal_id: String,
        storage_proposal_id: String,
    },
    ProposalNotReviewRequested {
        status: MemoryProposalStorageStatus,
    },
    ProposalNotReviewedForPromotion {
        review_status: MemoryReviewStorageStatus,
    },
    RejectedOrTerminalProposal {
        status: MemoryProposalStorageStatus,
    },
    DeferredReview,
    UserPrivateBlocked,
    RestrictedBlocked,
    SecretAdjacentBlocked,
    EmptyTitle,
    EmptySummary,
}

/// Effects explicitly absent from admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalAcceptanceNoEffects {
    pub shared_memory_written: bool,
    pub projection_written: bool,
    pub embedding_generated: bool,
    pub provider_native_memory_synced: bool,
    pub automatic_extraction_run: bool,
    pub task_mutated: bool,
    pub scm_or_forge_mutated: bool,
    pub ui_triggered: bool,
}

impl MemoryProposalAcceptanceNoEffects {
    pub fn admission_only() -> Self {
        Self {
            shared_memory_written: false,
            projection_written: false,
            embedding_generated: false,
            provider_native_memory_synced: false,
            automatic_extraction_run: false,
            task_mutated: false,
            scm_or_forge_mutated: false,
            ui_triggered: false,
        }
    }
}

/// Admit a reviewed proposal for later accepted-memory persistence.
pub fn admit_memory_proposal_acceptance(
    command: MemoryProposalAcceptanceCommand,
    proposal: &MemoryProposalStorageRecord,
) -> MemoryProposalAcceptanceAdmission {
    let mut blockers = blockers(&command, proposal);
    blockers.sort_by(|left, right| format!("{left:?}").cmp(&format!("{right:?}")));
    blockers.dedup();
    let evidence_refs = evidence_refs(&command, proposal);
    let status = if blockers.is_empty() {
        MemoryProposalAcceptanceAdmissionStatus::Admitted
    } else {
        MemoryProposalAcceptanceAdmissionStatus::Blocked
    };
    let accepted_record = if status == MemoryProposalAcceptanceAdmissionStatus::Admitted {
        Some(accepted_record(&command, proposal))
    } else {
        None
    };

    MemoryProposalAcceptanceAdmission {
        admission_id: command.admission_id,
        memory_id: command.memory_id,
        proposal_id: command.proposal_id,
        status,
        blockers,
        accepted_record,
        evidence_refs,
        no_effects: MemoryProposalAcceptanceNoEffects::admission_only(),
    }
}

fn blockers(
    command: &MemoryProposalAcceptanceCommand,
    proposal: &MemoryProposalStorageRecord,
) -> Vec<MemoryProposalAcceptanceBlocker> {
    let mut blockers = Vec::new();
    required_command_refs(command, &mut blockers);
    proposal_state_blockers(command, proposal, &mut blockers);
    sensitivity_blockers(proposal, &mut blockers);
    payload_blockers(proposal, &mut blockers);
    if evidence_refs(command, proposal).is_empty() {
        blockers.push(MemoryProposalAcceptanceBlocker::MissingEvidenceRef);
    }
    blockers
}

fn required_command_refs(
    command: &MemoryProposalAcceptanceCommand,
    blockers: &mut Vec<MemoryProposalAcceptanceBlocker>,
) {
    if command.admission_id.trim().is_empty() {
        blockers.push(MemoryProposalAcceptanceBlocker::MissingAdmissionId);
    }
    if command.memory_id.trim().is_empty() {
        blockers.push(MemoryProposalAcceptanceBlocker::MissingMemoryId);
    }
    if command.proposal_id.trim().is_empty() {
        blockers.push(MemoryProposalAcceptanceBlocker::MissingProposalId);
    }
    if command.created_by_ref.trim().is_empty() {
        blockers.push(MemoryProposalAcceptanceBlocker::MissingCreatedByRef);
    }
    if command.accepted_by_ref.trim().is_empty() {
        blockers.push(MemoryProposalAcceptanceBlocker::MissingAcceptedByRef);
    }
}

fn proposal_state_blockers(
    command: &MemoryProposalAcceptanceCommand,
    proposal: &MemoryProposalStorageRecord,
    blockers: &mut Vec<MemoryProposalAcceptanceBlocker>,
) {
    if command.proposal_id != proposal.proposal_id {
        blockers.push(MemoryProposalAcceptanceBlocker::ProposalIdMismatch {
            command_proposal_id: command.proposal_id.clone(),
            storage_proposal_id: proposal.proposal_id.clone(),
        });
    }
    if proposal.status != MemoryProposalStorageStatus::ReviewRequested {
        blockers.push(
            MemoryProposalAcceptanceBlocker::ProposalNotReviewRequested {
                status: proposal.status,
            },
        );
    }
    if is_terminal_status(proposal.status) {
        blockers.push(
            MemoryProposalAcceptanceBlocker::RejectedOrTerminalProposal {
                status: proposal.status,
            },
        );
    }
    if proposal.review.status != MemoryReviewStorageStatus::ReviewedForPromotion {
        blockers.push(
            MemoryProposalAcceptanceBlocker::ProposalNotReviewedForPromotion {
                review_status: proposal.review.status,
            },
        );
    }
    if proposal.review.status == MemoryReviewStorageStatus::Deferred {
        blockers.push(MemoryProposalAcceptanceBlocker::DeferredReview);
    }
    if proposal
        .review
        .reviewer_ref
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        blockers.push(MemoryProposalAcceptanceBlocker::MissingReviewerRef);
    }
}

fn sensitivity_blockers(
    proposal: &MemoryProposalStorageRecord,
    blockers: &mut Vec<MemoryProposalAcceptanceBlocker>,
) {
    match proposal.sensitivity {
        MemorySensitivityStorage::PublicProject | MemorySensitivityStorage::InternalProject => {}
        MemorySensitivityStorage::UserPrivate => {
            blockers.push(MemoryProposalAcceptanceBlocker::UserPrivateBlocked);
        }
        MemorySensitivityStorage::Restricted => {
            blockers.push(MemoryProposalAcceptanceBlocker::RestrictedBlocked);
        }
        MemorySensitivityStorage::SecretAdjacent => {
            blockers.push(MemoryProposalAcceptanceBlocker::SecretAdjacentBlocked);
        }
    }
}

fn payload_blockers(
    proposal: &MemoryProposalStorageRecord,
    blockers: &mut Vec<MemoryProposalAcceptanceBlocker>,
) {
    if proposal.title.trim().is_empty() {
        blockers.push(MemoryProposalAcceptanceBlocker::EmptyTitle);
    }
    if proposal.summary.trim().is_empty() {
        blockers.push(MemoryProposalAcceptanceBlocker::EmptySummary);
    }
}

fn evidence_refs(
    command: &MemoryProposalAcceptanceCommand,
    proposal: &MemoryProposalStorageRecord,
) -> Vec<String> {
    let mut refs = command
        .evidence_refs
        .iter()
        .chain(proposal.link_refs.evidence_refs.iter())
        .cloned()
        .collect::<Vec<_>>();
    refs.extend(
        proposal
            .source_refs
            .iter()
            .filter_map(|source| source.evidence_ref.clone()),
    );
    refs.sort();
    refs.dedup();
    refs.retain(|value| !value.trim().is_empty());
    refs
}

fn accepted_record(
    command: &MemoryProposalAcceptanceCommand,
    proposal: &MemoryProposalStorageRecord,
) -> AcceptedMemoryStorageRecord {
    AcceptedMemoryStorageRecord {
        schema_version: ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
        memory_id: command.memory_id.clone(),
        source_proposal_id: Some(proposal.proposal_id.clone()),
        scope: proposal.scope.clone(),
        kind: proposal.kind.clone(),
        status: AcceptedMemoryStorageStatus::Accepted,
        title: proposal.title.clone(),
        body: AcceptedMemoryStorageBody::Summary {
            summary: proposal.summary.clone(),
            detail: proposal.detail.clone(),
        },
        source_refs: proposal.source_refs.clone(),
        link_refs: proposal.link_refs.clone(),
        confidence: proposal.confidence,
        sensitivity: proposal.sensitivity,
        retention: proposal.retention.clone(),
        actors: AcceptedMemoryStorageActors {
            created_by_ref: command.created_by_ref.clone(),
            accepted_by_ref: command.accepted_by_ref.clone(),
        },
        review: AcceptedMemoryStorageReview {
            reviewer_ref: proposal
                .review
                .reviewer_ref
                .clone()
                .expect("validated reviewer ref"),
            note: proposal.review.note.clone(),
        },
        supersession: AcceptedMemorySupersessionStorageRefs {
            supersedes: proposal.supersession.supersedes.clone(),
            superseded_by: proposal.supersession.superseded_by.clone(),
        },
        created_at: proposal.proposed_at.clone(),
        accepted_at: command.accepted_at.clone(),
        updated_at: proposal.updated_at.clone(),
    }
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
