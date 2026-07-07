use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::TaskWorkflowNoEffects;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewNext {
    pub review_next_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub review: SelectedTaskReviewSummary,
    pub evidence: SelectedTaskReviewEvidenceSummary,
    pub next: SelectedTaskReviewNextStep,
    pub source_counts: SelectedTaskReviewNextSourceCounts,
    pub gaps: Vec<SelectedTaskReviewNextGap>,
    pub no_effects: TaskWorkflowNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewSummary {
    pub state: SelectedTaskReviewState,
    pub reason: String,
    pub work_item_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskReviewState {
    NotReady,
    AwaitingReview,
    Accepted,
    Rejected,
    NeedsChanges,
    Abandoned,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewEvidenceSummary {
    pub receipt_refs: Vec<String>,
    pub checkpoint_refs: Vec<String>,
    pub diff_summary_refs: Vec<String>,
    pub validation_refs: Vec<String>,
    pub timeline_refs: Vec<String>,
    pub review_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewNextStep {
    pub category: SelectedTaskReviewNextCategory,
    pub summary: String,
    pub next_ref: Option<String>,
    pub rationale_refs: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskReviewNextCategory {
    ReviewEvidence,
    Rework,
    TaskCommand,
    ScmHandoff,
    InspectRuntime,
    PlanningAmbiguity,
    Wait,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewNextSourceCounts {
    pub task_records: usize,
    pub work_items: usize,
    pub active_work_items: usize,
    pub completed_work_items: usize,
    pub reviewable_work_items: usize,
    pub receipt_refs: usize,
    pub checkpoint_refs: usize,
    pub diff_summary_refs: usize,
    pub validation_refs: usize,
    pub timeline_refs: usize,
    pub review_refs: usize,
    pub task_completion_refs: usize,
    pub guidance_refs: usize,
    pub gap_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReviewNextGap {
    pub area: SelectedTaskReviewNextGapArea,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskReviewNextGapArea {
    Task,
    WorkProgress,
    RuntimeEvidence,
    ReviewEvidence,
    NextPathway,
}
