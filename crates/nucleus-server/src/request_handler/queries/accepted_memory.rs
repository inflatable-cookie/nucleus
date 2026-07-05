use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;
use nucleus_memory::{
    decode_accepted_memory_storage_record, decode_memory_proposal_storage_record,
};

use super::{storage_error, LocalControlRequestHandler};
use crate::accepted_memory_projection::{AcceptedMemoryProjection, AcceptedMemoryProjectionRecord};
use crate::control_api::{AcceptedMemoryQuery, ServerControlError, ServerQueryResult};

pub(super) fn accepted_memory_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: AcceptedMemoryQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut projection_records = Vec::new();

    for record in handler
        .state()
        .shared_memory()
        .list()
        .map_err(storage_error)?
    {
        if record.kind != PersistenceRecordKind::SharedMemoryRecord {
            projection_records.push(AcceptedMemoryProjectionRecord::UnsupportedRecordSkipped {
                record_id: record.id.0,
            });
            continue;
        }

        match decode_accepted_memory_storage_record(&record.payload.bytes) {
            Ok(accepted) => {
                projection_records.push(AcceptedMemoryProjectionRecord::Accepted(accepted));
            }
            Err(_) if decode_memory_proposal_storage_record(&record.payload.bytes).is_ok() => {
                projection_records.push(AcceptedMemoryProjectionRecord::ProposalRecordSkipped {
                    record_id: record.id.0,
                });
            }
            Err(_) => {
                projection_records.push(AcceptedMemoryProjectionRecord::DecodeFailedSkipped {
                    record_id: record.id.0,
                });
            }
        }
    }

    Ok(ServerQueryResult::AcceptedMemory(
        AcceptedMemoryProjection::from_projection_records(query.project_id, projection_records),
    ))
}

#[cfg(test)]
mod tests {
    use nucleus_core::{PersistenceDomain, PersistenceRecordId, RevisionId};
    use nucleus_local_store::{
        LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
    };
    use nucleus_memory::{
        encode_accepted_memory_storage_payload, encode_memory_proposal_storage_payload,
        AcceptedMemoryStorageActors, AcceptedMemoryStorageBody, AcceptedMemoryStorageRecord,
        AcceptedMemoryStorageReview, AcceptedMemoryStorageStatus,
        AcceptedMemorySupersessionStorageRefs, MemoryConfidenceStorage, MemoryLinkStorageRefs,
        MemoryProposalStorageKind, MemoryProposalStorageRecord, MemoryProposalStorageScope,
        MemoryProposalStorageStatus, MemoryRetentionStoragePosture, MemoryReviewStorageState,
        MemoryReviewStorageStatus, MemorySensitivityStorage, MemorySourceStorageKind,
        MemorySourceStorageRef, MemorySupersessionStorageRefs,
        ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION, MEMORY_STORAGE_SCHEMA_VERSION,
    };
    use nucleus_projects::ProjectId;

    use super::*;
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn accepted_memory_query_reads_project_scoped_records() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);

        persist_accepted(&handler, "memory:nucleus", "project:nucleus");
        persist_accepted(&handler, "memory:other", "project:other");

        let result = accepted_memory_query(
            &handler,
            AcceptedMemoryQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect("accepted memory query");

        let ServerQueryResult::AcceptedMemory(projection) = result else {
            panic!("expected accepted memory projection");
        };

        assert_eq!(projection.project_id.0, "project:nucleus");
        assert_eq!(projection.memories.len(), 1);
        assert_eq!(projection.memories[0].memory_id, "memory:nucleus");
        assert_eq!(projection.source_counts.accepted_records, 2);
        assert_eq!(projection.source_counts.out_of_scope_accepted_records, 1);
        assert!(!projection.client_can_mutate);
        assert!(!projection.projection_written);
    }

    #[test]
    fn accepted_memory_query_skips_proposals_and_decode_failures() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);

        persist_proposal(&handler);
        persist_bad_json(&handler);

        let result = accepted_memory_query(
            &handler,
            AcceptedMemoryQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect("accepted memory query");

        let ServerQueryResult::AcceptedMemory(projection) = result else {
            panic!("expected accepted memory projection");
        };

        assert!(projection.memories.is_empty());
        assert_eq!(projection.source_counts.skipped_records, 2);
        assert_eq!(projection.source_counts.skipped_proposal_records, 1);
        assert_eq!(projection.source_counts.skipped_decode_errors, 1);
        assert!(!format!("{projection:?}").contains("Hidden proposal summary"));
        assert!(!format!("{projection:?}").contains("{not-json"));
    }

    fn persist_accepted(
        handler: &LocalControlRequestHandler<SqliteBackend>,
        memory_id: &str,
        project_id: &str,
    ) {
        let payload = encode_accepted_memory_storage_payload(&AcceptedMemoryStorageRecord {
            schema_version: ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
            memory_id: memory_id.to_owned(),
            source_proposal_id: Some("memory-proposal:1".to_owned()),
            scope: MemoryProposalStorageScope::Project {
                project_ref: project_id.to_owned(),
            },
            kind: MemoryProposalStorageKind::Decision,
            status: AcceptedMemoryStorageStatus::Accepted,
            title: "Hidden accepted title".to_owned(),
            body: AcceptedMemoryStorageBody::Summary {
                summary: "Hidden accepted summary".to_owned(),
                detail: None,
            },
            source_refs: vec![MemorySourceStorageRef {
                kind: MemorySourceStorageKind::PlanningArtifact,
                source_ref: "artifact:memory".to_owned(),
                evidence_ref: Some("evidence:source".to_owned()),
            }],
            link_refs: MemoryLinkStorageRefs {
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
                note: None,
            },
            supersession: AcceptedMemorySupersessionStorageRefs::default(),
            created_at: None,
            accepted_at: None,
            updated_at: None,
        })
        .expect("encode accepted");

        persist_shared_memory_record(handler, memory_id, payload);
    }

    fn persist_proposal(handler: &LocalControlRequestHandler<SqliteBackend>) {
        let payload = encode_memory_proposal_storage_payload(&MemoryProposalStorageRecord {
            schema_version: MEMORY_STORAGE_SCHEMA_VERSION,
            proposal_id: "memory-proposal:1".to_owned(),
            scope: MemoryProposalStorageScope::Project {
                project_ref: "project:nucleus".to_owned(),
            },
            kind: MemoryProposalStorageKind::Decision,
            status: MemoryProposalStorageStatus::Proposed,
            title: "Hidden proposal title".to_owned(),
            summary: "Hidden proposal summary".to_owned(),
            detail: None,
            source_refs: Vec::new(),
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
        })
        .expect("encode proposal");

        persist_shared_memory_record(handler, "memory-proposal:1", payload);
    }

    fn persist_bad_json(handler: &LocalControlRequestHandler<SqliteBackend>) {
        persist_shared_memory_record(handler, "memory:bad-json", b"{not-json".to_vec());
    }

    fn persist_shared_memory_record(
        handler: &LocalControlRequestHandler<SqliteBackend>,
        id: &str,
        bytes: Vec<u8>,
    ) {
        handler
            .state()
            .shared_memory()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId(id.to_owned()),
                    domain: PersistenceDomain::SharedMemory,
                    kind: PersistenceRecordKind::SharedMemoryRecord,
                    revision_id: RevisionId(format!("rev:{id}")),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes,
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("put shared memory");
    }
}
