use super::evidence::{evidence_refs, has_active_work};
use super::refs::{clean_optional, clean_refs};
use crate::{
    SelectedTaskReviewEvidenceSummary, SelectedTaskReviewNextCategory, SelectedTaskReviewNextStep,
    SelectedTaskReviewState, SelectedTaskReviewSummary, TaskWorkflowDrilldown,
    TaskWorkflowGuidanceSource, TaskWorkflowNextStepSource, TaskWorkflowSafeAction,
};

pub(super) fn next_step(
    drilldown: &TaskWorkflowDrilldown,
    review: &SelectedTaskReviewSummary,
    evidence: &SelectedTaskReviewEvidenceSummary,
) -> SelectedTaskReviewNextStep {
    match review.state {
        SelectedTaskReviewState::AwaitingReview => next(
            SelectedTaskReviewNextCategory::ReviewEvidence,
            "review selected task evidence",
            review.work_item_refs.first().cloned(),
            review.evidence_refs.clone(),
        ),
        SelectedTaskReviewState::Rejected | SelectedTaskReviewState::NeedsChanges => next(
            SelectedTaskReviewNextCategory::Rework,
            "prepare rework from review outcome",
            review.work_item_refs.first().cloned(),
            review.evidence_refs.clone(),
        ),
        SelectedTaskReviewState::Accepted if !drilldown.scm_handoff.handoff_refs.is_empty() => {
            next(
                SelectedTaskReviewNextCategory::ScmHandoff,
                "inspect SCM handoff readiness after accepted review",
                drilldown.scm_handoff.handoff_refs.first().cloned(),
                drilldown.scm_handoff.handoff_refs.clone(),
            )
        }
        SelectedTaskReviewState::Accepted => next(
            SelectedTaskReviewNextCategory::TaskCommand,
            "review accepted work before an explicit task completion command",
            drilldown.next.next_ref.clone(),
            evidence_refs(evidence),
        ),
        SelectedTaskReviewState::Abandoned => next(
            SelectedTaskReviewNextCategory::PlanningAmbiguity,
            "review was abandoned; choose a new pathway before continuing",
            drilldown.next.next_ref.clone(),
            review.evidence_refs.clone(),
        ),
        SelectedTaskReviewState::NotReady => fallback_next_step(drilldown, evidence),
    }
}

fn fallback_next_step(
    drilldown: &TaskWorkflowDrilldown,
    evidence: &SelectedTaskReviewEvidenceSummary,
) -> SelectedTaskReviewNextStep {
    if has_active_work(drilldown)
        || drilldown.guidance.source == TaskWorkflowGuidanceSource::Runtime
        || drilldown.guidance.safe_action == TaskWorkflowSafeAction::Inspect
    {
        return next(
            SelectedTaskReviewNextCategory::InspectRuntime,
            "inspect selected task runtime evidence before review",
            drilldown.next.next_ref.clone(),
            evidence_refs(evidence),
        );
    }

    if drilldown.next.source == TaskWorkflowNextStepSource::BlockedByMissingPathway {
        return next(
            SelectedTaskReviewNextCategory::PlanningAmbiguity,
            drilldown
                .next
                .blocked_reason
                .as_deref()
                .unwrap_or("no selected-task next pathway is available"),
            None,
            drilldown.next.rationale_refs.clone(),
        );
    }

    if drilldown
        .task
        .as_ref()
        .is_some_and(|task| matches!(task.activity.as_str(), "done" | "archived"))
    {
        return next(
            SelectedTaskReviewNextCategory::Wait,
            "selected task is closed; no review action is available",
            drilldown.next.next_ref.clone(),
            drilldown.next.rationale_refs.clone(),
        );
    }

    next(
        SelectedTaskReviewNextCategory::TaskCommand,
        drilldown.next.summary.as_str(),
        drilldown.next.next_ref.clone(),
        drilldown.next.rationale_refs.clone(),
    )
}

fn next(
    category: SelectedTaskReviewNextCategory,
    summary: impl Into<String>,
    next_ref: Option<String>,
    rationale_refs: Vec<String>,
) -> SelectedTaskReviewNextStep {
    SelectedTaskReviewNextStep {
        category,
        summary: summary.into().trim().to_owned(),
        next_ref: next_ref.and_then(clean_optional),
        rationale_refs: clean_refs(rationale_refs),
    }
}
