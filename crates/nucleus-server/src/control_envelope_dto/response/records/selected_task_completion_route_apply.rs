use serde::{Deserialize, Serialize};

use crate::{
    SelectedTaskCompletionRouteApply, SelectedTaskCompletionRouteApplyRefusal,
    SelectedTaskCompletionRouteApplyRefusalKind, SelectedTaskCompletionRouteApplyStatus,
};

use super::selected_task_command_admission::{
    ControlSelectedTaskCommandAdmissionCommandDto, ControlSelectedTaskCommandAdmissionDto,
};
use super::selected_task_review_outcome_route::ControlSelectedTaskReviewOutcomeRouteNoEffectsDto;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskCompletionRouteApplyDto {
    pub apply_id: String,
    pub project_id: String,
    pub task_id: String,
    pub route_admission_id: String,
    pub route_id: String,
    pub review_decision_ref: Option<String>,
    pub status: String,
    pub command: Option<ControlSelectedTaskCommandAdmissionCommandDto>,
    pub command_admission: Option<ControlSelectedTaskCommandAdmissionDto>,
    pub refusal: Option<ControlSelectedTaskCompletionRouteApplyRefusalDto>,
    pub evidence_refs: Vec<String>,
    pub operator_ref: String,
    pub no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskCompletionRouteApplyRefusalDto {
    pub kind: String,
    pub reason: String,
}

impl From<&SelectedTaskCompletionRouteApply> for ControlSelectedTaskCompletionRouteApplyDto {
    fn from(apply: &SelectedTaskCompletionRouteApply) -> Self {
        Self {
            apply_id: apply.apply_id.clone(),
            project_id: apply.project_id.0.clone(),
            task_id: apply.task_id.0.clone(),
            route_admission_id: apply.route_admission_id.clone(),
            route_id: apply.route_id.clone(),
            review_decision_ref: apply.review_decision_ref.clone(),
            status: status_label(apply.status).to_owned(),
            command: apply
                .command
                .as_ref()
                .map(ControlSelectedTaskCommandAdmissionCommandDto::from),
            command_admission: apply
                .command_admission
                .as_ref()
                .map(ControlSelectedTaskCommandAdmissionDto::from),
            refusal: apply
                .refusal
                .as_ref()
                .map(ControlSelectedTaskCompletionRouteApplyRefusalDto::from),
            evidence_refs: apply.evidence_refs.clone(),
            operator_ref: apply.operator_ref.clone(),
            no_effects: ControlSelectedTaskReviewOutcomeRouteNoEffectsDto::from(&apply.no_effects),
        }
    }
}

impl From<&SelectedTaskCompletionRouteApplyRefusal>
    for ControlSelectedTaskCompletionRouteApplyRefusalDto
{
    fn from(refusal: &SelectedTaskCompletionRouteApplyRefusal) -> Self {
        Self {
            kind: refusal_kind_label(refusal.kind).to_owned(),
            reason: refusal.reason.clone(),
        }
    }
}

fn status_label(status: SelectedTaskCompletionRouteApplyStatus) -> &'static str {
    match status {
        SelectedTaskCompletionRouteApplyStatus::Admitted => "admitted",
        SelectedTaskCompletionRouteApplyStatus::Refused => "refused",
    }
}

fn refusal_kind_label(kind: SelectedTaskCompletionRouteApplyRefusalKind) -> &'static str {
    match kind {
        SelectedTaskCompletionRouteApplyRefusalKind::ProjectMismatch => "project_mismatch",
        SelectedTaskCompletionRouteApplyRefusalKind::TaskMismatch => "task_mismatch",
        SelectedTaskCompletionRouteApplyRefusalKind::MissingOperatorIntent => {
            "missing_operator_intent"
        }
        SelectedTaskCompletionRouteApplyRefusalKind::MissingExpectedRevision => {
            "missing_expected_revision"
        }
        SelectedTaskCompletionRouteApplyRefusalKind::RouteAdmissionMismatch => {
            "route_admission_mismatch"
        }
        SelectedTaskCompletionRouteApplyRefusalKind::RouteAdmissionRefused => {
            "route_admission_refused"
        }
        SelectedTaskCompletionRouteApplyRefusalKind::MissingReviewDecision => {
            "missing_review_decision"
        }
        SelectedTaskCompletionRouteApplyRefusalKind::ReviewDecisionMismatch => {
            "review_decision_mismatch"
        }
        SelectedTaskCompletionRouteApplyRefusalKind::MissingReviewedEvidence => {
            "missing_reviewed_evidence"
        }
        SelectedTaskCompletionRouteApplyRefusalKind::EvidenceMismatch => "evidence_mismatch",
        SelectedTaskCompletionRouteApplyRefusalKind::MissingCommandAdmission => {
            "missing_command_admission"
        }
        SelectedTaskCompletionRouteApplyRefusalKind::CommandAdmissionRefused => {
            "command_admission_refused"
        }
        SelectedTaskCompletionRouteApplyRefusalKind::UnsupportedCommand => "unsupported_command",
        SelectedTaskCompletionRouteApplyRefusalKind::StaleTaskState => "stale_task_state",
    }
}
