use nucleus_server::{
    ControlSelectedTaskReviewDecisionAdmissionDto, ControlSelectedTaskReviewDecisionNoEffectsDto,
    ControlSelectedTaskReviewDecisionRecordDto,
};

use super::*;

#[test]
fn selected_task_review_decision_admission_response_lines_are_dry_run_and_sanitized() {
    let lines = typed_response::selected_task_review_decision_admission_response_lines(
        "selected-task-review-decision-admission",
        ControlSelectedTaskReviewDecisionAdmissionDto {
            admission_id: "selected-task-review-decision-admission:task:nucleus-local:bootstrap"
                .to_owned(),
            decision_id: "selected-task-review-decision:task:nucleus-local:bootstrap:accept"
                .to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            action: "accept_evidence".to_owned(),
            status: "missing_evidence".to_owned(),
            command: None,
            refusal: None,
            operator_ref: "operator:test".to_owned(),
            evidence_refs: Vec::new(),
            no_effects: ControlSelectedTaskReviewDecisionNoEffectsDto {
                review_mutation_performed: false,
                task_mutation_performed: false,
                provider_execution_performed: false,
                provider_write_performed: false,
                scm_or_forge_mutation_performed: false,
                accepted_memory_apply_performed: false,
                planning_apply_performed: false,
                projection_write_performed: false,
                agent_scheduling_performed: false,
                ui_effect_performed: false,
            },
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=selected-task-review-decision-admission"));
    assert!(rendered.contains("mode=dry_run"));
    assert!(rendered.contains("status=missing_evidence"));
    assert!(rendered.contains("action=accept_evidence"));
    assert!(rendered.contains("review_mutation_performed=false"));
    assert!(rendered.contains("provider_execution_performed=false"));
    assert!(rendered.contains("scm_or_forge_mutation_performed=false"));
    assert!(rendered.contains("client_can_mutate=false"));
    assert!(!rendered.contains("raw_payload"));
    assert!(!rendered.contains("access_token"));
}

#[test]
fn selected_task_review_decision_apply_response_lines_are_sanitized() {
    let lines = typed_response::selected_task_review_decision_apply_response_lines(
        "selected-task-review-decision-apply",
        ControlSelectedTaskReviewDecisionRecordDto {
            decision_id: "selected-task-review-decision:task:nucleus-local:bootstrap:accept"
                .to_owned(),
            admission_id: "selected-task-review-decision-admission:task:nucleus-local:bootstrap"
                .to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            work_item_refs: Vec::new(),
            action: "accept_evidence".to_owned(),
            outcome: "accepted".to_owned(),
            operator_ref: "operator:test".to_owned(),
            expected_revision: String::new(),
            reviewed_evidence_refs: Vec::new(),
            receipt_refs: Vec::new(),
            timeline_refs: Vec::new(),
            reason_summary: None,
            idempotency_key: "idempotency:test".to_owned(),
            status: "blocked".to_owned(),
            blockers: vec!["admission_not_admitted".to_owned()],
            duplicate_decision_detected: false,
            review_mutation_performed: false,
            task_lifecycle_mutation_performed: false,
            provider_execution_performed: false,
            provider_write_performed: false,
            scm_or_forge_mutation_performed: false,
            accepted_memory_apply_performed: false,
            planning_apply_performed: false,
            projection_write_performed: false,
            agent_scheduling_performed: false,
            ui_effect_performed: false,
            raw_provider_material_retained: false,
            raw_command_output_retained: false,
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=selected-task-review-decision-apply"));
    assert!(rendered.contains("mode=apply"));
    assert!(rendered.contains("status=blocked"));
    assert!(rendered.contains("blockers=1"));
    assert!(rendered.contains("review_mutation_performed=false"));
    assert!(rendered.contains("provider_execution_performed=false"));
    assert!(rendered.contains("raw_provider_material_retained=false"));
    assert!(rendered.contains("raw_command_output_retained=false"));
    assert!(!rendered.contains("raw_payload"));
    assert!(!rendered.contains("access_token"));
}
