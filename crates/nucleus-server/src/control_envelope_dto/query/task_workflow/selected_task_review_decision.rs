use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::control_api::{
    SelectedTaskReviewDecisionAdmissionQuery, SelectedTaskReviewDecisionApplyQuery, ServerQueryKind,
};
use crate::SelectedTaskReviewDecisionAction;

use super::super::super::ControlApiCodecError;

#[allow(clippy::too_many_arguments)]
pub(in crate::control_envelope_dto::query) fn selected_task_review_decision_admission_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
    decision_action: String,
    expected_revision: Option<String>,
    current_revision: Option<String>,
    reason: Option<String>,
    operator_ref: String,
    reviewed_evidence_refs: Vec<String>,
    idempotency_key: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "dry_run"
            if project_id.trim().is_empty()
                || task_id.trim().is_empty()
                || decision_action.trim().is_empty()
                || operator_ref.trim().is_empty()
                || idempotency_key.trim().is_empty() =>
        {
            Err(ControlApiCodecError::unsupported(
                "selected task review-decision admission query requires project id, task id, decision action, operator ref, and idempotency key",
            ))
        }
        "dry_run" => Ok(ServerQueryKind::SelectedTaskReviewDecisionAdmission(
            SelectedTaskReviewDecisionAdmissionQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
                action: selected_task_review_decision_action_from_label(&decision_action)?,
                expected_revision: expected_revision.map(RevisionId),
                current_revision: current_revision.map(RevisionId),
                reason,
                operator_ref,
                reviewed_evidence_refs,
                idempotency_key,
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task review-decision admission query action: {action}"
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
pub(in crate::control_envelope_dto::query) fn selected_task_review_decision_apply_query_from_action(
    action: &str,
    project_id: String,
    task_id: String,
    decision_action: String,
    expected_revision: Option<String>,
    current_revision: Option<String>,
    reason: Option<String>,
    operator_ref: String,
    reviewed_evidence_refs: Vec<String>,
    idempotency_key: String,
) -> Result<ServerQueryKind, ControlApiCodecError> {
    match action {
        "apply"
            if project_id.trim().is_empty()
                || task_id.trim().is_empty()
                || decision_action.trim().is_empty()
                || operator_ref.trim().is_empty()
                || idempotency_key.trim().is_empty() =>
        {
            Err(ControlApiCodecError::unsupported(
                "selected task review-decision apply query requires project id, task id, decision action, operator ref, and idempotency key",
            ))
        }
        "apply" => Ok(ServerQueryKind::SelectedTaskReviewDecisionApply(
            SelectedTaskReviewDecisionApplyQuery {
                project_id: ProjectId(project_id),
                task_id: TaskId(task_id),
                action: selected_task_review_decision_action_from_label(&decision_action)?,
                expected_revision: expected_revision.map(RevisionId),
                current_revision: current_revision.map(RevisionId),
                reason,
                operator_ref,
                reviewed_evidence_refs,
                idempotency_key,
            },
        )),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task review-decision apply query action: {action}"
        ))),
    }
}

pub(super) fn selected_task_review_decision_action_from_label(
    action: &str,
) -> Result<SelectedTaskReviewDecisionAction, ControlApiCodecError> {
    match action {
        "accept_evidence" => Ok(SelectedTaskReviewDecisionAction::AcceptEvidence),
        "reject_evidence" => Ok(SelectedTaskReviewDecisionAction::RejectEvidence),
        "request_changes" => Ok(SelectedTaskReviewDecisionAction::RequestChanges),
        "abandon_review" => Ok(SelectedTaskReviewDecisionAction::AbandonReview),
        _ => Err(ControlApiCodecError::unsupported(format!(
            "unsupported selected task review-decision action: {action}"
        ))),
    }
}

pub(in crate::control_envelope_dto::query) fn selected_task_review_decision_action_label(
    action: SelectedTaskReviewDecisionAction,
) -> &'static str {
    match action {
        SelectedTaskReviewDecisionAction::AcceptEvidence => "accept_evidence",
        SelectedTaskReviewDecisionAction::RejectEvidence => "reject_evidence",
        SelectedTaskReviewDecisionAction::RequestChanges => "request_changes",
        SelectedTaskReviewDecisionAction::AbandonReview => "abandon_review",
    }
}
