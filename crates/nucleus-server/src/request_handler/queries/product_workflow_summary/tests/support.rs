use crate::project_seed::{seed_local_project, LocalProjectSeed};
use crate::request_handler::LocalControlRequestHandler;
use crate::task_seed::{seed_local_task, LocalTaskSeed};

pub(super) fn handler() -> (
    tempfile::TempDir,
    LocalControlRequestHandler<nucleus_local_store::SqliteBackend>,
) {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = nucleus_local_store::SqliteBackend::new(temp_dir.path().join("state.sqlite"));
    let handler = LocalControlRequestHandler::new(backend, None);
    (temp_dir, handler)
}

pub(super) fn handler_with_project_task() -> (
    tempfile::TempDir,
    LocalControlRequestHandler<nucleus_local_store::SqliteBackend>,
) {
    let (temp_dir, handler) = handler();
    seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("project");
    seed_local_task(handler.state(), LocalTaskSeed::nucleus_local_bootstrap()).expect("task");
    (temp_dir, handler)
}

pub(super) fn seed_accepted_memory(
    handler: &LocalControlRequestHandler<nucleus_local_store::SqliteBackend>,
) {
    use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
    use nucleus_local_store::{LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation};
    use nucleus_memory::{
        encode_accepted_memory_storage_payload, AcceptedMemoryStorageActors,
        AcceptedMemoryStorageBody, AcceptedMemoryStorageRecord, AcceptedMemoryStorageReview,
        AcceptedMemoryStorageStatus, AcceptedMemorySupersessionStorageRefs,
        MemoryConfidenceStorage, MemoryLinkStorageRefs, MemoryProposalStorageKind,
        MemoryProposalStorageScope, MemoryRetentionStoragePosture, MemorySensitivityStorage,
        MemorySourceStorageKind, MemorySourceStorageRef, ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
    };

    let memory_id = "memory:nucleus-local:harness-identity";
    let payload = encode_accepted_memory_storage_payload(&AcceptedMemoryStorageRecord {
        schema_version: ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
        memory_id: memory_id.to_owned(),
        source_proposal_id: Some("memory-proposal:nucleus-local:harness-identity".to_owned()),
        scope: MemoryProposalStorageScope::Project {
            project_ref: "project:nucleus-local".to_owned(),
        },
        kind: MemoryProposalStorageKind::ResearchFinding,
        status: AcceptedMemoryStorageStatus::Accepted,
        title: "Harness identity model needs stable mapping".to_owned(),
        body: AcceptedMemoryStorageBody::Summary {
            summary: "Harness identity rules should be normalized.".to_owned(),
            detail: None,
        },
        source_refs: vec![MemorySourceStorageRef {
            kind: MemorySourceStorageKind::ResearchBrief,
            source_ref: "research-run:nucleus-local:harness-communications".to_owned(),
            evidence_ref: Some("evidence:harness-communications-index".to_owned()),
        }],
        link_refs: MemoryLinkStorageRefs {
            research_brief_refs: vec![
                "research-run:nucleus-local:harness-communications".to_owned()
            ],
            evidence_refs: vec!["evidence:harness-communications-index".to_owned()],
            ..MemoryLinkStorageRefs::default()
        },
        confidence: MemoryConfidenceStorage::Medium,
        sensitivity: MemorySensitivityStorage::InternalProject,
        retention: MemoryRetentionStoragePosture::ProjectContextCandidate,
        actors: AcceptedMemoryStorageActors {
            created_by_ref: "agent:steward".to_owned(),
            accepted_by_ref: "operator:tom".to_owned(),
        },
        review: AcceptedMemoryStorageReview {
            reviewer_ref: "operator:tom".to_owned(),
            note: None,
        },
        supersession: AcceptedMemorySupersessionStorageRefs::default(),
        created_at: None,
        accepted_at: None,
        updated_at: None,
    })
    .expect("encode accepted memory");

    handler
        .state()
        .shared_memory()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(memory_id.to_owned()),
                domain: PersistenceDomain::SharedMemory,
                kind: PersistenceRecordKind::SharedMemoryRecord,
                revision_id: RevisionId("rev:accepted-memory:1".to_owned()),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: payload,
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .expect("put accepted memory");
}
