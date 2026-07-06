use super::guidance::task_workflow_guidance;
use super::types::{
    TaskWorkflowDrilldown, TaskWorkflowDrilldownInput, TaskWorkflowGap, TaskWorkflowGapArea,
    TaskWorkflowNextStep, TaskWorkflowNextStepInput, TaskWorkflowNextStepSource,
    TaskWorkflowNoEffects, TaskWorkflowReadinessSummary, TaskWorkflowReviewSummary,
    TaskWorkflowRuntimeSummary, TaskWorkflowScmHandoffSummary, TaskWorkflowSourceCounts,
    TaskWorkflowTaskSummary, TaskWorkflowTimelineSummary, TaskWorkflowWorkProgressItem,
    TaskWorkflowWorkProgressSummary,
};

pub fn task_workflow_drilldown(input: TaskWorkflowDrilldownInput) -> TaskWorkflowDrilldown {
    let task = input.task.map(|task| TaskWorkflowTaskSummary {
        title: task.title.trim().to_owned(),
        activity: task.activity.trim().to_owned(),
        assignment: task.assignment.trim().to_owned(),
        action_type: task.action_type.trim().to_owned(),
    });
    let readiness = input
        .readiness
        .map(|readiness| TaskWorkflowReadinessSummary {
            lane: readiness.lane.trim().to_owned(),
            rationale_refs: clean_refs(readiness.rationale_refs),
        });
    let timeline_entry_refs = clean_refs(input.timeline_entry_refs);
    let work_items = work_items(input.work_progress);
    let runtime_receipt_refs = clean_refs(
        input
            .runtime_receipt_refs
            .into_iter()
            .chain(
                work_items
                    .iter()
                    .flat_map(|item| item.receipt_refs.iter().cloned()),
            )
            .collect(),
    );
    let command_evidence_refs = clean_refs(input.command_evidence_refs);
    let task_completion_refs = clean_refs(input.task_completion_refs);
    let review_refs = clean_refs(input.review_refs);
    let scm_handoff_refs = clean_refs(input.scm_handoff_refs);
    let next = next_step(input.next_step);

    let source_counts = TaskWorkflowSourceCounts {
        task_records: usize::from(task.is_some()),
        readiness_refs: usize::from(readiness.is_some()),
        timeline_entry_refs: timeline_entry_refs.len(),
        work_items: work_items.len(),
        runtime_receipt_refs: runtime_receipt_refs.len(),
        command_evidence_refs: command_evidence_refs.len(),
        task_completion_refs: task_completion_refs.len(),
        review_refs: review_refs.len(),
        scm_handoff_refs: scm_handoff_refs.len(),
    };

    let gaps = gaps(&source_counts, &next);
    let guidance = task_workflow_guidance(
        task.as_ref(),
        readiness.as_ref(),
        &work_items,
        &runtime_receipt_refs,
        &command_evidence_refs,
        &task_completion_refs,
        &review_refs,
        &scm_handoff_refs,
        &gaps,
    );

    TaskWorkflowDrilldown {
        drilldown_id: format!("task-workflow-drilldown:{}", input.task_id.0),
        project_id: input.project_id,
        task_id: input.task_id,
        task,
        readiness,
        timeline: TaskWorkflowTimelineSummary {
            entry_refs: timeline_entry_refs,
        },
        work_progress: TaskWorkflowWorkProgressSummary { work_items },
        runtime: TaskWorkflowRuntimeSummary {
            runtime_receipt_refs,
            command_evidence_refs,
            task_completion_refs,
        },
        review: TaskWorkflowReviewSummary { review_refs },
        scm_handoff: TaskWorkflowScmHandoffSummary {
            handoff_refs: scm_handoff_refs,
        },
        next,
        guidance,
        source_counts,
        gaps,
        no_effects: TaskWorkflowNoEffects::read_only(),
    }
}

fn work_items(
    work_progress: Vec<super::types::TaskWorkflowWorkProgressInput>,
) -> Vec<TaskWorkflowWorkProgressItem> {
    let mut items = work_progress
        .into_iter()
        .filter_map(|item| {
            let work_item_ref = item.work_item_ref.trim().to_owned();
            (!work_item_ref.is_empty()).then(|| TaskWorkflowWorkProgressItem {
                work_item_ref,
                runtime_status: item.runtime_status.trim().to_owned(),
                review_status: item.review_status.trim().to_owned(),
                source_ref: item.source_ref.trim().to_owned(),
                source_count: item.source_count,
                session_ref: item.session_ref.and_then(clean_optional),
                turn_refs: clean_refs(item.turn_refs),
                receipt_refs: clean_refs(item.receipt_refs),
                checkpoint_refs: clean_refs(item.checkpoint_refs),
                diff_summary_refs: clean_refs(item.diff_summary_refs),
                timeline_entry_refs: clean_refs(item.timeline_entry_refs),
                validation_refs: clean_refs(item.validation_refs),
                artifact_refs: clean_refs(item.artifact_refs),
                issue_refs: clean_refs(item.issue_refs),
            })
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| left.work_item_ref.cmp(&right.work_item_ref));
    items
}

fn next_step(input: Option<TaskWorkflowNextStepInput>) -> TaskWorkflowNextStep {
    match input {
        Some(next) => TaskWorkflowNextStep {
            source: next.source,
            next_ref: next.next_ref.and_then(clean_optional),
            summary: next.summary.trim().to_owned(),
            rationale_refs: clean_refs(next.rationale_refs),
            blocked_reason: None,
        },
        None => TaskWorkflowNextStep {
            source: TaskWorkflowNextStepSource::BlockedByMissingPathway,
            next_ref: None,
            summary: String::new(),
            rationale_refs: Vec::new(),
            blocked_reason: Some("no selected-task next step source was available".to_owned()),
        },
    }
}

fn gaps(counts: &TaskWorkflowSourceCounts, next: &TaskWorkflowNextStep) -> Vec<TaskWorkflowGap> {
    let mut gaps = Vec::new();

    if counts.task_records == 0 {
        gaps.push(gap(
            TaskWorkflowGapArea::Task,
            "selected task was not found",
        ));
    }
    if counts.readiness_refs == 0 {
        gaps.push(gap(
            TaskWorkflowGapArea::Readiness,
            "no readiness projection was available for the selected task",
        ));
    }
    if counts.timeline_entry_refs == 0 {
        gaps.push(gap(
            TaskWorkflowGapArea::Timeline,
            "no timeline refs were available for the selected task",
        ));
    }
    if counts.work_items == 0 {
        gaps.push(gap(
            TaskWorkflowGapArea::WorkProgress,
            "no work-progress refs were available for the selected task",
        ));
    }
    if counts.runtime_receipt_refs == 0
        && counts.command_evidence_refs == 0
        && counts.task_completion_refs == 0
    {
        gaps.push(gap(
            TaskWorkflowGapArea::Runtime,
            "no runtime evidence refs were available for the selected task",
        ));
    }
    if counts.review_refs == 0 {
        gaps.push(gap(
            TaskWorkflowGapArea::Review,
            "no review refs were available for the selected task",
        ));
    }
    if counts.scm_handoff_refs == 0 {
        gaps.push(gap(
            TaskWorkflowGapArea::ScmHandoff,
            "no SCM handoff refs were available for the selected task",
        ));
    }
    if next.source == TaskWorkflowNextStepSource::BlockedByMissingPathway {
        gaps.push(gap(
            TaskWorkflowGapArea::Next,
            "no next step source was available for the selected task",
        ));
    }

    gaps
}

fn gap(area: TaskWorkflowGapArea, reason: &str) -> TaskWorkflowGap {
    TaskWorkflowGap {
        area,
        reason: reason.to_owned(),
    }
}

fn clean_refs(refs: Vec<String>) -> Vec<String> {
    let mut refs = refs
        .into_iter()
        .map(|reference| reference.trim().to_owned())
        .filter(|reference| !reference.is_empty())
        .collect::<Vec<_>>();
    refs.sort();
    refs.dedup();
    refs
}

fn clean_optional(value: String) -> Option<String> {
    let value = value.trim().to_owned();
    (!value.is_empty()).then_some(value)
}
