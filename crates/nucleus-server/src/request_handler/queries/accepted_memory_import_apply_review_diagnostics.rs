use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;
use nucleus_memory::{
    decode_accepted_memory_storage_record, decode_memory_proposal_storage_record,
};

use super::{storage_error, LocalControlRequestHandler};
use crate::accepted_memory_import_apply_review_diagnostics::AcceptedMemoryImportApplyReviewDiagnostics;
use crate::accepted_memory_projection_import_apply_diagnostics::AcceptedMemoryProjectionImportApplyDiagnostics;
use crate::accepted_memory_projection_import_diagnostics::AcceptedMemoryProjectionImportDiagnosticRecord;
use crate::control_api::{
    AcceptedMemoryImportApplyReviewDiagnosticsQuery, ServerControlError, ServerQueryResult,
};

pub(crate) fn accepted_memory_import_apply_review_diagnostics_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: AcceptedMemoryImportApplyReviewDiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "accepted memory import apply review diagnostics requires a project".to_owned(),
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
                AcceptedMemoryProjectionImportDiagnosticRecord::UnsupportedRecordSkipped {
                    record_id: record.id.0,
                },
            );
            continue;
        }

        match decode_accepted_memory_storage_record(&record.payload.bytes) {
            Ok(accepted) => {
                diagnostic_records.push(AcceptedMemoryProjectionImportDiagnosticRecord::Accepted(
                    accepted,
                ));
            }
            Err(_) if decode_memory_proposal_storage_record(&record.payload.bytes).is_ok() => {
                diagnostic_records.push(
                    AcceptedMemoryProjectionImportDiagnosticRecord::ProposalRecordSkipped {
                        record_id: record.id.0,
                    },
                );
            }
            Err(_) => {
                diagnostic_records.push(
                    AcceptedMemoryProjectionImportDiagnosticRecord::DecodeFailedSkipped {
                        record_id: record.id.0,
                    },
                );
            }
        }
    }

    let apply = AcceptedMemoryProjectionImportApplyDiagnostics::from_records(
        query.project_id.clone(),
        diagnostic_records,
    );

    Ok(
        ServerQueryResult::AcceptedMemoryImportApplyReviewDiagnostics(
            AcceptedMemoryImportApplyReviewDiagnostics::from_apply_diagnostics(
                query.project_id,
                apply,
            ),
        ),
    )
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
    use crate::accepted_memory_import_apply_review_command::{
        AcceptedMemoryImportApplyReviewDecision, AcceptedMemoryImportApplyReviewStatus,
    };
    use crate::accepted_memory_projection_test_fixtures::accepted_memory;
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn review_diagnostics_query_returns_read_only_receipts() {
        let (_temp_dir, handler) = handler();
        persist_accepted(
            &handler,
            accepted_memory("memory:import-apply-review-diagnostics"),
        );

        let diagnostics = query_diagnostics(&handler);

        assert_eq!(diagnostics.project_id.0, "project:nucleus");
        assert_eq!(diagnostics.review_set.counts.inputs, 3);
        assert_eq!(diagnostics.review_set.counts.deferred, 1);
        assert_eq!(diagnostics.review_set.counts.rejected, 1);
        assert_eq!(diagnostics.review_set.counts.blocked, 1);
        assert_eq!(
            diagnostics.review_set.receipts[0].decision,
            AcceptedMemoryImportApplyReviewDecision::Approve
        );
        assert_eq!(
            diagnostics.review_set.receipts[0].status,
            AcceptedMemoryImportApplyReviewStatus::Blocked
        );
        assert!(!diagnostics.review_receipts_persisted);
        assert!(!diagnostics.active_memory_apply_performed);
        assert!(!diagnostics.projection_write_performed);
        assert!(!diagnostics.scm_effect_performed);
        assert!(!diagnostics.embedding_available);
        assert!(!diagnostics.provider_sync_available);
        assert!(!diagnostics.automatic_extraction_performed);
        assert!(!diagnostics.task_mutation_performed);
        assert!(!diagnostics.agent_scheduling_performed);
        assert!(!diagnostics.ui_effect_performed);
    }

    fn handler() -> (tempfile::TempDir, LocalControlRequestHandler<SqliteBackend>) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);
        (temp_dir, handler)
    }

    fn query_diagnostics(
        handler: &LocalControlRequestHandler<SqliteBackend>,
    ) -> AcceptedMemoryImportApplyReviewDiagnostics {
        let result = accepted_memory_import_apply_review_diagnostics_query(
            handler,
            AcceptedMemoryImportApplyReviewDiagnosticsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect("accepted memory import apply review diagnostics");

        let ServerQueryResult::AcceptedMemoryImportApplyReviewDiagnostics(diagnostics) = result
        else {
            panic!("expected accepted memory import apply review diagnostics");
        };

        diagnostics
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
