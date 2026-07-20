use crate::provider_no_effects::MemoryApplyNoEffects;
use nucleus_projects::ProjectId;

use crate::accepted_memory_import_apply_review_command::{
    accepted_memory_import_apply_review_receipts, AcceptedMemoryImportApplyReviewDecision,
    AcceptedMemoryImportApplyReviewInput,
};
use crate::accepted_memory_import_apply_review_diagnostics::AcceptedMemoryImportApplyReviewDiagnostics;
use crate::accepted_memory_projection_import_apply_admission::{
    AcceptedMemoryProjectionImportApplyAdmissionRecord,
    AcceptedMemoryProjectionImportApplyAdmissionStatus,
};
use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ServerControlRequestId,
    ServerControlResponse, ServerControlResponseBody, ServerControlResponseStatus,
    ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_import_apply_review_diagnostics_without_payloads() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId(
            "request:dto:accepted-memory-import-apply-review".to_owned(),
        ),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(
            ServerQueryResult::AcceptedMemoryImportApplyReviewDiagnostics(
                AcceptedMemoryImportApplyReviewDiagnostics {
                    diagnostics_id: "accepted-memory-import-apply-review-diagnostics".to_owned(),
                    project_id: ProjectId("project:nucleus".to_owned()),
                    review_set: accepted_memory_import_apply_review_receipts(vec![
                        input(AcceptedMemoryImportApplyReviewDecision::Approve),
                        input(AcceptedMemoryImportApplyReviewDecision::Defer),
                        input(AcceptedMemoryImportApplyReviewDecision::Reject),
                    ]),
                    review_receipts_persisted: false,
                    no_effects: MemoryApplyNoEffects::none(),
                },
            ),
        ),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::AcceptedMemoryImportApplyReviewDiagnostics { diagnostics }
            if diagnostics.project_id == "project:nucleus"
                && diagnostics.receipts.len() == 3
                && diagnostics.counts.approved == 1
                && diagnostics.counts.deferred == 1
                && diagnostics.counts.rejected == 1
                && diagnostics.counts.approval_required == 1
                && diagnostics.receipts[0].admission_status == "admitted"
                && diagnostics.receipts[0].decision == "approve"
                && diagnostics.receipts[0].status == "approved"
                && !diagnostics.review_receipts_persisted
                && !diagnostics.no_effects.active_memory_apply_performed
                && !diagnostics.no_effects.projection_write_performed
                && !diagnostics.no_effects.scm_effect_performed
                && !diagnostics.no_effects.embedding_available
                && !diagnostics.no_effects.provider_sync_available
                && !diagnostics.no_effects.automatic_extraction_performed
                && !diagnostics.no_effects.task_mutation_performed
                && !diagnostics.no_effects.agent_scheduling_performed
                && !diagnostics.no_effects.ui_effect_performed
    ));
    assert!(json.contains("\"type\":\"accepted_memory_import_apply_review_diagnostics\""));
    assert!(!json.contains("raw_transcript"));
    assert!(!json.contains("provider_payload"));
    assert!(!json.contains("private_memory_body"));
    assert!(!json.contains("terminal_stream"));
}

fn input(
    decision: AcceptedMemoryImportApplyReviewDecision,
) -> AcceptedMemoryImportApplyReviewInput {
    AcceptedMemoryImportApplyReviewInput {
        command_id: format!("command:review:{decision:?}").to_lowercase(),
        operator_ref: "operator:tom".to_owned(),
        approval_ref: match decision {
            AcceptedMemoryImportApplyReviewDecision::Approve => "approval:1".to_owned(),
            AcceptedMemoryImportApplyReviewDecision::Defer
            | AcceptedMemoryImportApplyReviewDecision::Reject => String::new(),
        },
        decision_reason_ref: match decision {
            AcceptedMemoryImportApplyReviewDecision::Approve => String::new(),
            AcceptedMemoryImportApplyReviewDecision::Defer
            | AcceptedMemoryImportApplyReviewDecision::Reject => "reason:1".to_owned(),
        },
        decision,
        provenance_refs: vec!["provenance:1".to_owned()],
        evidence_refs: vec!["evidence:1".to_owned()],
        admission: admission(),
        raw_payload_present: false,
        active_memory_mutation_requested: false,
        projection_write_requested: false,
        scm_effect_requested: false,
        embedding_requested: false,
        provider_sync_requested: false,
        automatic_extraction_requested: false,
        task_mutation_requested: false,
        agent_scheduling_requested: false,
        ui_effect_requested: false,
    }
}

fn admission() -> AcceptedMemoryProjectionImportApplyAdmissionRecord {
    AcceptedMemoryProjectionImportApplyAdmissionRecord {
        apply_admission_ref: "accepted-memory-import-apply-admission:request:1".to_owned(),
        request_id: "request:1".to_owned(),
        import_admission_ref: "accepted-memory-import-admission:candidate".to_owned(),
        conflict_ref: "accepted-memory-import-conflict:admission".to_owned(),
        candidate_ref: "accepted-memory-import-candidate:nucleus/memory/memory:1.toml".to_owned(),
        memory_id: Some("memory:1".to_owned()),
        file_ref: "nucleus/memory/memory:1.toml".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        approval_ref: "approval:apply".to_owned(),
        provenance_refs: vec!["nucleus/memory/memory:1.toml".to_owned()],
        evidence_refs: vec!["candidate:1".to_owned(), "admission:1".to_owned()],
        status: AcceptedMemoryProjectionImportApplyAdmissionStatus::Admitted,
        blockers: Vec::new(),
        no_effects: MemoryApplyNoEffects::none(),
    }
}
