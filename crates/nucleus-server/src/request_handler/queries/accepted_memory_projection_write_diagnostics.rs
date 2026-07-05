use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;
use nucleus_memory::{
    decode_accepted_memory_storage_record, decode_memory_proposal_storage_record,
};

use super::{storage_error, LocalControlRequestHandler};
use crate::accepted_memory_projection_write_diagnostics::{
    AcceptedMemoryProjectionWriteDiagnosticRecord, AcceptedMemoryProjectionWriteDiagnostics,
};
use crate::control_api::{
    AcceptedMemoryProjectionWriteDiagnosticsQuery, ServerControlError, ServerQueryResult,
};

pub(crate) fn accepted_memory_projection_write_diagnostics_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: AcceptedMemoryProjectionWriteDiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "accepted memory projection write diagnostics requires a project".to_owned(),
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
                AcceptedMemoryProjectionWriteDiagnosticRecord::UnsupportedRecordSkipped {
                    record_id: record.id.0,
                },
            );
            continue;
        }

        match decode_accepted_memory_storage_record(&record.payload.bytes) {
            Ok(accepted) => {
                diagnostic_records.push(AcceptedMemoryProjectionWriteDiagnosticRecord::Accepted(
                    accepted,
                ));
            }
            Err(_) if decode_memory_proposal_storage_record(&record.payload.bytes).is_ok() => {
                diagnostic_records.push(
                    AcceptedMemoryProjectionWriteDiagnosticRecord::ProposalRecordSkipped {
                        record_id: record.id.0,
                    },
                );
            }
            Err(_) => {
                diagnostic_records.push(
                    AcceptedMemoryProjectionWriteDiagnosticRecord::DecodeFailedSkipped {
                        record_id: record.id.0,
                    },
                );
            }
        }
    }

    Ok(ServerQueryResult::AcceptedMemoryProjectionWriteDiagnostics(
        AcceptedMemoryProjectionWriteDiagnostics::from_records(
            query.project_id,
            diagnostic_records,
        ),
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
    use crate::accepted_memory_projection_write_admission::AcceptedMemoryProjectionWriteAdmissionStatus;
    use crate::accepted_memory_projection_write_diagnostics::AcceptedMemoryProjectionPayloadStatus;
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn write_diagnostics_query_reports_admitted_record_without_effects() {
        let (_temp_dir, handler) = handler();
        persist_accepted(&handler, accepted_memory("memory:ready", "project:nucleus"));

        let diagnostics = query_diagnostics(&handler);

        assert_eq!(diagnostics.entries.len(), 1);
        assert_eq!(diagnostics.counts.accepted_records, 1);
        assert_eq!(diagnostics.counts.admitted_writes, 1);
        assert_eq!(diagnostics.counts.payload_ready_records, 1);
        assert_eq!(diagnostics.counts.materialized_files, 0);
        assert_eq!(
            diagnostics.entries[0].admission_status,
            AcceptedMemoryProjectionWriteAdmissionStatus::Admitted
        );
        assert_eq!(
            diagnostics.entries[0].payload_status,
            AcceptedMemoryProjectionPayloadStatus::Ready
        );
        assert!(!diagnostics.projection_write_performed);
        assert!(!diagnostics.scm_effect_performed);
        assert!(!diagnostics.import_or_apply_performed);
        assert!(!diagnostics.embedding_available);
        assert!(!diagnostics.provider_sync_available);
        assert!(!diagnostics.task_mutation_performed);
        assert!(!diagnostics.ui_effect_performed);
    }

    #[test]
    fn write_diagnostics_query_reports_blocked_and_skipped_records() {
        let (_temp_dir, handler) = handler();

        let mut restricted = accepted_memory("memory:restricted", "project:nucleus");
        restricted.sensitivity = MemorySensitivityStorage::Restricted;
        persist_accepted(&handler, restricted);
        persist_accepted(&handler, accepted_memory("memory:other", "project:other"));
        persist_proposal(&handler);
        persist_bad_json(&handler);

        let diagnostics = query_diagnostics(&handler);

        assert_eq!(diagnostics.entries.len(), 1);
        assert_eq!(diagnostics.counts.accepted_records, 2);
        assert_eq!(diagnostics.counts.out_of_scope_accepted_records, 1);
        assert_eq!(diagnostics.counts.blocked_writes, 1);
        assert_eq!(diagnostics.counts.skipped_records, 2);
        assert_eq!(diagnostics.counts.skipped_proposal_records, 1);
        assert_eq!(diagnostics.counts.skipped_decode_errors, 1);
        assert_eq!(
            diagnostics.entries[0].admission_status,
            AcceptedMemoryProjectionWriteAdmissionStatus::Blocked
        );
        assert!(!format!("{diagnostics:?}").contains("Hidden accepted summary"));
        assert!(!format!("{diagnostics:?}").contains("Hidden proposal summary"));
        assert!(!format!("{diagnostics:?}").contains("memory:other"));
    }

    fn handler() -> (tempfile::TempDir, LocalControlRequestHandler<SqliteBackend>) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);
        (temp_dir, handler)
    }

    fn query_diagnostics(
        handler: &LocalControlRequestHandler<SqliteBackend>,
    ) -> AcceptedMemoryProjectionWriteDiagnostics {
        let result = accepted_memory_projection_write_diagnostics_query(
            handler,
            AcceptedMemoryProjectionWriteDiagnosticsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect("accepted memory projection write diagnostics");

        let ServerQueryResult::AcceptedMemoryProjectionWriteDiagnostics(diagnostics) = result
        else {
            panic!("expected accepted memory projection write diagnostics");
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
                note: None,
            },
            supersession: AcceptedMemorySupersessionStorageRefs::default(),
            created_at: None,
            accepted_at: Some("2026-07-05T00:00:00Z".to_owned()),
            updated_at: None,
        }
    }
}
