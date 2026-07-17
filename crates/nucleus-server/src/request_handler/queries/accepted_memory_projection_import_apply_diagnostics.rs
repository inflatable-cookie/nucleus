use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;
use nucleus_memory::{
    decode_accepted_memory_storage_record, decode_memory_proposal_storage_record,
};

use super::{storage_error, LocalControlRequestHandler};
use crate::accepted_memory_projection_import_apply_diagnostics::AcceptedMemoryProjectionImportApplyDiagnostics;
use crate::accepted_memory_projection_import_diagnostics::AcceptedMemoryProjectionImportDiagnosticRecord;
use crate::control_api::{
    AcceptedMemoryProjectionImportApplyDiagnosticsQuery, ServerControlError, ServerQueryResult,
};

pub(crate) fn accepted_memory_projection_import_apply_diagnostics_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: AcceptedMemoryProjectionImportApplyDiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "accepted memory projection import apply diagnostics requires a project"
                .to_owned(),
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

    Ok(
        ServerQueryResult::AcceptedMemoryProjectionImportApplyDiagnostics(
            AcceptedMemoryProjectionImportApplyDiagnostics::from_records(
                query.project_id,
                diagnostic_records,
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
    use crate::accepted_memory_projection_import_apply_admission::{
        AcceptedMemoryProjectionImportApplyAdmissionBlocker,
        AcceptedMemoryProjectionImportApplyAdmissionStatus,
    };
    use crate::accepted_memory_projection_test_fixtures::accepted_memory;
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn import_apply_diagnostics_query_reports_stopped_records_without_effects() {
        let (_temp_dir, handler) = handler();
        persist_accepted(&handler, accepted_memory("memory:import-apply-diagnostics"));

        let diagnostics = query_diagnostics(&handler);

        assert_eq!(diagnostics.counts.source_records, 1);
        assert_eq!(diagnostics.counts.import_conflicts, 1);
        assert_eq!(diagnostics.counts.apply_admissions, 1);
        assert_eq!(diagnostics.counts.blocked, 1);
        assert_eq!(
            diagnostics.records[0].status,
            AcceptedMemoryProjectionImportApplyAdmissionStatus::Blocked
        );
        assert!(diagnostics.records[0]
            .blockers
            .contains(&AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingOperatorRef));
        assert!(diagnostics.records[0]
            .blockers
            .contains(&AcceptedMemoryProjectionImportApplyAdmissionBlocker::MissingApprovalRef));
        assert!(!diagnostics.no_effects.active_memory_apply_performed);
        assert!(!diagnostics.no_effects.projection_write_performed);
        assert!(!diagnostics.no_effects.scm_effect_performed);
        assert!(!diagnostics.no_effects.embedding_available);
        assert!(!diagnostics.no_effects.provider_sync_available);
        assert!(!diagnostics.no_effects.automatic_extraction_performed);
        assert!(!diagnostics.no_effects.task_mutation_performed);
        assert!(!diagnostics.no_effects.agent_scheduling_performed);
        assert!(!diagnostics.no_effects.ui_effect_performed);
    }

    fn handler() -> (tempfile::TempDir, LocalControlRequestHandler<SqliteBackend>) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);
        (temp_dir, handler)
    }

    fn query_diagnostics(
        handler: &LocalControlRequestHandler<SqliteBackend>,
    ) -> AcceptedMemoryProjectionImportApplyDiagnostics {
        let result = accepted_memory_projection_import_apply_diagnostics_query(
            handler,
            AcceptedMemoryProjectionImportApplyDiagnosticsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect("accepted memory projection import apply diagnostics");

        let ServerQueryResult::AcceptedMemoryProjectionImportApplyDiagnostics(diagnostics) = result
        else {
            panic!("expected accepted memory projection import apply diagnostics");
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
