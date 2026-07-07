use nucleus_server::{
    ControlSelectedTaskScmHandoffDto, ControlSelectedTaskScmHandoffEvidenceDto,
    ControlSelectedTaskScmHandoffGapDto, ControlSelectedTaskScmHandoffNextStepDto,
    ControlSelectedTaskScmHandoffNoEffectsDto, ControlSelectedTaskScmHandoffSourceCountsDto,
    ControlSelectedTaskScmHandoffSummaryDto, ControlSelectedTaskScmHandoffTargetDto,
};

use super::*;

#[test]
fn selected_task_scm_handoff_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::selected_task_scm_handoff_response_lines(
        "selected-task-scm-handoff",
        ControlSelectedTaskScmHandoffDto {
            handoff_id: "selected-task-scm-handoff:task:nucleus-local:bootstrap".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            readiness: ControlSelectedTaskScmHandoffSummaryDto {
                state: "prep_ready".to_owned(),
                reason: "change-request preparation evidence is ready for operator review"
                    .to_owned(),
                handoff_refs: vec!["scm-session:1".to_owned(), "change:1".to_owned()],
                blocker_refs: Vec::new(),
            },
            target: ControlSelectedTaskScmHandoffTargetDto {
                shape: "forge_review".to_owned(),
                target_refs: vec!["forge-review:target:1".to_owned()],
            },
            evidence: ControlSelectedTaskScmHandoffEvidenceDto {
                work_item_refs: vec!["work:1".to_owned()],
                scm_handoff_refs: vec!["scm-session:1".to_owned(), "change:1".to_owned()],
                scm_work_session_refs: vec!["scm-session:1".to_owned()],
                provider_change_refs: vec!["change:1".to_owned()],
                checkpoint_refs: vec!["checkpoint:1".to_owned()],
                diff_summary_refs: vec!["diff:1".to_owned()],
                runtime_receipt_refs: vec!["receipt:1".to_owned()],
                validation_refs: vec!["validation:1".to_owned()],
                review_refs: vec!["review:1".to_owned()],
                change_request_prep_refs: vec!["change-request-prep:1".to_owned()],
                repair_refs: Vec::new(),
            },
            next: ControlSelectedTaskScmHandoffNextStepDto {
                category: "review_preparation".to_owned(),
                summary: "Review the prepared handoff package".to_owned(),
                next_ref: Some("change-request-prep:1".to_owned()),
                rationale_refs: vec!["change-request-prep:1".to_owned()],
            },
            source_counts: ControlSelectedTaskScmHandoffSourceCountsDto {
                task_records: 1,
                work_items: 1,
                scm_handoff_refs: 2,
                scm_work_session_refs: 1,
                provider_change_refs: 1,
                checkpoint_refs: 1,
                diff_summary_refs: 1,
                runtime_receipt_refs: 1,
                validation_refs: 1,
                review_refs: 1,
                change_request_prep_refs: 1,
                repair_refs: 0,
                gap_count: 0,
            },
            gaps: vec![ControlSelectedTaskScmHandoffGapDto {
                area: "target".to_owned(),
                reason: "target is read-only".to_owned(),
            }],
            no_effects: ControlSelectedTaskScmHandoffNoEffectsDto {
                scm_mutation_performed: false,
                forge_mutation_performed: false,
                credential_resolution_performed: false,
                task_mutation_performed: false,
                provider_execution_performed: false,
                review_mutation_performed: false,
                accepted_memory_apply_performed: false,
                planning_apply_performed: false,
                projection_write_performed: false,
                ui_effect_performed: false,
            },
        },
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=selected-task-scm-handoff"));
    assert!(rendered.contains("readiness state=prep_ready handoff_refs=2 blocker_refs=0"));
    assert!(rendered.contains("target shape=forge_review target_refs=1"));
    assert!(rendered.contains("next category=review_preparation next_ref=change-request-prep:1"));
    assert!(rendered.contains("scm_mutation=false"));
    assert!(rendered.contains("forge_mutation=false"));
    assert!(rendered.contains("credential_resolution=false"));
    assert!(rendered.contains("client_can_publish=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(!rendered.contains("raw_payload"));
    assert!(!rendered.contains("private:context"));
}
