use serde::{Deserialize, Serialize};

use crate::{
    SelectedTaskReworkPreparation, SelectedTaskReworkPreparationNoEffects,
    SelectedTaskReworkPreparationRefusal, SelectedTaskReworkPreparationRefusalKind,
    SelectedTaskReworkPreparationStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReworkPreparationDto {
    pub preparation_id: String,
    pub project_id: String,
    pub task_id: String,
    pub route_admission_id: String,
    pub route_id: String,
    pub review_decision_ref: Option<String>,
    pub status: String,
    pub refusal: Option<ControlSelectedTaskReworkPreparationRefusalDto>,
    pub reviewed_work_item_refs: Vec<String>,
    pub reviewed_evidence_refs: Vec<String>,
    pub operator_ref: String,
    pub expected_task_revision: Option<String>,
    pub expected_work_item_revision: Option<String>,
    pub rework_summary: Option<String>,
    pub no_effects: ControlSelectedTaskReworkPreparationNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReworkPreparationRefusalDto {
    pub kind: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReworkPreparationNoEffectsDto {
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

impl From<&SelectedTaskReworkPreparation> for ControlSelectedTaskReworkPreparationDto {
    fn from(preparation: &SelectedTaskReworkPreparation) -> Self {
        Self {
            preparation_id: preparation.preparation_id.clone(),
            project_id: preparation.project_id.0.clone(),
            task_id: preparation.task_id.0.clone(),
            route_admission_id: preparation.route_admission_id.clone(),
            route_id: preparation.route_id.clone(),
            review_decision_ref: preparation.review_decision_ref.clone(),
            status: status_label(preparation.status).to_owned(),
            refusal: preparation
                .refusal
                .as_ref()
                .map(ControlSelectedTaskReworkPreparationRefusalDto::from),
            reviewed_work_item_refs: preparation.reviewed_work_item_refs.clone(),
            reviewed_evidence_refs: preparation.reviewed_evidence_refs.clone(),
            operator_ref: preparation.operator_ref.clone(),
            expected_task_revision: preparation
                .expected_task_revision
                .as_ref()
                .map(|revision| revision.0.clone()),
            expected_work_item_revision: preparation
                .expected_work_item_revision
                .as_ref()
                .map(|revision| revision.0.clone()),
            rework_summary: preparation.rework_summary.clone(),
            no_effects: ControlSelectedTaskReworkPreparationNoEffectsDto::from(
                &preparation.no_effects,
            ),
        }
    }
}

impl From<&SelectedTaskReworkPreparationRefusal>
    for ControlSelectedTaskReworkPreparationRefusalDto
{
    fn from(refusal: &SelectedTaskReworkPreparationRefusal) -> Self {
        Self {
            kind: refusal_kind_label(refusal.kind).to_owned(),
            reason: refusal.reason.clone(),
        }
    }
}

impl From<&SelectedTaskReworkPreparationNoEffects>
    for ControlSelectedTaskReworkPreparationNoEffectsDto
{
    fn from(no_effects: &SelectedTaskReworkPreparationNoEffects) -> Self {
        Self {
            review_mutation_performed: no_effects.review_mutation_performed,
            task_lifecycle_mutation_performed: no_effects.task_lifecycle_mutation_performed,
            work_item_creation_performed: no_effects.work_item_creation_performed,
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

fn status_label(status: SelectedTaskReworkPreparationStatus) -> &'static str {
    match status {
        SelectedTaskReworkPreparationStatus::Admitted => "admitted",
        SelectedTaskReworkPreparationStatus::Refused => "refused",
    }
}

fn refusal_kind_label(kind: SelectedTaskReworkPreparationRefusalKind) -> &'static str {
    match kind {
        SelectedTaskReworkPreparationRefusalKind::ProjectMismatch => "project_mismatch",
        SelectedTaskReworkPreparationRefusalKind::TaskMismatch => "task_mismatch",
        SelectedTaskReworkPreparationRefusalKind::MissingOperatorIntent => {
            "missing_operator_intent"
        }
        SelectedTaskReworkPreparationRefusalKind::RouteAdmissionMismatch => {
            "route_admission_mismatch"
        }
        SelectedTaskReworkPreparationRefusalKind::RouteAdmissionRefused => {
            "route_admission_refused"
        }
        SelectedTaskReworkPreparationRefusalKind::MissingReviewDecision => {
            "missing_review_decision"
        }
        SelectedTaskReworkPreparationRefusalKind::ReviewDecisionMismatch => {
            "review_decision_mismatch"
        }
        SelectedTaskReworkPreparationRefusalKind::MissingReviewedWorkItems => {
            "missing_reviewed_work_items"
        }
        SelectedTaskReworkPreparationRefusalKind::WorkItemMismatch => "work_item_mismatch",
        SelectedTaskReworkPreparationRefusalKind::MissingReviewedEvidence => {
            "missing_reviewed_evidence"
        }
        SelectedTaskReworkPreparationRefusalKind::EvidenceMismatch => "evidence_mismatch",
        SelectedTaskReworkPreparationRefusalKind::UnsupportedRoute => "unsupported_route",
    }
}
