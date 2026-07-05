use nucleus_memory::{
    AcceptedMemoryStorageActors, AcceptedMemoryStorageBody, AcceptedMemoryStorageRecord,
    AcceptedMemoryStorageReview, AcceptedMemoryStorageStatus,
    AcceptedMemorySupersessionStorageRefs, MemoryConfidenceStorage, MemoryLinkStorageRefs,
    MemoryProposalStorageKind, MemoryProposalStorageScope, MemoryRetentionStoragePosture,
    MemorySensitivityStorage, ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
};

pub(crate) fn accepted_memory(memory_id: &str) -> AcceptedMemoryStorageRecord {
    AcceptedMemoryStorageRecord {
        schema_version: ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
        memory_id: memory_id.to_owned(),
        source_proposal_id: Some("memory-proposal:1".to_owned()),
        scope: MemoryProposalStorageScope::Project {
            project_ref: "project:nucleus".to_owned(),
        },
        kind: MemoryProposalStorageKind::Decision,
        status: AcceptedMemoryStorageStatus::Accepted,
        title: "Use server-owned accepted memory".to_owned(),
        body: AcceptedMemoryStorageBody::Summary {
            summary: "Accepted memory is durable server context.".to_owned(),
            detail: Some("Projection remains policy gated.".to_owned()),
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
            note: Some("Reviewed for projection.".to_owned()),
        },
        supersession: AcceptedMemorySupersessionStorageRefs::default(),
        created_at: Some("2026-07-05T00:00:00Z".to_owned()),
        accepted_at: Some("2026-07-05T00:00:00Z".to_owned()),
        updated_at: None,
    }
}
