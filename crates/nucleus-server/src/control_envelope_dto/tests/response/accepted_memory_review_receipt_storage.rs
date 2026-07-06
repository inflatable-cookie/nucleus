use nucleus_memory::{
    AcceptedMemoryReviewReceiptAdmissionStatusStorage, AcceptedMemoryReviewReceiptDecisionStorage,
    AcceptedMemoryReviewReceiptStatusStorage, AcceptedMemoryReviewReceiptStorageRecord,
};
use nucleus_projects::ProjectId;

use crate::accepted_memory_review_receipt_storage_diagnostics::{
    AcceptedMemoryReviewReceiptStorageDiagnosticRecord,
    AcceptedMemoryReviewReceiptStorageDiagnostics,
};
use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_review_receipt_storage_diagnostics() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:accepted-memory-review-receipt-storage".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryReviewReceiptStorageDiagnostics(
                AcceptedMemoryReviewReceiptStorageDiagnostics::from_records(
                    ProjectId("project:nucleus".to_owned()),
                    vec![AcceptedMemoryReviewReceiptStorageDiagnosticRecord::Persisted(receipt())],
                ),
            ),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::AcceptedMemoryReviewReceiptStorageDiagnostics { diagnostics }
            if diagnostics.project_id == "project:nucleus"
                && diagnostics.receipts.len() == 1
                && diagnostics.counts.records == 1
                && diagnostics.counts.approved == 1
                && diagnostics.counts.admitted == 1
                && diagnostics.receipts[0].decision == "approve"
                && diagnostics.receipts[0].status == "approved"
                && diagnostics.receipts[0].admission_status == "admitted"
                && diagnostics.review_receipts_persisted
                && !diagnostics.active_memory_apply_performed
                && !diagnostics.projection_write_performed
                && !diagnostics.scm_effect_performed
    ));
    assert!(json.contains("\"type\":\"accepted_memory_review_receipt_storage_diagnostics\""));
    assert!(!json.contains("raw_transcript"));
    assert!(!json.contains("provider_payload"));
    assert!(!json.contains("private_memory_body"));
    assert!(!json.contains("terminal_stream"));
}

fn receipt() -> AcceptedMemoryReviewReceiptStorageRecord {
    AcceptedMemoryReviewReceiptStorageRecord {
        schema_version: 1,
        review_receipt_id: "accepted-memory-import-apply-review:command:1".to_owned(),
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
