use nucleus_server::ControlResponseBodyDto;

use super::selected_task_action_readiness::selected_task_action_readiness_response_lines;
use super::selected_task_command_admission::selected_task_command_admission_response_lines;
use super::selected_task_operator_action_gate::selected_task_operator_action_gate_response_lines;
use super::selected_task_review_decision::{
    selected_task_review_decision_admission_response_lines,
    selected_task_review_decision_apply_response_lines,
};
use super::selected_task_review_next::selected_task_review_next_response_lines;
use super::selected_task_review_outcome_route::selected_task_review_outcome_route_response_lines;
use super::selected_task_scm_handoff::selected_task_scm_handoff_response_lines;

pub(super) fn selected_task_response_lines(
    label: &str,
    body: &ControlResponseBodyDto,
) -> Option<Vec<String>> {
    match body {
        ControlResponseBodyDto::SelectedTaskActionReadiness { readiness } => Some(
            selected_task_action_readiness_response_lines(label, readiness.clone()),
        ),
        ControlResponseBodyDto::SelectedTaskOperatorActionGate { gate } => Some(
            selected_task_operator_action_gate_response_lines(label, gate.clone()),
        ),
        ControlResponseBodyDto::SelectedTaskCommandAdmission { admission } => Some(
            selected_task_command_admission_response_lines(label, admission.clone()),
        ),
        ControlResponseBodyDto::SelectedTaskReviewDecisionAdmission { admission } => Some(
            selected_task_review_decision_admission_response_lines(label, admission.clone()),
        ),
        ControlResponseBodyDto::SelectedTaskReviewDecisionApply { record } => Some(
            selected_task_review_decision_apply_response_lines(label, record.clone()),
        ),
        ControlResponseBodyDto::SelectedTaskReviewNext { review_next } => Some(
            selected_task_review_next_response_lines(label, review_next.clone()),
        ),
        ControlResponseBodyDto::SelectedTaskReviewOutcomeRoute { route } => Some(
            selected_task_review_outcome_route_response_lines(label, route.clone()),
        ),
        ControlResponseBodyDto::SelectedTaskScmHandoff { handoff } => Some(
            selected_task_scm_handoff_response_lines(label, handoff.clone()),
        ),
        _ => None,
    }
}
