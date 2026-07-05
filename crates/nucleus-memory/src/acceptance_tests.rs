use crate::storage_shape::{
    MemoryConfidenceStorage, MemoryLinkStorageRefs, MemoryProposalStorageKind,
    MemoryProposalStorageRecord, MemoryProposalStorageScope, MemoryProposalStorageStatus,
    MemoryRetentionStoragePosture, MemoryReviewStorageState, MemoryReviewStorageStatus,
    MemorySensitivityStorage, MemorySourceStorageKind, MemorySourceStorageRef,
    MemorySupersessionStorageRefs, MEMORY_STORAGE_SCHEMA_VERSION,
};
use crate::{
    admit_memory_proposal_acceptance, MemoryProposalAcceptanceAdmissionStatus,
    MemoryProposalAcceptanceBlocker, MemoryProposalAcceptanceCommand,
    MemoryProposalAcceptanceNoEffects,
};

#[test]
fn reviewed_proposal_is_admitted_without_effects() {
    let admission = admit_memory_proposal_acceptance(command(), &proposal());

    assert_eq!(
        admission.status,
        MemoryProposalAcceptanceAdmissionStatus::Admitted
    );
    assert!(admission.blockers.is_empty());
    assert_eq!(
        admission.no_effects,
        MemoryProposalAcceptanceNoEffects::admission_only()
    );
    let record = admission.accepted_record.expect("accepted record");
    assert_eq!(record.memory_id, "memory:1");
    assert_eq!(
        record.source_proposal_id.as_deref(),
        Some("memory-proposal:1")
    );
    assert_eq!(record.review.reviewer_ref, "operator:tom");
}

#[test]
fn non_reviewed_proposal_is_blocked() {
    let mut proposal = proposal();
    proposal.review.status = MemoryReviewStorageStatus::Queued;

    let admission = admit_memory_proposal_acceptance(command(), &proposal);

    assert_eq!(
        admission.status,
        MemoryProposalAcceptanceAdmissionStatus::Blocked
    );
    assert!(admission.blockers.contains(
        &MemoryProposalAcceptanceBlocker::ProposalNotReviewedForPromotion {
            review_status: MemoryReviewStorageStatus::Queued
        }
    ));
    assert!(admission.accepted_record.is_none());
}

#[test]
fn private_restricted_and_secret_adjacent_proposals_are_blocked() {
    for (sensitivity, expected) in [
        (
            MemorySensitivityStorage::UserPrivate,
            MemoryProposalAcceptanceBlocker::UserPrivateBlocked,
        ),
        (
            MemorySensitivityStorage::Restricted,
            MemoryProposalAcceptanceBlocker::RestrictedBlocked,
        ),
        (
            MemorySensitivityStorage::SecretAdjacent,
            MemoryProposalAcceptanceBlocker::SecretAdjacentBlocked,
        ),
    ] {
        let mut proposal = proposal();
        proposal.sensitivity = sensitivity;

        let admission = admit_memory_proposal_acceptance(command(), &proposal);

        assert_eq!(
            admission.status,
            MemoryProposalAcceptanceAdmissionStatus::Blocked
        );
        assert!(admission.blockers.contains(&expected));
        assert!(admission.accepted_record.is_none());
    }
}

#[test]
fn admission_requires_sanitized_evidence_refs() {
    let mut proposal = proposal();
    proposal.source_refs[0].evidence_ref = None;
    proposal.link_refs.evidence_refs.clear();
    let mut command = command();
    command.evidence_refs.clear();

    let admission = admit_memory_proposal_acceptance(command, &proposal);

    assert_eq!(
        admission.status,
        MemoryProposalAcceptanceAdmissionStatus::Blocked
    );
    assert!(admission
        .blockers
        .contains(&MemoryProposalAcceptanceBlocker::MissingEvidenceRef));
}

fn command() -> MemoryProposalAcceptanceCommand {
    MemoryProposalAcceptanceCommand {
        admission_id: "memory-acceptance:1".to_owned(),
        memory_id: "memory:1".to_owned(),
        proposal_id: "memory-proposal:1".to_owned(),
        created_by_ref: "agent:steward".to_owned(),
        accepted_by_ref: "operator:tom".to_owned(),
        accepted_at: Some("2026-07-05T00:00:00Z".to_owned()),
        evidence_refs: vec!["evidence:operator-acceptance".to_owned()],
    }
}

fn proposal() -> MemoryProposalStorageRecord {
    MemoryProposalStorageRecord {
        schema_version: MEMORY_STORAGE_SCHEMA_VERSION,
        proposal_id: "memory-proposal:1".to_owned(),
        scope: MemoryProposalStorageScope::Project {
            project_ref: "project:nucleus".to_owned(),
        },
        kind: MemoryProposalStorageKind::Decision,
        status: MemoryProposalStorageStatus::ReviewRequested,
        title: "Use accepted memory".to_owned(),
        summary: "Accepted memory is server-owned project context.".to_owned(),
        detail: Some("Proposal id is retained as evidence only.".to_owned()),
        source_refs: vec![MemorySourceStorageRef {
            kind: MemorySourceStorageKind::PlanningArtifact,
            source_ref: "artifact:memory-boundary".to_owned(),
            evidence_ref: Some("evidence:planning-artifact".to_owned()),
        }],
        link_refs: MemoryLinkStorageRefs {
            planning_session_refs: Vec::new(),
            exploration_session_refs: Vec::new(),
            planning_artifact_refs: vec!["artifact:memory-boundary".to_owned()],
            task_seed_refs: Vec::new(),
            research_brief_refs: Vec::new(),
            task_refs: Vec::new(),
            evidence_refs: vec!["evidence:reviewed".to_owned()],
        },
        confidence: MemoryConfidenceStorage::High,
        review: MemoryReviewStorageState {
            status: MemoryReviewStorageStatus::ReviewedForPromotion,
            reviewer_ref: Some("operator:tom".to_owned()),
            note: Some("Ready for accepted memory.".to_owned()),
        },
        sensitivity: MemorySensitivityStorage::InternalProject,
        retention: MemoryRetentionStoragePosture::ProjectContextCandidate,
        supersession: MemorySupersessionStorageRefs {
            supersedes: Vec::new(),
            superseded_by: Vec::new(),
        },
        proposed_at: Some("2026-07-05T00:00:00Z".to_owned()),
        updated_at: None,
    }
}
