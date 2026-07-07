use super::evidence::{evidence_summary, gaps, source_counts};
use super::next::next_step;
use super::review::review_summary;
use crate::{SelectedTaskReviewNext, TaskWorkflowDrilldown, TaskWorkflowNoEffects};

pub fn selected_task_review_next(drilldown: &TaskWorkflowDrilldown) -> SelectedTaskReviewNext {
    let evidence = evidence_summary(drilldown);
    let source_counts = source_counts(drilldown, &evidence);
    let gaps = gaps(drilldown, &source_counts);
    let review = review_summary(drilldown, &evidence);
    let next = next_step(drilldown, &review, &evidence);

    SelectedTaskReviewNext {
        review_next_id: format!("selected-task-review-next:{}", drilldown.task_id.0),
        project_id: drilldown.project_id.clone(),
        task_id: drilldown.task_id.clone(),
        review,
        evidence,
        next,
        source_counts,
        gaps,
        no_effects: TaskWorkflowNoEffects::read_only(),
    }
}
