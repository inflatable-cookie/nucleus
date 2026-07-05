use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation};
use nucleus_memory::{
    admit_memory_proposal_acceptance, decode_accepted_memory_storage_record,
    encode_accepted_memory_storage_payload, AcceptedMemoryStorageRecord, MemoryConfidenceStorage,
    MemoryLinkStorageRefs, MemoryProposalAcceptanceCommand, MemoryProposalStorageKind,
    MemoryProposalStorageRecord, MemoryProposalStorageScope, MemoryProposalStorageStatus,
    MemoryRetentionStoragePosture, MemoryReviewStorageState, MemoryReviewStorageStatus,
    MemorySensitivityStorage, MemorySourceStorageKind, MemorySourceStorageRef,
    MemorySupersessionStorageRefs, MEMORY_STORAGE_SCHEMA_VERSION,
};

use crate::accepted_memory_persistence::{
    persist_accepted_memory_admission, AcceptedMemoryPersistenceNoEffects,
    AcceptedMemoryPersistenceStatus,
};
use crate::state::ServerStateService;
use crate::ServerControlError;

#[test]
fn admitted_memory_persists_with_sanitized_receipt() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(nucleus_local_store::SqliteBackend::new(
        temp_dir.path().join("nucleus.sqlite"),
    ));

    let receipt = persist_accepted_memory_admission(
        &state,
        admit_memory_proposal_acceptance(command(), &proposal()),
    )
    .expect("persist accepted memory");

    assert_eq!(receipt.status, AcceptedMemoryPersistenceStatus::Persisted);
    assert_eq!(
        receipt.record_id,
        Some(PersistenceRecordId("memory:1".to_owned()))
    );
    assert_eq!(
        receipt.revision_id,
        Some(RevisionId(
            "rev:accepted-memory:memory-acceptance:1".to_owned()
        ))
    );
    assert_eq!(receipt.accepted_by_ref, Some("operator:tom".to_owned()));
    assert_eq!(receipt.reviewer_ref, Some("operator:tom".to_owned()));
    assert_eq!(receipt.source_ref_count, 1);
    assert_eq!(receipt.link_ref_count, 2);
    assert_eq!(receipt.sensitivity, Some("InternalProject".to_owned()));
    assert!(format!("{receipt:?}").contains("ProjectContextCandidate"));
    assert!(!format!("{receipt:?}").contains("Accepted memory is server-owned"));
    assert_eq!(
        receipt.no_effects,
        AcceptedMemoryPersistenceNoEffects::persisted_only()
    );

    let stored = state
        .shared_memory()
        .get(&PersistenceRecordId("memory:1".to_owned()))
        .expect("get accepted memory")
        .expect("accepted memory exists");
    let accepted =
        decode_accepted_memory_storage_record(&stored.payload.bytes).expect("decode accepted");

    assert_eq!(stored.kind, PersistenceRecordKind::SharedMemoryRecord);
    assert_eq!(accepted.memory_id, "memory:1");
    assert_eq!(
        accepted.source_proposal_id.as_deref(),
        Some("memory-proposal:1")
    );
}

#[test]
fn blocked_admission_does_not_mutate_shared_memory() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(nucleus_local_store::SqliteBackend::new(
        temp_dir.path().join("nucleus.sqlite"),
    ));
    let mut proposal = proposal();
    proposal.review.status = MemoryReviewStorageStatus::Queued;

    let receipt = persist_accepted_memory_admission(
        &state,
        admit_memory_proposal_acceptance(command(), &proposal),
    )
    .expect("blocked receipt");

    assert_eq!(receipt.status, AcceptedMemoryPersistenceStatus::Blocked);
    assert_eq!(
        receipt.no_effects,
        AcceptedMemoryPersistenceNoEffects::blocked_without_mutation()
    );
    assert_eq!(state.shared_memory().list().expect("list").len(), 0);
}

#[test]
fn existing_memory_id_rejects_create_only_revision_expectation() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(nucleus_local_store::SqliteBackend::new(
        temp_dir.path().join("nucleus.sqlite"),
    ));
    let admission = admit_memory_proposal_acceptance(command(), &proposal());
    let existing = admission.accepted_record.clone().expect("accepted record");
    seed_existing_accepted_memory(&state, existing);

    let error = persist_accepted_memory_admission(&state, admission).expect_err("duplicate id");

    assert!(matches!(error, ServerControlError::Conflict { .. }));
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

fn seed_existing_accepted_memory(
    state: &ServerStateService<nucleus_local_store::SqliteBackend>,
    record: AcceptedMemoryStorageRecord,
) {
    let payload = encode_accepted_memory_storage_payload(&record).expect("encode accepted");
    state
        .shared_memory()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(record.memory_id),
                domain: PersistenceDomain::SharedMemory,
                kind: PersistenceRecordKind::SharedMemoryRecord,
                revision_id: RevisionId("rev:existing".to_owned()),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: payload,
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .expect("seed accepted memory");
}
