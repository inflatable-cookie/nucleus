use nucleus_memory::{
    AcceptedMemoryReviewReceiptAdmissionStatusStorage, AcceptedMemoryReviewReceiptDecisionStorage,
    AcceptedMemoryReviewReceiptStatusStorage, AcceptedMemoryReviewReceiptStorageRecord,
};
use nucleus_projects::ProjectId;

use crate::accepted_memory_active_apply_diagnostics::{
    AcceptedMemoryActiveApplyDiagnosticRecord, AcceptedMemoryActiveApplyDiagnostics,
};
use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_active_apply_diagnostics_without_payloads() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:accepted-memory-active-apply".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryActiveApplyDiagnostics(
                AcceptedMemoryActiveApplyDiagnostics::from_records(
                    ProjectId("project:nucleus".to_owned()),
                    vec![
                        AcceptedMemoryActiveApplyDiagnosticRecord::PersistedReviewReceipt(receipt()),
                    ],
                ),
            ),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::AcceptedMemoryActiveApplyDiagnostics { diagnostics }
            if diagnostics.project_id == "project:nucleus"
                && diagnostics.records.len() == 1
                && diagnostics.counts.source_records == 1
                && diagnostics.counts.admitted == 1
                && diagnostics.counts.blocked == 0
                && diagnostics.records[0].review_decision == "approve"
                && diagnostics.records[0].review_status == "approved"
                && diagnostics.records[0].review_admission_status == "admitted"
                && diagnostics.records[0].status == "admitted"
                && !diagnostics.active_memory_apply_performed
                && !diagnostics.projection_write_performed
                && !diagnostics.scm_effect_performed
                && !diagnostics.embedding_available
                && !diagnostics.provider_sync_available
                && !diagnostics.automatic_extraction_performed
                && !diagnostics.task_mutation_performed
                && !diagnostics.agent_scheduling_performed
                && !diagnostics.ui_effect_performed
    ));
    assert!(json.contains("\"type\":\"accepted_memory_active_apply_diagnostics\""));
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
