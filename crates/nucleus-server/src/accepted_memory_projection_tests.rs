use nucleus_memory::{
    AcceptedMemoryStorageActors, AcceptedMemoryStorageBody, AcceptedMemoryStorageRecord,
    AcceptedMemoryStorageReview, AcceptedMemoryStorageStatus,
    AcceptedMemorySupersessionStorageRefs, MemoryConfidenceStorage, MemoryLinkStorageRefs,
    MemoryProposalStorageKind, MemoryProposalStorageScope, MemoryRetentionStoragePosture,
    MemorySensitivityStorage, MemorySourceStorageKind, MemorySourceStorageRef,
    ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection::{
    AcceptedMemoryConfidence, AcceptedMemoryProjection, AcceptedMemoryProjectionRecord,
    AcceptedMemorySensitivity, AcceptedMemorySummaryKind, AcceptedMemorySummaryScope,
    AcceptedMemorySummaryStatus,
};

#[test]
fn projection_filters_project_records_and_hides_memory_body() {
    let projection = AcceptedMemoryProjection::from_projection_records(
        ProjectId("project:nucleus".to_owned()),
        vec![
            AcceptedMemoryProjectionRecord::Accepted(accepted_memory(
                "memory:1",
                "project:nucleus",
            )),
            AcceptedMemoryProjectionRecord::Accepted(accepted_memory("memory:2", "project:other")),
        ],
    );

    assert_eq!(projection.memories.len(), 1);
    let memory = &projection.memories[0];
    assert_eq!(memory.memory_id, "memory:1");
    assert_eq!(
        memory.source_proposal_id.as_deref(),
        Some("memory-proposal:1")
    );
    assert_eq!(memory.scope, AcceptedMemorySummaryScope::Project);
    assert_eq!(memory.kind, AcceptedMemorySummaryKind::Decision);
    assert_eq!(memory.status, AcceptedMemorySummaryStatus::Accepted);
    assert_eq!(
        memory.sensitivity,
        AcceptedMemorySensitivity::InternalProject
    );
    assert_eq!(memory.confidence, AcceptedMemoryConfidence::High);
    assert_eq!(memory.source_ref_count, 1);
    assert_eq!(memory.link_ref_count, 2);
    assert_eq!(memory.evidence_ref_count, 1);
    assert_eq!(projection.source_counts.accepted_records, 2);
    assert_eq!(projection.source_counts.out_of_scope_accepted_records, 1);
    assert_eq!(projection.source_counts.source_refs, 1);
    assert_eq!(projection.source_counts.link_refs, 2);
    assert_eq!(projection.source_counts.supersession_refs, 1);
    assert!(!projection.client_can_mutate);
    assert!(!projection.projection_written);
    assert!(!projection.embedding_available);
    assert!(!projection.provider_sync_available);
    assert!(!format!("{projection:?}").contains("Hidden accepted memory body"));
}

#[test]
fn projection_counts_skipped_records_without_leaking_payloads() {
    let projection = AcceptedMemoryProjection::from_projection_records(
        ProjectId("project:nucleus".to_owned()),
        vec![
            AcceptedMemoryProjectionRecord::ProposalRecordSkipped {
                record_id: "memory-proposal:1".to_owned(),
            },
            AcceptedMemoryProjectionRecord::UnsupportedRecordSkipped {
                record_id: "record:unsupported".to_owned(),
            },
            AcceptedMemoryProjectionRecord::DecodeFailedSkipped {
                record_id: "record:bad-json".to_owned(),
            },
        ],
    );

    assert!(projection.memories.is_empty());
    assert_eq!(projection.source_counts.skipped_records, 3);
    assert_eq!(projection.source_counts.skipped_proposal_records, 1);
    assert_eq!(projection.source_counts.skipped_unsupported_records, 1);
    assert_eq!(projection.source_counts.skipped_decode_errors, 1);
    assert!(!format!("{projection:?}").contains("raw"));
}

#[test]
fn projection_builds_bucket_counts() {
    let mut stale = accepted_memory("memory:stale", "project:nucleus");
    stale.status = AcceptedMemoryStorageStatus::Stale;
    stale.sensitivity = MemorySensitivityStorage::PublicProject;
    stale.confidence = MemoryConfidenceStorage::Medium;

    let projection = AcceptedMemoryProjection::from_projection_records(
        ProjectId("project:nucleus".to_owned()),
        vec![
            AcceptedMemoryProjectionRecord::Accepted(accepted_memory(
                "memory:accepted",
                "project:nucleus",
            )),
            AcceptedMemoryProjectionRecord::Accepted(stale),
        ],
    );

    assert_eq!(projection.status_counts.len(), 2);
    assert_eq!(projection.scope_counts.len(), 1);
    assert_eq!(projection.kind_counts.len(), 1);
    assert_eq!(projection.sensitivity_counts.len(), 2);
    assert_eq!(projection.retention_counts.len(), 1);
    assert_eq!(projection.confidence_counts.len(), 2);
}

fn accepted_memory(memory_id: &str, project_ref: &str) -> AcceptedMemoryStorageRecord {
    AcceptedMemoryStorageRecord {
        schema_version: ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
        memory_id: memory_id.to_owned(),
        source_proposal_id: Some("memory-proposal:1".to_owned()),
        scope: MemoryProposalStorageScope::Project {
            project_ref: project_ref.to_owned(),
        },
        kind: MemoryProposalStorageKind::Decision,
        status: AcceptedMemoryStorageStatus::Accepted,
        title: "Hidden accepted memory title".to_owned(),
        body: AcceptedMemoryStorageBody::Summary {
            summary: "Hidden accepted memory body".to_owned(),
            detail: Some("Hidden accepted memory detail".to_owned()),
        },
        source_refs: vec![MemorySourceStorageRef {
            kind: MemorySourceStorageKind::PlanningArtifact,
            source_ref: "artifact:memory".to_owned(),
            evidence_ref: Some("evidence:source".to_owned()),
        }],
        link_refs: MemoryLinkStorageRefs {
            planning_artifact_refs: vec!["artifact:memory".to_owned()],
            evidence_refs: vec!["evidence:review".to_owned()],
            ..MemoryLinkStorageRefs::default()
        },
        confidence: MemoryConfidenceStorage::High,
        sensitivity: MemorySensitivityStorage::InternalProject,
        retention: MemoryRetentionStoragePosture::ProjectContextCandidate,
        actors: AcceptedMemoryStorageActors {
            created_by_ref: "agent:steward".to_owned(),
            accepted_by_ref: "operator:tom".to_owned(),
        },
        review: AcceptedMemoryStorageReview {
            reviewer_ref: "operator:tom".to_owned(),
            note: Some("Reviewed.".to_owned()),
        },
        supersession: AcceptedMemorySupersessionStorageRefs {
            supersedes: vec!["memory:old".to_owned()],
            superseded_by: Vec::new(),
        },
        created_at: Some("2026-07-05T00:00:00Z".to_owned()),
        accepted_at: Some("2026-07-05T00:00:00Z".to_owned()),
        updated_at: None,
    }
}
