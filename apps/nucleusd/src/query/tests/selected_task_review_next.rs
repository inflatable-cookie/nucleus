use nucleus_server::{
    ControlSelectedTaskReviewEvidenceDto, ControlSelectedTaskReviewGapDto,
    ControlSelectedTaskReviewNextDto, ControlSelectedTaskReviewNextNoEffectsDto,
    ControlSelectedTaskReviewNextSourceCountsDto, ControlSelectedTaskReviewNextStepDto,
    ControlSelectedTaskReviewSummaryDto,
};

use super::*;

#[test]
fn selected_task_review_next_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::selected_task_review_next_response_lines(
        "selected-task-review-next",
        ControlSelectedTaskReviewNextDto {
            review_next_id: "selected-task-review-next:task:nucleus-local:bootstrap".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            review: ControlSelectedTaskReviewSummaryDto {
                state: "awaiting_review".to_owned(),
                reason: "completed work is awaiting review".to_owned(),
                work_item_refs: vec!["work:1".to_owned()],
                evidence_refs: vec!["checkpoint:1".to_owned(), "diff:1".to_owned()],
            },
            evidence: ControlSelectedTaskReviewEvidenceDto {
                receipt_refs: vec!["receipt:1".to_owned()],
                checkpoint_refs: vec!["checkpoint:1".to_owned()],
                diff_summary_refs: vec!["diff:1".to_owned()],
                validation_refs: vec!["validation:1".to_owned()],
                timeline_refs: vec!["timeline:1".to_owned()],
                review_refs: Vec::new(),
            },
            next: ControlSelectedTaskReviewNextStepDto {
                category: "review_evidence".to_owned(),
                summary: "Review selected task evidence".to_owned(),
                next_ref: Some("work:1".to_owned()),
                rationale_refs: vec!["completion:1".to_owned()],
            },
            source_counts: ControlSelectedTaskReviewNextSourceCountsDto {
                task_records: 1,
                work_items: 1,
                active_work_items: 0,
                completed_work_items: 1,
                reviewable_work_items: 1,
                receipt_refs: 1,
                checkpoint_refs: 1,
                diff_summary_refs: 1,
                validation_refs: 1,
                timeline_refs: 1,
                review_refs: 0,
                task_completion_refs: 1,
                guidance_refs: 1,
                gap_count: 0,
            },
            gaps: vec![ControlSelectedTaskReviewGapDto {
                area: "review_evidence".to_owned(),
                reason: "review receipt has not been captured yet".to_owned(),
            }],
            no_effects: ControlSelectedTaskReviewNextNoEffectsDto {
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

    assert!(rendered.contains("domain=selected-task-review-next"));
    assert!(rendered.contains("review state=awaiting_review work_item_refs=1 evidence_refs=2"));
    assert!(rendered.contains("next category=review_evidence next_ref=work:1"));
    assert!(rendered.contains("reviewable_work_items=1"));
    assert!(rendered.contains("review_mutation=false"));
    assert!(rendered.contains("task_mutation=false"));
    assert!(rendered.contains("client_can_review=false"));
    assert!(rendered.contains("payloads_exposed=false"));
    assert!(!rendered.contains("raw_payload"));
    assert!(!rendered.contains("private:context"));
}
