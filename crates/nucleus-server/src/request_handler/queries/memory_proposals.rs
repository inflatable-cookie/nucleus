use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;
use nucleus_memory::decode_memory_proposal_storage_record;

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{MemoryProposalsQuery, ServerControlError, ServerQueryResult};
use crate::memory_proposals_projection::MemoryProposalsProjection;

pub(super) fn memory_proposals_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: MemoryProposalsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut proposals = Vec::new();
    for record in handler
        .state()
        .shared_memory()
        .list()
        .map_err(storage_error)?
    {
        if record.kind != PersistenceRecordKind::SharedMemoryRecord {
            continue;
        }
        proposals.push(
            decode_memory_proposal_storage_record(&record.payload.bytes).map_err(|error| {
                ServerControlError::StorageUnavailable {
                    reason: format!("memory proposal decode failed: {}", error.reason),
                }
            })?,
        );
    }

    Ok(ServerQueryResult::MemoryProposals(
        MemoryProposalsProjection::from_storage_records(query.project_id, proposals),
    ))
}

#[cfg(test)]
mod tests {
    use nucleus_core::{PersistenceDomain, PersistenceRecordId, RevisionId};
    use nucleus_local_store::{
        LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
    };
    use nucleus_memory::{
        encode_memory_proposal_storage_payload, MemoryConfidenceStorage, MemoryLinkStorageRefs,
        MemoryProposalStorageKind, MemoryProposalStorageRecord, MemoryProposalStorageScope,
        MemoryProposalStorageStatus, MemoryRetentionStoragePosture, MemoryReviewStorageState,
        MemoryReviewStorageStatus, MemorySensitivityStorage, MemorySourceStorageKind,
        MemorySourceStorageRef, MemorySupersessionStorageRefs, MEMORY_STORAGE_SCHEMA_VERSION,
    };
    use nucleus_projects::ProjectId;

    use super::*;
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn memory_proposals_query_reads_sanitized_project_scoped_records() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);

        persist_proposal(&handler, "memory-proposal:nucleus", "project:nucleus");
        persist_proposal(&handler, "memory-proposal:other", "project:other");

        let result = memory_proposals_query(
            &handler,
            MemoryProposalsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect("memory proposals query");

        let ServerQueryResult::MemoryProposals(projection) = result else {
            panic!("expected memory proposals projection");
        };

        assert_eq!(projection.project_id.0, "project:nucleus");
        assert_eq!(projection.proposals.len(), 1);
        assert_eq!(
            projection.proposals[0].proposal_id,
            "memory-proposal:nucleus"
        );
        assert_eq!(projection.source_counts.proposal_records, 1);
        assert!(!projection.client_can_mutate);
        assert!(!projection.provider_execution_available);
    }

    #[test]
    fn memory_proposals_query_reports_decode_failures_without_effects() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);
        handler
            .state()
            .shared_memory()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId("memory-proposal:broken".to_owned()),
                    domain: PersistenceDomain::SharedMemory,
                    kind: PersistenceRecordKind::SharedMemoryRecord,
                    revision_id: RevisionId("rev:broken".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: b"{not-json".to_vec(),
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("put broken proposal");

        let error = memory_proposals_query(
            &handler,
            MemoryProposalsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect_err("decode failure");

        assert!(matches!(
            error,
            ServerControlError::StorageUnavailable { reason }
                if reason.contains("memory proposal decode failed")
        ));
    }

    fn persist_proposal(
        handler: &LocalControlRequestHandler<SqliteBackend>,
        proposal_id: &str,
        project_id: &str,
    ) {
        let payload = encode_memory_proposal_storage_payload(&MemoryProposalStorageRecord {
            schema_version: MEMORY_STORAGE_SCHEMA_VERSION,
            proposal_id: proposal_id.to_owned(),
            scope: MemoryProposalStorageScope::Project {
                project_ref: project_id.to_owned(),
            },
            kind: MemoryProposalStorageKind::Decision,
            status: MemoryProposalStorageStatus::Proposed,
            title: "Hidden from query".to_owned(),
            summary: "Hidden from query".to_owned(),
            detail: Some("Hidden from query".to_owned()),
            source_refs: vec![MemorySourceStorageRef {
                kind: MemorySourceStorageKind::PlanningSession,
                source_ref: "planning-session:nucleus".to_owned(),
                evidence_ref: Some("evidence:memory".to_owned()),
            }],
            link_refs: MemoryLinkStorageRefs {
                planning_session_refs: vec!["planning-session:nucleus".to_owned()],
                task_refs: vec!["task:nucleus".to_owned()],
                ..MemoryLinkStorageRefs::default()
            },
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

        handler
            .state()
            .shared_memory()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId(proposal_id.to_owned()),
                    domain: PersistenceDomain::SharedMemory,
                    kind: PersistenceRecordKind::SharedMemoryRecord,
                    revision_id: RevisionId(format!("rev:{proposal_id}")),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: payload,
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("put proposal");
    }
}
