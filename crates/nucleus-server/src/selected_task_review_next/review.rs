use super::evidence::{
    active_work_refs, evidence_refs, has_active_work, item_evidence_refs, item_has_review_evidence,
};
use super::refs::clean_refs;
use crate::{
    SelectedTaskReviewEvidenceSummary, SelectedTaskReviewState, SelectedTaskReviewSummary,
    TaskWorkflowDrilldown, TaskWorkflowWorkProgressItem,
};

pub(super) fn review_summary(
    drilldown: &TaskWorkflowDrilldown,
    evidence: &SelectedTaskReviewEvidenceSummary,
) -> SelectedTaskReviewSummary {
    if drilldown.task.is_none() {
        return review(
            SelectedTaskReviewState::NotReady,
            "selected task identity is missing",
            Vec::new(),
            evidence_refs(evidence),
        );
    }

    if has_active_work(drilldown) {
        return review(
            SelectedTaskReviewState::NotReady,
            "active task work exists; inspect runtime evidence before review",
            active_work_refs(drilldown),
            evidence_refs(evidence),
        );
    }

    if let Some(item) = prioritized_review_item(drilldown) {
        let state = review_state(&item.review_status);
        return review(
            state,
            review_reason(state, item),
            vec![item.work_item_ref.clone()],
            item_evidence_refs(item, evidence),
        );
    }

    if !drilldown.runtime.task_completion_refs.is_empty()
        || !drilldown.review.review_refs.is_empty()
    {
        return review(
            SelectedTaskReviewState::AwaitingReview,
            "task-level completion or review evidence exists without work-item projection",
            Vec::new(),
            evidence_refs(evidence),
        );
    }

    review(
        SelectedTaskReviewState::NotReady,
        "no reviewable runtime result exists for the selected task",
        Vec::new(),
        evidence_refs(evidence),
    )
}

fn prioritized_review_item(
    drilldown: &TaskWorkflowDrilldown,
) -> Option<&TaskWorkflowWorkProgressItem> {
    drilldown
        .work_progress
        .work_items
        .iter()
        .filter(|item| item.runtime_status == "completed")
        .max_by_key(|item| review_priority(review_state(&item.review_status)))
}

fn review_priority(state: SelectedTaskReviewState) -> u8 {
    match state {
        SelectedTaskReviewState::AwaitingReview => 6,
        SelectedTaskReviewState::NeedsChanges => 5,
        SelectedTaskReviewState::Rejected => 4,
        SelectedTaskReviewState::Accepted => 3,
        SelectedTaskReviewState::Abandoned => 2,
        SelectedTaskReviewState::NotReady => 1,
    }
}

fn review_state(status: &str) -> SelectedTaskReviewState {
    match status
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .as_str()
    {
        "awaiting_review" => SelectedTaskReviewState::AwaitingReview,
        "accepted" => SelectedTaskReviewState::Accepted,
        "rejected" => SelectedTaskReviewState::Rejected,
        "needs_changes" => SelectedTaskReviewState::NeedsChanges,
        "abandoned" => SelectedTaskReviewState::Abandoned,
        _ => SelectedTaskReviewState::NotReady,
    }
}

fn review_reason(state: SelectedTaskReviewState, item: &TaskWorkflowWorkProgressItem) -> String {
    match state {
        SelectedTaskReviewState::NotReady if item_has_review_evidence(item) => {
            "completed work has evidence and can be prepared for review".to_owned()
        }
        SelectedTaskReviewState::NotReady => {
            "completed work item is not marked ready for review".to_owned()
        }
        SelectedTaskReviewState::AwaitingReview => {
            "completed work item is awaiting operator review".to_owned()
        }
        SelectedTaskReviewState::Accepted => {
            "work item review was accepted; task completion remains separate".to_owned()
        }
        SelectedTaskReviewState::Rejected => {
            "work item review was rejected and needs a rework path".to_owned()
        }
        SelectedTaskReviewState::NeedsChanges => {
            "work item review requested changes and needs a rework path".to_owned()
        }
        SelectedTaskReviewState::Abandoned => {
            "work item review was abandoned and needs a new pathway before continuation".to_owned()
        }
    }
}

fn review(
    state: SelectedTaskReviewState,
    reason: impl Into<String>,
    work_item_refs: Vec<String>,
    evidence_refs: Vec<String>,
) -> SelectedTaskReviewSummary {
    SelectedTaskReviewSummary {
        state,
        reason: reason.into(),
        work_item_refs: clean_refs(work_item_refs),
        evidence_refs: clean_refs(evidence_refs),
    }
}
