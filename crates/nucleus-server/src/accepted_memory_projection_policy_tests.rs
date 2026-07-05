use nucleus_memory::{
    AcceptedMemoryStorageActors, AcceptedMemoryStorageBody, AcceptedMemoryStorageRecord,
    AcceptedMemoryStorageReview, AcceptedMemoryStorageStatus,
    AcceptedMemorySupersessionStorageRefs, MemoryConfidenceStorage, MemoryLinkStorageRefs,
    MemoryProposalStorageKind, MemoryProposalStorageScope, MemoryRetentionStoragePosture,
    MemorySensitivityStorage, ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_policy::{
    accepted_memory_projection_policy_decision, AcceptedMemoryPolicyStatus,
    AcceptedMemoryProjectionPolicyBlocker, AcceptedMemoryProjectionPolicyStatus,
};

#[test]
fn project_memory_with_review_evidence_is_projectable_without_effects() {
    let decision = accepted_memory_projection_policy_decision(
        &ProjectId("project:nucleus".to_owned()),
        &accepted_memory("memory:projectable"),
    );

    assert_eq!(
        decision.status,
        AcceptedMemoryProjectionPolicyStatus::Projectable
    );
    assert!(decision.blockers.is_empty());
    assert_eq!(decision.memory_id, "memory:projectable");
    assert!(!decision.client_can_write_projection);
    assert!(!decision.projection_write_performed);
    assert!(!decision.scm_effect_available);
}

#[test]
fn private_and_local_only_memory_remains_local_only() {
    let mut memory = accepted_memory("memory:local");
    memory.scope = MemoryProposalStorageScope::UserPrivate;
    memory.sensitivity = MemorySensitivityStorage::UserPrivate;
    memory.retention = MemoryRetentionStoragePosture::LocalOnly;

    let decision = accepted_memory_projection_policy_decision(
        &ProjectId("project:nucleus".to_owned()),
        &memory,
    );

    assert_eq!(
        decision.status,
        AcceptedMemoryProjectionPolicyStatus::LocalOnly
    );
    assert!(decision
        .blockers
        .contains(&AcceptedMemoryProjectionPolicyBlocker::UserPrivateScope));
    assert!(decision
        .blockers
        .contains(&AcceptedMemoryProjectionPolicyBlocker::UserPrivateSensitivity));
    assert!(decision
        .blockers
        .contains(&AcceptedMemoryProjectionPolicyBlocker::LocalOnlyRetention));
}

#[test]
fn secret_adjacent_and_missing_review_memory_requires_review() {
    let mut memory = accepted_memory("memory:review-required");
    memory.sensitivity = MemorySensitivityStorage::SecretAdjacent;
    memory.review.reviewer_ref.clear();
    memory.accepted_at = None;

    let decision = accepted_memory_projection_policy_decision(
        &ProjectId("project:nucleus".to_owned()),
        &memory,
    );

    assert_eq!(
        decision.status,
        AcceptedMemoryProjectionPolicyStatus::ReviewRequired
    );
    assert!(decision
        .blockers
        .contains(&AcceptedMemoryProjectionPolicyBlocker::SecretAdjacentSensitivity));
    assert!(decision
        .blockers
        .contains(&AcceptedMemoryProjectionPolicyBlocker::MissingReviewEvidence));
}

#[test]
fn stale_superseded_archived_and_restricted_memory_are_blocked() {
    let mut stale = accepted_memory("memory:stale");
    stale.status = AcceptedMemoryStorageStatus::Stale;

    let mut superseded = accepted_memory("memory:superseded");
    superseded.status = AcceptedMemoryStorageStatus::Superseded;
    superseded.supersession.superseded_by = vec!["memory:new".to_owned()];

    let mut archived = accepted_memory("memory:archived");
    archived.status = AcceptedMemoryStorageStatus::Archived;

    let mut restricted = accepted_memory("memory:restricted");
    restricted.sensitivity = MemorySensitivityStorage::Restricted;

    for (memory, expected) in [
        (stale, AcceptedMemoryPolicyStatus::Stale),
        (superseded, AcceptedMemoryPolicyStatus::Superseded),
        (archived, AcceptedMemoryPolicyStatus::Archived),
    ] {
        let decision = accepted_memory_projection_policy_decision(
            &ProjectId("project:nucleus".to_owned()),
            &memory,
        );

        assert_eq!(
            decision.status,
            AcceptedMemoryProjectionPolicyStatus::Blocked
        );
        assert!(decision.blockers.contains(
            &AcceptedMemoryProjectionPolicyBlocker::NonAcceptedStatus { status: expected }
        ));
    }

    let restricted_decision = accepted_memory_projection_policy_decision(
        &ProjectId("project:nucleus".to_owned()),
        &restricted,
    );
    assert_eq!(
        restricted_decision.status,
        AcceptedMemoryProjectionPolicyStatus::Blocked
    );
    assert!(restricted_decision
        .blockers
        .contains(&AcceptedMemoryProjectionPolicyBlocker::RestrictedSensitivity));
}

#[test]
fn non_project_scope_and_out_of_scope_project_are_not_projectable() {
    let mut task_scoped = accepted_memory("memory:task");
    task_scoped.scope = MemoryProposalStorageScope::Task {
        task_ref: "task:1".to_owned(),
    };

    let mut out_of_scope = accepted_memory("memory:other-project");
    out_of_scope.scope = MemoryProposalStorageScope::Project {
        project_ref: "project:other".to_owned(),
    };

    let task_decision = accepted_memory_projection_policy_decision(
        &ProjectId("project:nucleus".to_owned()),
        &task_scoped,
    );
    assert_eq!(
        task_decision.status,
        AcceptedMemoryProjectionPolicyStatus::ReviewRequired
    );
    assert!(task_decision
        .blockers
        .contains(&AcceptedMemoryProjectionPolicyBlocker::MissingProjectScope));

    let other_decision = accepted_memory_projection_policy_decision(
        &ProjectId("project:nucleus".to_owned()),
        &out_of_scope,
    );
    assert_eq!(
        other_decision.status,
        AcceptedMemoryProjectionPolicyStatus::Blocked
    );
    assert!(other_decision.blockers.contains(
        &AcceptedMemoryProjectionPolicyBlocker::OutOfScopeProject {
            project_ref: "project:other".to_owned()
        }
    ));
}

#[test]
fn unsafe_memory_ids_are_blocked_before_path_derivation() {
    let decision = accepted_memory_projection_policy_decision(
        &ProjectId("project:nucleus".to_owned()),
        &accepted_memory("../memory:bad"),
    );

    assert_eq!(
        decision.status,
        AcceptedMemoryProjectionPolicyStatus::Blocked
    );
    assert!(matches!(
        decision.blockers.as_slice(),
        [AcceptedMemoryProjectionPolicyBlocker::UnsafeExportIntent { .. }]
    ));
}

fn accepted_memory(memory_id: &str) -> AcceptedMemoryStorageRecord {
    AcceptedMemoryStorageRecord {
        schema_version: ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
        memory_id: memory_id.to_owned(),
        source_proposal_id: Some("memory-proposal:1".to_owned()),
        scope: MemoryProposalStorageScope::Project {
            project_ref: "project:nucleus".to_owned(),
        },
        kind: MemoryProposalStorageKind::Decision,
        status: AcceptedMemoryStorageStatus::Accepted,
        title: "Hidden accepted memory title".to_owned(),
        body: AcceptedMemoryStorageBody::Summary {
            summary: "Hidden accepted memory summary".to_owned(),
            detail: None,
        },
        source_refs: Vec::new(),
        link_refs: MemoryLinkStorageRefs::default(),
        confidence: MemoryConfidenceStorage::High,
        sensitivity: MemorySensitivityStorage::InternalProject,
        retention: MemoryRetentionStoragePosture::ProjectContextCandidate,
        actors: AcceptedMemoryStorageActors {
            created_by_ref: "agent:steward".to_owned(),
            accepted_by_ref: "operator:tom".to_owned(),
        },
        review: AcceptedMemoryStorageReview {
            reviewer_ref: "operator:tom".to_owned(),
            note: Some("Reviewed for projection policy.".to_owned()),
        },
        supersession: AcceptedMemorySupersessionStorageRefs::default(),
        created_at: Some("2026-07-05T00:00:00Z".to_owned()),
        accepted_at: Some("2026-07-05T00:00:00Z".to_owned()),
        updated_at: None,
    }
}
