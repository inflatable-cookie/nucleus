use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::SelectedTaskRouteAdmission;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReworkPreparationInput {
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub operator_ref: String,
    pub route_admission_id: String,
    pub review_decision_ref: String,
    pub reviewed_work_item_refs: Vec<String>,
    pub reviewed_evidence_refs: Vec<String>,
    pub expected_task_revision: Option<RevisionId>,
    pub expected_work_item_revision: Option<RevisionId>,
    pub route_admission: SelectedTaskRouteAdmission,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReworkPreparation {
    pub preparation_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub route_admission_id: String,
    pub route_id: String,
    pub review_decision_ref: Option<String>,
    pub status: SelectedTaskReworkPreparationStatus,
    pub refusal: Option<SelectedTaskReworkPreparationRefusal>,
    pub reviewed_work_item_refs: Vec<String>,
    pub reviewed_evidence_refs: Vec<String>,
    pub operator_ref: String,
    pub expected_task_revision: Option<RevisionId>,
    pub expected_work_item_revision: Option<RevisionId>,
    pub rework_summary: Option<String>,
    pub no_effects: SelectedTaskReworkPreparationNoEffects,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskReworkPreparationStatus {
    Admitted,
    Refused,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReworkPreparationRefusal {
    pub kind: SelectedTaskReworkPreparationRefusalKind,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskReworkPreparationRefusalKind {
    ProjectMismatch,
    TaskMismatch,
    MissingOperatorIntent,
    RouteAdmissionMismatch,
    RouteAdmissionRefused,
    MissingReviewDecision,
    ReviewDecisionMismatch,
    MissingReviewedWorkItems,
    WorkItemMismatch,
    MissingReviewedEvidence,
    EvidenceMismatch,
    UnsupportedRoute,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskReworkPreparationNoEffects {
    pub review_mutation_performed: bool,
    pub task_lifecycle_mutation_performed: bool,
    pub work_item_creation_performed: bool,
    pub provider_execution_performed: bool,
    pub provider_write_performed: bool,
    pub scm_or_forge_mutation_performed: bool,
    pub accepted_memory_apply_performed: bool,
    pub planning_apply_performed: bool,
    pub projection_write_performed: bool,
    pub agent_scheduling_performed: bool,
    pub ui_effect_performed: bool,
}

impl SelectedTaskReworkPreparationNoEffects {
    pub fn read_only() -> Self {
        Self {
            review_mutation_performed: false,
            task_lifecycle_mutation_performed: false,
            work_item_creation_performed: false,
            provider_execution_performed: false,
            provider_write_performed: false,
            scm_or_forge_mutation_performed: false,
            accepted_memory_apply_performed: false,
            planning_apply_performed: false,
            projection_write_performed: false,
            agent_scheduling_performed: false,
            ui_effect_performed: false,
        }
    }
}
