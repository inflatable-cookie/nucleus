use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::TaskWorkflowNoEffects;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskActionReadiness {
    pub readiness_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub actions: Vec<SelectedTaskAction>,
    pub source_counts: SelectedTaskActionSourceCounts,
    pub blockers: Vec<SelectedTaskActionBlocker>,
    pub no_effects: TaskWorkflowNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskAction {
    pub family: SelectedTaskActionFamily,
    pub status: SelectedTaskActionStatus,
    pub label: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
    pub blocker_refs: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum SelectedTaskActionFamily {
    PlanSelectedTask,
    StartSelectedTask,
    BlockSelectedTask,
    CompleteSelectedTask,
    ArchiveSelectedTask,
    PrepareDelegation,
    InspectRuntimeEvidence,
    ReviewWorkEvidence,
    PrepareScmHandoff,
}

impl SelectedTaskActionFamily {
    pub const ORDERED: [Self; 9] = [
        Self::PlanSelectedTask,
        Self::StartSelectedTask,
        Self::BlockSelectedTask,
        Self::CompleteSelectedTask,
        Self::ArchiveSelectedTask,
        Self::PrepareDelegation,
        Self::InspectRuntimeEvidence,
        Self::ReviewWorkEvidence,
        Self::PrepareScmHandoff,
    ];
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskActionStatus {
    Allowed,
    Blocked,
    NotApplicable,
    DifferentLane,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskActionBlocker {
    pub family: SelectedTaskActionFamily,
    pub reason: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskActionSourceCounts {
    pub task_records: usize,
    pub readiness_refs: usize,
    pub work_items: usize,
    pub active_work_items: usize,
    pub completed_work_items: usize,
    pub runtime_evidence_refs: usize,
    pub completion_refs: usize,
    pub review_refs: usize,
    pub scm_handoff_refs: usize,
    pub gap_count: usize,
}
