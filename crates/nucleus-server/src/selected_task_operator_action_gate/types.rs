use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    SelectedTaskActionFamily, SelectedTaskActionReadiness, SelectedTaskActionStatus,
    TaskWorkflowNoEffects,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskOperatorActionGateInput {
    pub readiness: SelectedTaskActionReadiness,
    pub expected_revision: Option<RevisionId>,
    pub actor_ref: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskOperatorActionGate {
    pub gate_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub expected_revision: Option<RevisionId>,
    pub actor_ref: Option<String>,
    pub candidates: Vec<SelectedTaskOperatorActionCandidate>,
    pub source_counts: SelectedTaskOperatorActionGateSourceCounts,
    pub blockers: Vec<SelectedTaskOperatorActionBlocker>,
    pub no_effects: TaskWorkflowNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskOperatorActionCandidate {
    pub family: SelectedTaskActionFamily,
    pub readiness_status: SelectedTaskActionStatus,
    pub disposition: SelectedTaskOperatorActionDisposition,
    pub task_command: Option<SelectedTaskOperatorTaskCommandCandidate>,
    pub label: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
    pub blocker_refs: Vec<String>,
    pub expected_revision_required: bool,
    pub reason_required: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskOperatorActionDisposition {
    TaskCommandCandidate,
    Blocked,
    ReadOnly,
    Deferred,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskOperatorTaskCommandCandidate {
    pub action: SelectedTaskOperatorTaskCommandAction,
    pub task_id: TaskId,
    pub expected_revision: Option<RevisionId>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskOperatorTaskCommandAction {
    Start,
    Block,
    Complete,
    Archive,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskOperatorActionBlocker {
    pub family: SelectedTaskActionFamily,
    pub reason: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskOperatorActionGateSourceCounts {
    pub readiness_actions: usize,
    pub task_command_candidates: usize,
    pub blocked_actions: usize,
    pub read_only_actions: usize,
    pub deferred_actions: usize,
    pub evidence_refs: usize,
    pub blocker_refs: usize,
}
