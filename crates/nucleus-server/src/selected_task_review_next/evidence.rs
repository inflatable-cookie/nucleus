use super::refs::clean_refs;
use crate::{
    SelectedTaskReviewEvidenceSummary, SelectedTaskReviewNextGap, SelectedTaskReviewNextGapArea,
    SelectedTaskReviewNextSourceCounts, TaskWorkflowDrilldown, TaskWorkflowNextStepSource,
    TaskWorkflowWorkProgressItem,
};

pub(super) fn evidence_summary(
    drilldown: &TaskWorkflowDrilldown,
) -> SelectedTaskReviewEvidenceSummary {
    SelectedTaskReviewEvidenceSummary {
        receipt_refs: clean_refs(
            drilldown
                .runtime
                .runtime_receipt_refs
                .iter()
                .chain(
                    drilldown
                        .work_progress
                        .work_items
                        .iter()
                        .flat_map(|item| item.receipt_refs.iter()),
                )
                .cloned()
                .collect(),
        ),
        checkpoint_refs: clean_refs(
            drilldown
                .work_progress
                .work_items
                .iter()
                .flat_map(|item| item.checkpoint_refs.iter().cloned())
                .collect(),
        ),
        diff_summary_refs: clean_refs(
            drilldown
                .work_progress
                .work_items
                .iter()
                .flat_map(|item| item.diff_summary_refs.iter().cloned())
                .collect(),
        ),
        validation_refs: clean_refs(
            drilldown
                .work_progress
                .work_items
                .iter()
                .flat_map(|item| item.validation_refs.iter().cloned())
                .collect(),
        ),
        timeline_refs: clean_refs(
            drilldown
                .timeline
                .entry_refs
                .iter()
                .chain(
                    drilldown
                        .work_progress
                        .work_items
                        .iter()
                        .flat_map(|item| item.timeline_entry_refs.iter()),
                )
                .cloned()
                .collect(),
        ),
        review_refs: clean_refs(drilldown.review.review_refs.clone()),
    }
}

pub(super) fn source_counts(
    drilldown: &TaskWorkflowDrilldown,
    evidence: &SelectedTaskReviewEvidenceSummary,
) -> SelectedTaskReviewNextSourceCounts {
    SelectedTaskReviewNextSourceCounts {
        task_records: drilldown.source_counts.task_records,
        work_items: drilldown.work_progress.work_items.len(),
        active_work_items: active_work_refs(drilldown).len(),
        completed_work_items: completed_work_items(drilldown),
        reviewable_work_items: reviewable_work_items(drilldown),
        receipt_refs: evidence.receipt_refs.len(),
        checkpoint_refs: evidence.checkpoint_refs.len(),
        diff_summary_refs: evidence.diff_summary_refs.len(),
        validation_refs: evidence.validation_refs.len(),
        timeline_refs: evidence.timeline_refs.len(),
        review_refs: evidence.review_refs.len(),
        task_completion_refs: drilldown.runtime.task_completion_refs.len(),
        guidance_refs: drilldown.guidance.evidence_refs.len(),
        gap_count: drilldown.gaps.len(),
    }
}

pub(super) fn gaps(
    drilldown: &TaskWorkflowDrilldown,
    counts: &SelectedTaskReviewNextSourceCounts,
) -> Vec<SelectedTaskReviewNextGap> {
    let mut gaps = Vec::new();

    if counts.task_records == 0 {
        gaps.push(gap(
            SelectedTaskReviewNextGapArea::Task,
            "selected task was not found",
        ));
    }
    if counts.work_items == 0 {
        gaps.push(gap(
            SelectedTaskReviewNextGapArea::WorkProgress,
            "no task work-item projection exists for review",
        ));
    }
    if counts.receipt_refs == 0
        && counts.checkpoint_refs == 0
        && counts.diff_summary_refs == 0
        && counts.validation_refs == 0
        && counts.task_completion_refs == 0
    {
        gaps.push(gap(
            SelectedTaskReviewNextGapArea::RuntimeEvidence,
            "no reviewable runtime, checkpoint, diff, validation, or completion refs exist",
        ));
    }
    if counts.review_refs == 0 && counts.reviewable_work_items == 0 {
        gaps.push(gap(
            SelectedTaskReviewNextGapArea::ReviewEvidence,
            "no review evidence or reviewable completed work item exists",
        ));
    }
    if drilldown.next.source == TaskWorkflowNextStepSource::BlockedByMissingPathway {
        gaps.push(gap(
            SelectedTaskReviewNextGapArea::NextPathway,
            "no pathway-backed next step exists for the selected task",
        ));
    }

    gaps
}

pub(super) fn active_work_refs(drilldown: &TaskWorkflowDrilldown) -> Vec<String> {
    clean_refs(
        drilldown
            .work_progress
            .work_items
            .iter()
            .filter(|item| {
                !matches!(
                    item.runtime_status.as_str(),
                    "completed" | "failed" | "cancelled"
                )
            })
            .map(|item| item.work_item_ref.clone())
            .collect(),
    )
}

pub(super) fn evidence_refs(evidence: &SelectedTaskReviewEvidenceSummary) -> Vec<String> {
    clean_refs(
        evidence
            .receipt_refs
            .iter()
            .chain(evidence.checkpoint_refs.iter())
            .chain(evidence.diff_summary_refs.iter())
            .chain(evidence.validation_refs.iter())
            .chain(evidence.timeline_refs.iter())
            .chain(evidence.review_refs.iter())
            .cloned()
            .collect(),
    )
}

pub(super) fn has_active_work(drilldown: &TaskWorkflowDrilldown) -> bool {
    !active_work_refs(drilldown).is_empty()
}

pub(super) fn item_has_review_evidence(item: &TaskWorkflowWorkProgressItem) -> bool {
    !item.receipt_refs.is_empty()
        || !item.checkpoint_refs.is_empty()
        || !item.diff_summary_refs.is_empty()
        || !item.validation_refs.is_empty()
        || !item.artifact_refs.is_empty()
}

pub(super) fn item_evidence_refs(
    item: &TaskWorkflowWorkProgressItem,
    fallback: &SelectedTaskReviewEvidenceSummary,
) -> Vec<String> {
    let refs = clean_refs(
        item.receipt_refs
            .iter()
            .chain(item.checkpoint_refs.iter())
            .chain(item.diff_summary_refs.iter())
            .chain(item.validation_refs.iter())
            .chain(item.timeline_entry_refs.iter())
            .chain(item.artifact_refs.iter())
            .cloned()
            .collect(),
    );
    if refs.is_empty() {
        evidence_refs(fallback)
    } else {
        refs
    }
}

fn completed_work_items(drilldown: &TaskWorkflowDrilldown) -> usize {
    drilldown
        .work_progress
        .work_items
        .iter()
        .filter(|item| item.runtime_status == "completed")
        .count()
}

fn reviewable_work_items(drilldown: &TaskWorkflowDrilldown) -> usize {
    drilldown
        .work_progress
        .work_items
        .iter()
        .filter(|item| item.runtime_status == "completed" && item_has_review_evidence(item))
        .count()
}

fn gap(area: SelectedTaskReviewNextGapArea, reason: &str) -> SelectedTaskReviewNextGap {
    SelectedTaskReviewNextGap {
        area,
        reason: reason.to_owned(),
    }
}
