use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    SelectedTaskCommandAdmission, SelectedTaskReviewOutcomeRouteNoEffects,
    SelectedTaskRouteAdmission, TaskCommand,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskCompletionRouteApplyInput {
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub expected_revision: Option<RevisionId>,
    pub operator_ref: String,
    pub route_admission_id: String,
    pub review_decision_ref: String,
    pub evidence_refs: Vec<String>,
    pub route_admission: SelectedTaskRouteAdmission,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskCompletionRouteApply {
    pub apply_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub route_admission_id: String,
    pub route_id: String,
    pub review_decision_ref: Option<String>,
    pub status: SelectedTaskCompletionRouteApplyStatus,
    pub command: Option<TaskCommand>,
    pub command_admission: Option<SelectedTaskCommandAdmission>,
    pub refusal: Option<SelectedTaskCompletionRouteApplyRefusal>,
    pub evidence_refs: Vec<String>,
    pub operator_ref: String,
    pub no_effects: SelectedTaskReviewOutcomeRouteNoEffects,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskCompletionRouteApplyStatus {
    Admitted,
    Refused,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskCompletionRouteApplyRefusal {
    pub kind: SelectedTaskCompletionRouteApplyRefusalKind,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskCompletionRouteApplyRefusalKind {
    ProjectMismatch,
    TaskMismatch,
    MissingOperatorIntent,
    MissingExpectedRevision,
    RouteAdmissionMismatch,
    RouteAdmissionRefused,
    MissingReviewDecision,
    ReviewDecisionMismatch,
    MissingReviewedEvidence,
    EvidenceMismatch,
    MissingCommandAdmission,
    CommandAdmissionRefused,
    UnsupportedCommand,
    StaleTaskState,
}
