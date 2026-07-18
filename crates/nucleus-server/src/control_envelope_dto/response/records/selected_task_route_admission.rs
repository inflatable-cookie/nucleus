use serde::{Deserialize, Serialize};

use crate::{
    SelectedTaskCompletionRouteAdmission, SelectedTaskReviewOutcomeRouteCandidate,
    SelectedTaskReworkDelegationRouteAdmission, SelectedTaskRouteAdmission,
    SelectedTaskRouteAdmissionPreview, SelectedTaskRouteAdmissionPreviewFamily,
    SelectedTaskRouteAdmissionRefusal, SelectedTaskRouteAdmissionRefusalKind,
    SelectedTaskRouteAdmissionStatus,
};

use super::selected_task_command_admission::ControlSelectedTaskCommandAdmissionDto;
use super::selected_task_review_outcome_route::ControlSelectedTaskReviewOutcomeRouteNoEffectsDto;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskRouteAdmissionDto {
    pub admission_id: String,
    pub project_id: String,
    pub task_id: String,
    pub route_id: String,
    pub completion: ControlSelectedTaskCompletionRouteAdmissionDto,
    pub rework_delegation: ControlSelectedTaskReworkDelegationRouteAdmissionDto,
    pub no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskCompletionRouteAdmissionDto {
    pub admission_id: String,
    pub project_id: String,
    pub task_id: String,
    pub route_id: String,
    pub route_candidate: String,
    pub decision_ref: Option<String>,
    pub status: String,
    pub command_admission: Option<ControlSelectedTaskCommandAdmissionDto>,
    pub refusal: Option<ControlSelectedTaskRouteAdmissionRefusalDto>,
    pub evidence_refs: Vec<String>,
    pub no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskReworkDelegationRouteAdmissionDto {
    pub admission_id: String,
    pub project_id: String,
    pub task_id: String,
    pub route_id: String,
    pub route_candidate: String,
    pub decision_ref: Option<String>,
    pub status: String,
    pub rework_preview: Option<ControlSelectedTaskRouteAdmissionPreviewDto>,
    pub delegation_preview: Option<ControlSelectedTaskRouteAdmissionPreviewDto>,
    pub refusal: Option<ControlSelectedTaskRouteAdmissionRefusalDto>,
    pub work_item_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskRouteAdmissionPreviewDto {
    pub family: String,
    pub summary: String,
    pub source_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlSelectedTaskRouteAdmissionRefusalDto {
    pub kind: String,
    pub reason: String,
}

impl From<&SelectedTaskRouteAdmission> for ControlSelectedTaskRouteAdmissionDto {
    fn from(admission: &SelectedTaskRouteAdmission) -> Self {
        Self {
            admission_id: admission.admission_id.clone(),
            project_id: admission.project_id.0.clone(),
            task_id: admission.task_id.0.clone(),
            route_id: admission.route_id.clone(),
            completion: ControlSelectedTaskCompletionRouteAdmissionDto::from(&admission.completion),
            rework_delegation: ControlSelectedTaskReworkDelegationRouteAdmissionDto::from(
                &admission.rework_delegation,
            ),
            no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto::from(
                &admission.no_effects,
            ),
        }
    }
}

impl From<&SelectedTaskCompletionRouteAdmission>
    for ControlSelectedTaskCompletionRouteAdmissionDto
{
    fn from(admission: &SelectedTaskCompletionRouteAdmission) -> Self {
        Self {
            admission_id: admission.admission_id.clone(),
            project_id: admission.project_id.0.clone(),
            task_id: admission.task_id.0.clone(),
            route_id: admission.route_id.clone(),
            route_candidate: route_candidate_label(admission.route_candidate).to_owned(),
            decision_ref: admission.decision_ref.clone(),
            status: status_label(admission.status).to_owned(),
            command_admission: admission
                .command_admission
                .as_ref()
                .map(ControlSelectedTaskCommandAdmissionDto::from),
            refusal: admission
                .refusal
                .as_ref()
                .map(ControlSelectedTaskRouteAdmissionRefusalDto::from),
            evidence_refs: admission.evidence_refs.clone(),
            no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto::from(
                &admission.no_effects,
            ),
        }
    }
}

impl From<&SelectedTaskReworkDelegationRouteAdmission>
    for ControlSelectedTaskReworkDelegationRouteAdmissionDto
{
    fn from(admission: &SelectedTaskReworkDelegationRouteAdmission) -> Self {
        Self {
            admission_id: admission.admission_id.clone(),
            project_id: admission.project_id.0.clone(),
            task_id: admission.task_id.0.clone(),
            route_id: admission.route_id.clone(),
            route_candidate: route_candidate_label(admission.route_candidate).to_owned(),
            decision_ref: admission.decision_ref.clone(),
            status: status_label(admission.status).to_owned(),
            rework_preview: admission
                .rework_preview
                .as_ref()
                .map(ControlSelectedTaskRouteAdmissionPreviewDto::from),
            delegation_preview: admission
                .delegation_preview
                .as_ref()
                .map(ControlSelectedTaskRouteAdmissionPreviewDto::from),
            refusal: admission
                .refusal
                .as_ref()
                .map(ControlSelectedTaskRouteAdmissionRefusalDto::from),
            work_item_refs: admission.work_item_refs.clone(),
            evidence_refs: admission.evidence_refs.clone(),
            no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto::from(
                &admission.no_effects,
            ),
        }
    }
}

impl From<&SelectedTaskRouteAdmissionPreview> for ControlSelectedTaskRouteAdmissionPreviewDto {
    fn from(preview: &SelectedTaskRouteAdmissionPreview) -> Self {
        Self {
            family: preview_family_label(preview.family).to_owned(),
            summary: preview.summary.clone(),
            source_refs: preview.source_refs.clone(),
            evidence_refs: preview.evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskRouteAdmissionRefusal> for ControlSelectedTaskRouteAdmissionRefusalDto {
    fn from(refusal: &SelectedTaskRouteAdmissionRefusal) -> Self {
        Self {
            kind: refusal_kind_label(refusal.kind).to_owned(),
            reason: refusal.reason.clone(),
        }
    }
}

fn status_label(status: SelectedTaskRouteAdmissionStatus) -> &'static str {
    match status {
        SelectedTaskRouteAdmissionStatus::Admitted => "admitted",
        SelectedTaskRouteAdmissionStatus::Refused => "refused",
    }
}

fn preview_family_label(family: SelectedTaskRouteAdmissionPreviewFamily) -> &'static str {
    match family {
        SelectedTaskRouteAdmissionPreviewFamily::PrepareRework => "prepare_rework",
        SelectedTaskRouteAdmissionPreviewFamily::DelegateRework => "delegate_rework",
    }
}

fn refusal_kind_label(kind: SelectedTaskRouteAdmissionRefusalKind) -> &'static str {
    match kind {
        SelectedTaskRouteAdmissionRefusalKind::ProjectMismatch => "project_mismatch",
        SelectedTaskRouteAdmissionRefusalKind::TaskMismatch => "task_mismatch",
        SelectedTaskRouteAdmissionRefusalKind::MissingDecisionRecord => "missing_decision_record",
        SelectedTaskRouteAdmissionRefusalKind::MissingReviewEvidence => "missing_review_evidence",
        SelectedTaskRouteAdmissionRefusalKind::StaleTaskState => "stale_task_state",
        SelectedTaskRouteAdmissionRefusalKind::PlanningAmbiguity => "planning_ambiguity",
        SelectedTaskRouteAdmissionRefusalKind::UnsupportedRoute => "unsupported_route",
        SelectedTaskRouteAdmissionRefusalKind::CommandAdmissionRefused => {
            "command_admission_refused"
        }
    }
}

fn route_candidate_label(candidate: SelectedTaskReviewOutcomeRouteCandidate) -> &'static str {
    match candidate {
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForCompletionAdmission => {
            "ready_for_completion_admission"
        }
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForReworkAdmission => {
            "ready_for_rework_admission"
        }
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForDelegationAdmission => {
            "ready_for_delegation_admission"
        }
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForScmHandoffReview => {
            "ready_for_scm_handoff_review"
        }
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnOperatorChoice => {
            "blocked_on_operator_choice"
        }
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnMissingEvidence => {
            "blocked_on_missing_evidence"
        }
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnStaleTaskState => {
            "blocked_on_stale_task_state"
        }
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnPlanningAmbiguity => {
            "blocked_on_planning_ambiguity"
        }
        SelectedTaskReviewOutcomeRouteCandidate::NoReviewDecision => "no_review_decision",
    }
}
