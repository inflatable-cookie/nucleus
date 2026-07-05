use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;
use nucleus_memory::{
    decode_accepted_memory_storage_record, decode_memory_proposal_storage_record,
};

use super::{storage_error, LocalControlRequestHandler};
use crate::accepted_memory_projection::{AcceptedMemoryProjection, AcceptedMemoryProjectionRecord};
use crate::accepted_memory_projection_import_apply_diagnostics::AcceptedMemoryProjectionImportApplyDiagnostics;
use crate::accepted_memory_projection_import_diagnostics::{
    AcceptedMemoryProjectionImportDiagnosticRecord, AcceptedMemoryProjectionImportDiagnostics,
};
use crate::accepted_memory_projection_write_diagnostics::{
    AcceptedMemoryProjectionWriteDiagnosticRecord, AcceptedMemoryProjectionWriteDiagnostics,
};
use crate::accepted_memory_review_readiness::AcceptedMemoryReviewReadiness;
use crate::control_api::{
    AcceptedMemoryReviewReadinessQuery, ServerControlError, ServerQueryResult,
};

pub(crate) fn accepted_memory_review_readiness_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: AcceptedMemoryReviewReadinessQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "accepted memory review readiness query requires a project".to_owned(),
        });
    }

    let mut accepted_memory_records = Vec::new();
    let mut write_records = Vec::new();
    let mut import_records = Vec::new();

    for record in handler
        .state()
        .shared_memory()
        .list()
        .map_err(storage_error)?
    {
        if record.kind != PersistenceRecordKind::SharedMemoryRecord {
            accepted_memory_records.push(
                AcceptedMemoryProjectionRecord::UnsupportedRecordSkipped {
                    record_id: record.id.0.clone(),
                },
            );
            write_records.push(
                AcceptedMemoryProjectionWriteDiagnosticRecord::UnsupportedRecordSkipped {
                    record_id: record.id.0.clone(),
                },
            );
            import_records.push(
                AcceptedMemoryProjectionImportDiagnosticRecord::UnsupportedRecordSkipped {
                    record_id: record.id.0,
                },
            );
            continue;
        }

        match decode_accepted_memory_storage_record(&record.payload.bytes) {
            Ok(accepted) => {
                accepted_memory_records
                    .push(AcceptedMemoryProjectionRecord::Accepted(accepted.clone()));
                write_records.push(AcceptedMemoryProjectionWriteDiagnosticRecord::Accepted(
                    accepted.clone(),
                ));
                import_records.push(AcceptedMemoryProjectionImportDiagnosticRecord::Accepted(
                    accepted,
                ));
            }
            Err(_) if decode_memory_proposal_storage_record(&record.payload.bytes).is_ok() => {
                accepted_memory_records.push(
                    AcceptedMemoryProjectionRecord::ProposalRecordSkipped {
                        record_id: record.id.0.clone(),
                    },
                );
                write_records.push(
                    AcceptedMemoryProjectionWriteDiagnosticRecord::ProposalRecordSkipped {
                        record_id: record.id.0.clone(),
                    },
                );
                import_records.push(
                    AcceptedMemoryProjectionImportDiagnosticRecord::ProposalRecordSkipped {
                        record_id: record.id.0,
                    },
                );
            }
            Err(_) => {
                accepted_memory_records.push(AcceptedMemoryProjectionRecord::DecodeFailedSkipped {
                    record_id: record.id.0.clone(),
                });
                write_records.push(
                    AcceptedMemoryProjectionWriteDiagnosticRecord::DecodeFailedSkipped {
                        record_id: record.id.0.clone(),
                    },
                );
                import_records.push(
                    AcceptedMemoryProjectionImportDiagnosticRecord::DecodeFailedSkipped {
                        record_id: record.id.0,
                    },
                );
            }
        }
    }

    let accepted_memory = AcceptedMemoryProjection::from_projection_records(
        query.project_id.clone(),
        accepted_memory_records,
    );
    let projection_writes = AcceptedMemoryProjectionWriteDiagnostics::from_records(
        query.project_id.clone(),
        write_records,
    );
    let imports =
        AcceptedMemoryProjectionImportDiagnostics::from_records(query.project_id, import_records);
    let import_apply =
        AcceptedMemoryProjectionImportApplyDiagnostics::from_import_diagnostics(imports.clone());

    Ok(ServerQueryResult::AcceptedMemoryReviewReadiness(
        AcceptedMemoryReviewReadiness::from_diagnostics(
            accepted_memory,
            projection_writes,
            imports,
            import_apply,
        ),
    ))
}

#[cfg(test)]
mod tests {
    use nucleus_core::{PersistenceDomain, PersistenceRecordId, RevisionId};
    use nucleus_local_store::{
        LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
    };
    use nucleus_memory::encode_accepted_memory_storage_payload;
    use nucleus_projects::ProjectId;

    use super::*;
    use crate::accepted_memory_projection_test_fixtures::accepted_memory;
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn readiness_query_composes_existing_memory_diagnostics_without_effects() {
        let (_temp_dir, handler) = handler();
        persist_accepted(&handler, accepted_memory("memory:review-readiness"));

        let readiness = query_readiness(&handler);

        assert_eq!(readiness.project_id.0, "project:nucleus");
        assert_eq!(readiness.counts.accepted_memories, 1);
        assert_eq!(readiness.counts.projectable, 1);
        assert_eq!(readiness.counts.projection_write_admitted, 1);
        assert_eq!(readiness.counts.import_candidates_ready, 1);
        assert_eq!(readiness.counts.approval_required, 1);
        assert!(!readiness.active_memory_apply_performed);
        assert!(!readiness.projection_write_performed);
        assert!(!readiness.scm_effect_performed);
        assert!(!readiness.embedding_available);
        assert!(!readiness.provider_sync_available);
        assert!(!readiness.automatic_extraction_performed);
        assert!(!readiness.task_mutation_performed);
        assert!(!readiness.agent_scheduling_performed);
        assert!(!readiness.ui_effect_performed);
    }

    fn handler() -> (tempfile::TempDir, LocalControlRequestHandler<SqliteBackend>) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);
        (temp_dir, handler)
    }

    fn query_readiness(
        handler: &LocalControlRequestHandler<SqliteBackend>,
    ) -> AcceptedMemoryReviewReadiness {
        let result = accepted_memory_review_readiness_query(
            handler,
            AcceptedMemoryReviewReadinessQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect("accepted memory review readiness");

        let ServerQueryResult::AcceptedMemoryReviewReadiness(readiness) = result else {
            panic!("expected accepted memory review readiness");
        };

        readiness
    }

    fn persist_accepted(
        handler: &LocalControlRequestHandler<SqliteBackend>,
        record: nucleus_memory::AcceptedMemoryStorageRecord,
    ) {
        let memory_id = record.memory_id.clone();
        let payload = encode_accepted_memory_storage_payload(&record).expect("encode accepted");
        handler
            .state()
            .shared_memory()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId(memory_id.clone()),
                    domain: PersistenceDomain::SharedMemory,
                    kind: PersistenceRecordKind::SharedMemoryRecord,
                    revision_id: RevisionId(format!("rev:{memory_id}")),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: payload,
                    },
                },
                RevisionExpectation::Any,
            )
            .expect("persist accepted memory");
    }
}
