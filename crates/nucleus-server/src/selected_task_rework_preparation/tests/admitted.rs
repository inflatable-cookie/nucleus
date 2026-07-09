use crate::{
    selected_task_rework_preparation, SelectedTaskReviewDecisionOutcome,
    SelectedTaskReworkPreparationStatus,
};

use super::helpers::input;

#[test]
fn rejected_review_admits_rework_preparation_without_effects() {
    let preparation = selected_task_rework_preparation(input(
        "rejected",
        SelectedTaskReviewDecisionOutcome::Rejected,
    ));

    assert_eq!(
        preparation.status,
        SelectedTaskReworkPreparationStatus::Admitted
    );
    assert!(preparation.refusal.is_none());
    assert_eq!(
        preparation.review_decision_ref.as_deref(),
        Some("selected-task-review-decision:task:1:001")
    );
    assert_eq!(preparation.reviewed_work_item_refs, vec!["work:1"]);
    assert!(!preparation.reviewed_evidence_refs.is_empty());
    assert!(preparation.rework_summary.is_some());
    assert!(!preparation.no_effects.work_item_creation_performed);
    assert!(!preparation.no_effects.task_lifecycle_mutation_performed);
    assert!(!preparation.no_effects.provider_execution_performed);
    assert!(!preparation.no_effects.scm_or_forge_mutation_performed);
    assert!(!preparation.no_effects.agent_scheduling_performed);
}

#[test]
fn needs_changes_review_admits_rework_preparation() {
    let preparation = selected_task_rework_preparation(input(
        "needs_changes",
        SelectedTaskReviewDecisionOutcome::NeedsChanges,
    ));

    assert_eq!(
        preparation.status,
        SelectedTaskReworkPreparationStatus::Admitted
    );
    assert!(preparation.refusal.is_none());
    assert!(preparation.rework_summary.is_some());
}
