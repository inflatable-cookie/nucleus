use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;

use super::{storage_error, LocalControlRequestHandler};
use crate::accepted_memory_review_receipt_persistence::decode_persisted_accepted_memory_review_receipt;
use crate::accepted_memory_review_receipt_storage_diagnostics::{
    AcceptedMemoryReviewReceiptStorageDiagnosticRecord,
    AcceptedMemoryReviewReceiptStorageDiagnostics,
};
use crate::control_api::{
    AcceptedMemoryReviewReceiptStorageDiagnosticsQuery, ServerControlError, ServerQueryResult,
};

pub(crate) fn accepted_memory_review_receipt_storage_diagnostics_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: AcceptedMemoryReviewReceiptStorageDiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "accepted memory review receipt storage diagnostics requires a project"
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
        if record.kind != PersistenceRecordKind::SharedMemoryReviewReceipt {
            diagnostic_records.push(
                AcceptedMemoryReviewReceiptStorageDiagnosticRecord::UnsupportedRecordSkipped {
                    record_id: record.id.0,
                },
            );
            continue;
        }

        match decode_persisted_accepted_memory_review_receipt(&record) {
            Ok(receipt) => diagnostic_records
                .push(AcceptedMemoryReviewReceiptStorageDiagnosticRecord::Persisted(receipt)),
            Err(_) => diagnostic_records.push(
                AcceptedMemoryReviewReceiptStorageDiagnosticRecord::DecodeFailedSkipped {
                    record_id: record.id.0,
                },
            ),
        }
    }

    Ok(
        ServerQueryResult::AcceptedMemoryReviewReceiptStorageDiagnostics(
            AcceptedMemoryReviewReceiptStorageDiagnostics::from_records(
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
    use nucleus_memory::{
        encode_accepted_memory_review_receipt_storage_payload,
        AcceptedMemoryReviewReceiptAdmissionStatusStorage,
        AcceptedMemoryReviewReceiptDecisionStorage, AcceptedMemoryReviewReceiptStatusStorage,
        AcceptedMemoryReviewReceiptStorageRecord,
        ACCEPTED_MEMORY_REVIEW_RECEIPT_STORAGE_SCHEMA_VERSION,
    };
    use nucleus_projects::ProjectId;

    use super::*;
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn review_receipt_storage_diagnostics_reads_persisted_receipts() {
        let (_temp_dir, handler) = handler();
        persist_review_receipt(&handler, "accepted-memory-import-apply-review:command:1");
        persist_unsupported_shared_memory_record(&handler);

        let diagnostics = query_diagnostics(&handler);

        assert_eq!(diagnostics.project_id.0, "project:nucleus");
        assert_eq!(diagnostics.receipts.len(), 1);
        assert_eq!(diagnostics.counts.records, 1);
        assert_eq!(diagnostics.counts.approved, 1);
        assert_eq!(diagnostics.counts.admitted, 1);
        assert_eq!(diagnostics.counts.provenance_refs, 1);
        assert_eq!(diagnostics.counts.evidence_refs, 1);
        assert_eq!(diagnostics.counts.unsupported_records_skipped, 1);
        assert_eq!(diagnostics.counts.decode_failed_records, 0);
        assert!(diagnostics.review_receipts_persisted);
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
    ) -> AcceptedMemoryReviewReceiptStorageDiagnostics {
        let result = accepted_memory_review_receipt_storage_diagnostics_query(
            handler,
            AcceptedMemoryReviewReceiptStorageDiagnosticsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect("accepted memory review receipt storage diagnostics");

        let ServerQueryResult::AcceptedMemoryReviewReceiptStorageDiagnostics(diagnostics) = result
        else {
            panic!("expected accepted memory review receipt storage diagnostics");
        };

        diagnostics
    }

    fn persist_review_receipt(
        handler: &LocalControlRequestHandler<SqliteBackend>,
        receipt_id: &str,
    ) {
        let payload = encode_accepted_memory_review_receipt_storage_payload(&receipt(receipt_id))
            .expect("encode review receipt");
        handler
            .state()
            .shared_memory()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId(receipt_id.to_owned()),
                    domain: PersistenceDomain::SharedMemory,
                    kind: PersistenceRecordKind::SharedMemoryReviewReceipt,
                    revision_id: RevisionId(format!("rev:{receipt_id}")),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: payload,
                    },
                },
                RevisionExpectation::Any,
            )
            .expect("persist review receipt");
    }

    fn persist_unsupported_shared_memory_record(
        handler: &LocalControlRequestHandler<SqliteBackend>,
    ) {
        handler
            .state()
            .shared_memory()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId("memory:unsupported".to_owned()),
                    domain: PersistenceDomain::SharedMemory,
                    kind: PersistenceRecordKind::SharedMemoryRecord,
                    revision_id: RevisionId("rev:unsupported".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: b"{}".to_vec(),
                    },
                },
                RevisionExpectation::Any,
            )
            .expect("persist unsupported record");
    }

    fn receipt(receipt_id: &str) -> AcceptedMemoryReviewReceiptStorageRecord {
        AcceptedMemoryReviewReceiptStorageRecord {
            schema_version: ACCEPTED_MEMORY_REVIEW_RECEIPT_STORAGE_SCHEMA_VERSION,
            review_receipt_id: receipt_id.to_owned(),
            project_id: "project:nucleus".to_owned(),
            command_id: "command:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            approval_ref: Some("approval:1".to_owned()),
            decision_reason_ref: None,
            apply_admission_ref: "apply-admission:1".to_owned(),
            import_admission_ref: "import-admission:1".to_owned(),
            conflict_ref: "conflict:1".to_owned(),
            candidate_ref: "candidate:1".to_owned(),
            memory_id: "memory:1".to_owned(),
            file_ref: "nucleus/memory/memory-1.toml".to_owned(),
            provenance_refs: vec!["provenance:1".to_owned()],
            evidence_refs: vec!["evidence:1".to_owned()],
            decision: AcceptedMemoryReviewReceiptDecisionStorage::Approve,
            status: AcceptedMemoryReviewReceiptStatusStorage::Approved,
            admission_status: AcceptedMemoryReviewReceiptAdmissionStatusStorage::Admitted,
            blockers: Vec::new(),
            admission_blockers: Vec::new(),
            reviewed_at: None,
            updated_at: None,
        }
    }
}
