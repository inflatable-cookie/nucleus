use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;
use nucleus_memory::{
    decode_accepted_memory_storage_record, decode_memory_proposal_storage_record,
};

use super::{storage_error, LocalControlRequestHandler};
use crate::accepted_memory_projection_diagnostics::{
    AcceptedMemoryProjectionDiagnosticRecord, AcceptedMemoryProjectionDiagnostics,
};
use crate::control_api::{
    AcceptedMemoryProjectionDiagnosticsQuery, ServerControlError, ServerQueryResult,
};

pub(crate) fn accepted_memory_projection_diagnostics_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: AcceptedMemoryProjectionDiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "accepted memory projection diagnostics requires a project".to_owned(),
        });
    }

    let mut diagnostic_records = Vec::new();

    for record in handler
        .state()
        .shared_memory()
        .list()
        .map_err(storage_error)?
    {
        if record.kind != PersistenceRecordKind::SharedMemoryRecord {
            diagnostic_records.push(
                AcceptedMemoryProjectionDiagnosticRecord::UnsupportedRecordSkipped {
                    record_id: record.id.0,
                },
            );
            continue;
        }

        match decode_accepted_memory_storage_record(&record.payload.bytes) {
            Ok(accepted) => {
                diagnostic_records
                    .push(AcceptedMemoryProjectionDiagnosticRecord::Accepted(accepted));
            }
            Err(_) if decode_memory_proposal_storage_record(&record.payload.bytes).is_ok() => {
                diagnostic_records.push(
                    AcceptedMemoryProjectionDiagnosticRecord::ProposalRecordSkipped {
                        record_id: record.id.0,
                    },
                );
            }
            Err(_) => {
                diagnostic_records.push(
                    AcceptedMemoryProjectionDiagnosticRecord::DecodeFailedSkipped {
                        record_id: record.id.0,
                    },
                );
            }
        }
    }

    Ok(ServerQueryResult::AcceptedMemoryProjectionDiagnostics(
        AcceptedMemoryProjectionDiagnostics::from_records(query.project_id, diagnostic_records),
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
        MemoryReviewStorageStatus, MemorySensitivityStorage, MemorySupersessionStorageRefs,
        ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION, MEMORY_STORAGE_SCHEMA_VERSION,
    };
    use nucleus_projects::ProjectId;

    use super::*;
    use crate::accepted_memory_projection_policy::AcceptedMemoryProjectionPolicyStatus;
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn accepted_memory_projection_diagnostics_query_reports_empty_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);

        let diagnostics = query_diagnostics(&handler);

        assert!(diagnostics.entries.is_empty());
        assert_eq!(diagnostics.counts.accepted_records, 0);
        assert_eq!(diagnostics.counts.projectable_records, 0);
        assert!(!diagnostics.projection_write_performed);
        assert!(!diagnostics.scm_effect_performed);
        assert!(!diagnostics.import_or_apply_performed);
        assert!(!diagnostics.embedding_available);
        assert!(!diagnostics.provider_sync_available);
    }

    #[test]
    fn accepted_memory_projection_diagnostics_query_reports_projectable_record() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);

        persist_accepted(
            &handler,
            accepted_memory("memory:projectable", "project:nucleus"),
        );

        let diagnostics = query_diagnostics(&handler);

        assert_eq!(diagnostics.entries.len(), 1);
        assert_eq!(diagnostics.counts.accepted_records, 1);
        assert_eq!(diagnostics.counts.projectable_records, 1);
        assert_eq!(diagnostics.counts.file_refs, 1);
        assert_eq!(
            diagnostics.entries[0].file_ref.as_deref(),
            Some("nucleus/memory/memory:projectable.toml")
        );
        assert_eq!(
            diagnostics.entries[0].policy_status,
            AcceptedMemoryProjectionPolicyStatus::Projectable
        );
    }

    #[test]
    fn accepted_memory_projection_diagnostics_query_reports_blocked_record() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);

        let mut restricted = accepted_memory("memory:restricted", "project:nucleus");
        restricted.sensitivity = MemorySensitivityStorage::Restricted;
        persist_accepted(&handler, restricted);

        let diagnostics = query_diagnostics(&handler);

        assert_eq!(diagnostics.entries.len(), 1);
        assert_eq!(diagnostics.counts.blocked_records, 1);
        assert_eq!(diagnostics.counts.policy_blockers, 1);
        assert_eq!(diagnostics.counts.export_blockers, 1);
        assert!(diagnostics.entries[0].file_ref.is_none());
        assert!(!format!("{diagnostics:?}").contains("Hidden accepted summary"));
    }

    #[test]
    fn accepted_memory_projection_diagnostics_query_reports_mixed_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);

        persist_accepted(
            &handler,
            accepted_memory("memory:projectable", "project:nucleus"),
        );

        let mut local = accepted_memory("memory:local", "project:nucleus");
        local.retention = MemoryRetentionStoragePosture::LocalOnly;
        persist_accepted(&handler, local);

        let mut review = accepted_memory("memory:review", "project:nucleus");
        review.review.reviewer_ref.clear();
        persist_accepted(&handler, review);

        persist_accepted(&handler, accepted_memory("memory:other", "project:other"));
        persist_proposal(&handler);
        persist_bad_json(&handler);

        let diagnostics = query_diagnostics(&handler);

        assert_eq!(diagnostics.entries.len(), 3);
        assert_eq!(diagnostics.counts.accepted_records, 4);
        assert_eq!(diagnostics.counts.out_of_scope_accepted_records, 1);
        assert_eq!(diagnostics.counts.projectable_records, 1);
        assert_eq!(diagnostics.counts.local_only_records, 1);
        assert_eq!(diagnostics.counts.review_required_records, 1);
        assert_eq!(diagnostics.counts.skipped_records, 2);
        assert_eq!(diagnostics.counts.skipped_proposal_records, 1);
        assert_eq!(diagnostics.counts.skipped_decode_errors, 1);
        assert!(!format!("{diagnostics:?}").contains("Hidden proposal summary"));
        assert!(!format!("{diagnostics:?}").contains("memory:other"));
    }

    fn query_diagnostics(
        handler: &LocalControlRequestHandler<SqliteBackend>,
    ) -> AcceptedMemoryProjectionDiagnostics {
        let result = accepted_memory_projection_diagnostics_query(
            handler,
            AcceptedMemoryProjectionDiagnosticsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect("accepted memory projection diagnostics");

        let ServerQueryResult::AcceptedMemoryProjectionDiagnostics(diagnostics) = result else {
            panic!("expected accepted memory projection diagnostics");
        };

        diagnostics
    }

    fn persist_accepted(
        handler: &LocalControlRequestHandler<SqliteBackend>,
        record: AcceptedMemoryStorageRecord,
    ) {
        let memory_id = record.memory_id.clone();
        let payload = encode_accepted_memory_storage_payload(&record).expect("encode accepted");
        persist_shared_memory_record(handler, &memory_id, payload);
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
        payload: Vec<u8>,
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
                        bytes: payload,
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("persist shared memory");
    }

    fn accepted_memory(memory_id: &str, project_id: &str) -> AcceptedMemoryStorageRecord {
        AcceptedMemoryStorageRecord {
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
                note: Some("Reviewed for diagnostics.".to_owned()),
            },
            supersession: AcceptedMemorySupersessionStorageRefs::default(),
            created_at: Some("2026-07-05T00:00:00Z".to_owned()),
            accepted_at: Some("2026-07-05T00:00:00Z".to_owned()),
            updated_at: None,
        }
    }
}
