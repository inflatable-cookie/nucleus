use serde::{Deserialize, Serialize};

use crate::{
    SelectedTaskReviewEvidenceSummary, SelectedTaskReviewNext, SelectedTaskReviewNextCategory,
    SelectedTaskReviewNextGap, SelectedTaskReviewNextGapArea, SelectedTaskReviewNextSourceCounts,
    SelectedTaskReviewNextStep, SelectedTaskReviewState, SelectedTaskReviewSummary,
    TaskWorkflowNoEffects,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReviewNextDto {
    pub review_next_id: String,
    pub project_id: String,
    pub task_id: String,
    pub review: ControlSelectedTaskReviewSummaryDto,
    pub evidence: ControlSelectedTaskReviewEvidenceDto,
    pub next: ControlSelectedTaskReviewNextStepDto,
    pub source_counts: ControlSelectedTaskReviewNextSourceCountsDto,
    pub gaps: Vec<ControlSelectedTaskReviewGapDto>,
    pub no_effects: ControlSelectedTaskReviewNextNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReviewSummaryDto {
    pub state: String,
    pub reason: String,
    pub work_item_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReviewEvidenceDto {
    pub receipt_refs: Vec<String>,
    pub checkpoint_refs: Vec<String>,
    pub diff_summary_refs: Vec<String>,
    pub validation_refs: Vec<String>,
    pub timeline_refs: Vec<String>,
    pub review_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReviewNextStepDto {
    pub category: String,
    pub summary: String,
    pub next_ref: Option<String>,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReviewNextSourceCountsDto {
    #[ts(as = "u32")]
    pub task_records: usize,
    #[ts(as = "u32")]
    pub work_items: usize,
    #[ts(as = "u32")]
    pub active_work_items: usize,
    #[ts(as = "u32")]
    pub completed_work_items: usize,
    #[ts(as = "u32")]
    pub reviewable_work_items: usize,
    #[ts(as = "u32")]
    pub receipt_refs: usize,
    #[ts(as = "u32")]
    pub checkpoint_refs: usize,
    #[ts(as = "u32")]
    pub diff_summary_refs: usize,
    #[ts(as = "u32")]
    pub validation_refs: usize,
    #[ts(as = "u32")]
    pub timeline_refs: usize,
    #[ts(as = "u32")]
    pub review_refs: usize,
    #[ts(as = "u32")]
    pub task_completion_refs: usize,
    #[ts(as = "u32")]
    pub guidance_refs: usize,
    #[ts(as = "u32")]
    pub gap_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReviewGapDto {
    pub area: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReviewNextNoEffectsDto {
    pub review_mutation_performed: bool,
    pub task_mutation_performed: bool,
    pub provider_execution_performed: bool,
    pub provider_write_performed: bool,
    pub scm_or_forge_mutation_performed: bool,
    pub accepted_memory_apply_performed: bool,
    pub planning_apply_performed: bool,
    pub projection_write_performed: bool,
    pub agent_scheduling_performed: bool,
    pub ui_effect_performed: bool,
}

impl From<&SelectedTaskReviewNext> for ControlSelectedTaskReviewNextDto {
    fn from(review_next: &SelectedTaskReviewNext) -> Self {
        Self {
            review_next_id: review_next.review_next_id.clone(),
            project_id: review_next.project_id.0.clone(),
            task_id: review_next.task_id.0.clone(),
            review: ControlSelectedTaskReviewSummaryDto::from(&review_next.review),
            evidence: ControlSelectedTaskReviewEvidenceDto::from(&review_next.evidence),
            next: ControlSelectedTaskReviewNextStepDto::from(&review_next.next),
            source_counts: ControlSelectedTaskReviewNextSourceCountsDto::from(
                &review_next.source_counts,
            ),
            gaps: review_next
                .gaps
                .iter()
                .map(ControlSelectedTaskReviewGapDto::from)
                .collect(),
            no_effects: ControlSelectedTaskReviewNextNoEffectsDto::from(&review_next.no_effects),
        }
    }
}

impl From<&SelectedTaskReviewSummary> for ControlSelectedTaskReviewSummaryDto {
    fn from(summary: &SelectedTaskReviewSummary) -> Self {
        Self {
            state: review_state_label(summary.state).to_owned(),
            reason: summary.reason.clone(),
            work_item_refs: summary.work_item_refs.clone(),
            evidence_refs: summary.evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskReviewEvidenceSummary> for ControlSelectedTaskReviewEvidenceDto {
    fn from(evidence: &SelectedTaskReviewEvidenceSummary) -> Self {
        Self {
            receipt_refs: evidence.receipt_refs.clone(),
            checkpoint_refs: evidence.checkpoint_refs.clone(),
            diff_summary_refs: evidence.diff_summary_refs.clone(),
            validation_refs: evidence.validation_refs.clone(),
            timeline_refs: evidence.timeline_refs.clone(),
            review_refs: evidence.review_refs.clone(),
        }
    }
}

impl From<&SelectedTaskReviewNextStep> for ControlSelectedTaskReviewNextStepDto {
    fn from(next: &SelectedTaskReviewNextStep) -> Self {
        Self {
            category: next_category_label(next.category).to_owned(),
            summary: next.summary.clone(),
            next_ref: next.next_ref.clone(),
            rationale_refs: next.rationale_refs.clone(),
        }
    }
}

impl From<&SelectedTaskReviewNextSourceCounts> for ControlSelectedTaskReviewNextSourceCountsDto {
    fn from(counts: &SelectedTaskReviewNextSourceCounts) -> Self {
        Self {
            task_records: counts.task_records,
            work_items: counts.work_items,
            active_work_items: counts.active_work_items,
            completed_work_items: counts.completed_work_items,
            reviewable_work_items: counts.reviewable_work_items,
            receipt_refs: counts.receipt_refs,
            checkpoint_refs: counts.checkpoint_refs,
            diff_summary_refs: counts.diff_summary_refs,
            validation_refs: counts.validation_refs,
            timeline_refs: counts.timeline_refs,
            review_refs: counts.review_refs,
            task_completion_refs: counts.task_completion_refs,
            guidance_refs: counts.guidance_refs,
            gap_count: counts.gap_count,
        }
    }
}

impl From<&SelectedTaskReviewNextGap> for ControlSelectedTaskReviewGapDto {
    fn from(gap: &SelectedTaskReviewNextGap) -> Self {
        Self {
            area: gap_area_label(gap.area).to_owned(),
            reason: gap.reason.clone(),
        }
    }
}

impl From<&TaskWorkflowNoEffects> for ControlSelectedTaskReviewNextNoEffectsDto {
    fn from(no_effects: &TaskWorkflowNoEffects) -> Self {
        Self {
            review_mutation_performed: false,
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

fn review_state_label(state: SelectedTaskReviewState) -> &'static str {
    match state {
        SelectedTaskReviewState::NotReady => "not_ready",
        SelectedTaskReviewState::AwaitingReview => "awaiting_review",
        SelectedTaskReviewState::Accepted => "accepted",
        SelectedTaskReviewState::Rejected => "rejected",
        SelectedTaskReviewState::NeedsChanges => "needs_changes",
        SelectedTaskReviewState::Abandoned => "abandoned",
    }
}

fn next_category_label(category: SelectedTaskReviewNextCategory) -> &'static str {
    match category {
        SelectedTaskReviewNextCategory::ReviewEvidence => "review_evidence",
        SelectedTaskReviewNextCategory::Rework => "rework",
        SelectedTaskReviewNextCategory::TaskCommand => "task_command",
        SelectedTaskReviewNextCategory::ScmHandoff => "scm_handoff",
        SelectedTaskReviewNextCategory::InspectRuntime => "inspect_runtime",
        SelectedTaskReviewNextCategory::PlanningAmbiguity => "planning_ambiguity",
        SelectedTaskReviewNextCategory::Wait => "wait",
    }
}

fn gap_area_label(area: SelectedTaskReviewNextGapArea) -> &'static str {
    match area {
        SelectedTaskReviewNextGapArea::Task => "task",
        SelectedTaskReviewNextGapArea::WorkProgress => "work_progress",
        SelectedTaskReviewNextGapArea::RuntimeEvidence => "runtime_evidence",
        SelectedTaskReviewNextGapArea::ReviewEvidence => "review_evidence",
        SelectedTaskReviewNextGapArea::NextPathway => "next_pathway",
    }
}
