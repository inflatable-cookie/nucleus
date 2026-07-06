use crate::{
    TaskWorkflowDrilldown, TaskWorkflowGap, TaskWorkflowGapArea, TaskWorkflowNextStep,
    TaskWorkflowNextStepSource, TaskWorkflowNoEffects, TaskWorkflowReadinessSummary,
    TaskWorkflowReviewSummary, TaskWorkflowRuntimeSummary, TaskWorkflowScmHandoffSummary,
    TaskWorkflowSourceCounts, TaskWorkflowTaskSummary, TaskWorkflowTimelineSummary,
    TaskWorkflowWorkProgressItem, TaskWorkflowWorkProgressSummary,
};

use super::types::{
    ControlTaskWorkflowDrilldownDto, ControlTaskWorkflowGapDto, ControlTaskWorkflowNextDto,
    ControlTaskWorkflowNoEffectsDto, ControlTaskWorkflowReadinessDto, ControlTaskWorkflowReviewDto,
    ControlTaskWorkflowRuntimeDto, ControlTaskWorkflowScmHandoffDto,
    ControlTaskWorkflowSourceCountsDto, ControlTaskWorkflowTaskDto, ControlTaskWorkflowTimelineDto,
    ControlTaskWorkflowWorkItemDto, ControlTaskWorkflowWorkProgressDto,
};

impl From<&TaskWorkflowDrilldown> for ControlTaskWorkflowDrilldownDto {
    fn from(drilldown: &TaskWorkflowDrilldown) -> Self {
        Self {
            drilldown_id: drilldown.drilldown_id.clone(),
            project_id: drilldown.project_id.0.clone(),
            task_id: drilldown.task_id.0.clone(),
            task: drilldown
                .task
                .as_ref()
                .map(ControlTaskWorkflowTaskDto::from),
            readiness: drilldown
                .readiness
                .as_ref()
                .map(ControlTaskWorkflowReadinessDto::from),
            timeline: ControlTaskWorkflowTimelineDto::from(&drilldown.timeline),
            work_progress: ControlTaskWorkflowWorkProgressDto::from(&drilldown.work_progress),
            runtime: ControlTaskWorkflowRuntimeDto::from(&drilldown.runtime),
            review: ControlTaskWorkflowReviewDto::from(&drilldown.review),
            scm_handoff: ControlTaskWorkflowScmHandoffDto::from(&drilldown.scm_handoff),
            next: ControlTaskWorkflowNextDto::from(&drilldown.next),
            source_counts: ControlTaskWorkflowSourceCountsDto::from(&drilldown.source_counts),
            gaps: drilldown
                .gaps
                .iter()
                .map(ControlTaskWorkflowGapDto::from)
                .collect(),
            no_effects: ControlTaskWorkflowNoEffectsDto::from(&drilldown.no_effects),
        }
    }
}

impl From<&TaskWorkflowTaskSummary> for ControlTaskWorkflowTaskDto {
    fn from(task: &TaskWorkflowTaskSummary) -> Self {
        Self {
            title: task.title.clone(),
            activity: task.activity.clone(),
            assignment: task.assignment.clone(),
            action_type: task.action_type.clone(),
        }
    }
}

impl From<&TaskWorkflowReadinessSummary> for ControlTaskWorkflowReadinessDto {
    fn from(readiness: &TaskWorkflowReadinessSummary) -> Self {
        Self {
            lane: readiness.lane.clone(),
            rationale_refs: readiness.rationale_refs.clone(),
        }
    }
}

impl From<&TaskWorkflowTimelineSummary> for ControlTaskWorkflowTimelineDto {
    fn from(timeline: &TaskWorkflowTimelineSummary) -> Self {
        Self {
            entry_refs: timeline.entry_refs.clone(),
        }
    }
}

impl From<&TaskWorkflowWorkProgressSummary> for ControlTaskWorkflowWorkProgressDto {
    fn from(progress: &TaskWorkflowWorkProgressSummary) -> Self {
        Self {
            work_items: progress
                .work_items
                .iter()
                .map(ControlTaskWorkflowWorkItemDto::from)
                .collect(),
        }
    }
}

impl From<&TaskWorkflowWorkProgressItem> for ControlTaskWorkflowWorkItemDto {
    fn from(item: &TaskWorkflowWorkProgressItem) -> Self {
        Self {
            work_item_ref: item.work_item_ref.clone(),
            runtime_status: item.runtime_status.clone(),
            review_status: item.review_status.clone(),
            source_ref: item.source_ref.clone(),
            source_count: item.source_count,
            session_ref: item.session_ref.clone(),
            turn_refs: item.turn_refs.clone(),
            receipt_refs: item.receipt_refs.clone(),
            checkpoint_refs: item.checkpoint_refs.clone(),
            diff_summary_refs: item.diff_summary_refs.clone(),
            timeline_entry_refs: item.timeline_entry_refs.clone(),
            validation_refs: item.validation_refs.clone(),
            artifact_refs: item.artifact_refs.clone(),
            issue_refs: item.issue_refs.clone(),
        }
    }
}

impl From<&TaskWorkflowRuntimeSummary> for ControlTaskWorkflowRuntimeDto {
    fn from(runtime: &TaskWorkflowRuntimeSummary) -> Self {
        Self {
            runtime_receipt_refs: runtime.runtime_receipt_refs.clone(),
            command_evidence_refs: runtime.command_evidence_refs.clone(),
            task_completion_refs: runtime.task_completion_refs.clone(),
        }
    }
}

impl From<&TaskWorkflowReviewSummary> for ControlTaskWorkflowReviewDto {
    fn from(review: &TaskWorkflowReviewSummary) -> Self {
        Self {
            review_refs: review.review_refs.clone(),
        }
    }
}

impl From<&TaskWorkflowScmHandoffSummary> for ControlTaskWorkflowScmHandoffDto {
    fn from(handoff: &TaskWorkflowScmHandoffSummary) -> Self {
        Self {
            handoff_refs: handoff.handoff_refs.clone(),
        }
    }
}

impl From<&TaskWorkflowNextStep> for ControlTaskWorkflowNextDto {
    fn from(next: &TaskWorkflowNextStep) -> Self {
        Self {
            source: next_source_label(next.source).to_owned(),
            next_ref: next.next_ref.clone(),
            summary: next.summary.clone(),
            rationale_refs: next.rationale_refs.clone(),
            blocked_reason: next.blocked_reason.clone(),
        }
    }
}

impl From<&TaskWorkflowSourceCounts> for ControlTaskWorkflowSourceCountsDto {
    fn from(counts: &TaskWorkflowSourceCounts) -> Self {
        Self {
            task_records: counts.task_records,
            readiness_refs: counts.readiness_refs,
            timeline_entry_refs: counts.timeline_entry_refs,
            work_items: counts.work_items,
            runtime_receipt_refs: counts.runtime_receipt_refs,
            command_evidence_refs: counts.command_evidence_refs,
            task_completion_refs: counts.task_completion_refs,
            review_refs: counts.review_refs,
            scm_handoff_refs: counts.scm_handoff_refs,
        }
    }
}

impl From<&TaskWorkflowGap> for ControlTaskWorkflowGapDto {
    fn from(gap: &TaskWorkflowGap) -> Self {
        Self {
            area: gap_area_label(gap.area).to_owned(),
            reason: gap.reason.clone(),
        }
    }
}

impl From<&TaskWorkflowNoEffects> for ControlTaskWorkflowNoEffectsDto {
    fn from(no_effects: &TaskWorkflowNoEffects) -> Self {
        Self {
            task_mutation_performed: no_effects.task_mutation_performed,
            provider_execution_performed: no_effects.provider_execution_performed,
            provider_write_performed: no_effects.provider_write_performed,
            scm_or_forge_mutation_performed: no_effects.scm_or_forge_mutation_performed,
            accepted_memory_apply_performed: no_effects.accepted_memory_apply_performed,
            planning_apply_performed: no_effects.planning_apply_performed,
            projection_write_performed: no_effects.projection_write_performed,
            agent_scheduling_performed: no_effects.agent_scheduling_performed,
            ui_effect_performed: no_effects.ui_effect_performed,
        }
    }
}

fn next_source_label(source: TaskWorkflowNextStepSource) -> &'static str {
    match source {
        TaskWorkflowNextStepSource::Task => "task",
        TaskWorkflowNextStepSource::Runtime => "runtime",
        TaskWorkflowNextStepSource::Review => "review",
        TaskWorkflowNextStepSource::ScmHandoff => "scm_handoff",
        TaskWorkflowNextStepSource::BlockedByMissingPathway => "blocked_by_missing_pathway",
    }
}

fn gap_area_label(area: TaskWorkflowGapArea) -> &'static str {
    match area {
        TaskWorkflowGapArea::Task => "task_missing",
        TaskWorkflowGapArea::Readiness => "readiness_missing",
        TaskWorkflowGapArea::Timeline => "timeline_missing",
        TaskWorkflowGapArea::WorkProgress => "work_progress_missing",
        TaskWorkflowGapArea::Runtime => "runtime_missing",
        TaskWorkflowGapArea::Review => "review_missing",
        TaskWorkflowGapArea::ScmHandoff => "scm_handoff_missing",
        TaskWorkflowGapArea::Next => "next_missing",
    }
}
