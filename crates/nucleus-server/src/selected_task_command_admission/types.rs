use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    SelectedTaskActionFamily, SelectedTaskOperatorActionCandidate, SelectedTaskOperatorActionGate,
    TaskCommand, TaskWorkflowNoEffects,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskCommandAdmissionInput {
    pub gate: SelectedTaskOperatorActionGate,
    pub intent: SelectedTaskCommandOperatorIntent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskCommandOperatorIntent {
    pub family: SelectedTaskActionFamily,
    pub expected_revision: Option<RevisionId>,
    pub reason: Option<String>,
    pub operator_ref: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskCommandAdmission {
    pub admission_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub family: SelectedTaskActionFamily,
    pub status: SelectedTaskCommandAdmissionStatus,
    pub command: Option<TaskCommand>,
    pub candidate: Option<SelectedTaskOperatorActionCandidate>,
    pub refusal: Option<SelectedTaskCommandAdmissionRefusal>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub no_effects: TaskWorkflowNoEffects,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskCommandAdmissionStatus {
    Admitted,
    Refused,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskCommandAdmissionRefusal {
    pub kind: SelectedTaskCommandAdmissionRefusalKind,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskCommandAdmissionRefusalKind {
    MissingOperatorIntent,
    CandidateNotFound,
    CandidateNotAdmitted,
    ExpectedRevisionRequired,
    ReasonRequired,
    CandidateTaskMismatch,
    UnsupportedAction,
}
