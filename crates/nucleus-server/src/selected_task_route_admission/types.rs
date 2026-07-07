use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    SelectedTaskCommandAdmission, SelectedTaskOperatorActionGate, SelectedTaskReviewOutcomeRoute,
    SelectedTaskReviewOutcomeRouteCandidate, SelectedTaskReviewOutcomeRouteNoEffects,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskRouteAdmissionInput {
    pub route: SelectedTaskReviewOutcomeRoute,
    pub gate: SelectedTaskOperatorActionGate,
    pub expected_revision: Option<RevisionId>,
    pub operator_ref: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskRouteAdmission {
    pub admission_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub route_id: String,
    pub completion: SelectedTaskCompletionRouteAdmission,
    pub rework_delegation: SelectedTaskReworkDelegationRouteAdmission,
    pub no_effects: SelectedTaskReviewOutcomeRouteNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskCompletionRouteAdmissionInput {
    pub route: SelectedTaskReviewOutcomeRoute,
    pub gate: SelectedTaskOperatorActionGate,
    pub expected_revision: Option<RevisionId>,
    pub operator_ref: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskCompletionRouteAdmission {
    pub admission_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub route_id: String,
    pub route_candidate: SelectedTaskReviewOutcomeRouteCandidate,
    pub decision_ref: Option<String>,
    pub status: SelectedTaskRouteAdmissionStatus,
    pub command_admission: Option<SelectedTaskCommandAdmission>,
    pub refusal: Option<SelectedTaskRouteAdmissionRefusal>,
    pub evidence_refs: Vec<String>,
    pub no_effects: SelectedTaskReviewOutcomeRouteNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReworkDelegationRouteAdmissionInput {
    pub route: SelectedTaskReviewOutcomeRoute,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReworkDelegationRouteAdmission {
    pub admission_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub route_id: String,
    pub route_candidate: SelectedTaskReviewOutcomeRouteCandidate,
    pub decision_ref: Option<String>,
    pub status: SelectedTaskRouteAdmissionStatus,
    pub rework_preview: Option<SelectedTaskRouteAdmissionPreview>,
    pub delegation_preview: Option<SelectedTaskRouteAdmissionPreview>,
    pub refusal: Option<SelectedTaskRouteAdmissionRefusal>,
    pub work_item_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub no_effects: SelectedTaskReviewOutcomeRouteNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskRouteAdmissionPreview {
    pub family: SelectedTaskRouteAdmissionPreviewFamily,
    pub summary: String,
    pub source_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskRouteAdmissionPreviewFamily {
    PrepareRework,
    DelegateRework,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskRouteAdmissionStatus {
    Admitted,
    Refused,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskRouteAdmissionRefusal {
    pub kind: SelectedTaskRouteAdmissionRefusalKind,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskRouteAdmissionRefusalKind {
    ProjectMismatch,
    TaskMismatch,
    MissingDecisionRecord,
    MissingReviewEvidence,
    StaleTaskState,
    PlanningAmbiguity,
    UnsupportedRoute,
    CommandAdmissionRefused,
}
