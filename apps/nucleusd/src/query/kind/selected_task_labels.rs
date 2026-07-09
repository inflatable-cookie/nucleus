use nucleus_server::{SelectedTaskActionFamily, SelectedTaskReviewDecisionAction};

pub(super) fn selected_task_action_family(family: &str) -> SelectedTaskActionFamily {
    match family {
        "plan_selected_task" => SelectedTaskActionFamily::PlanSelectedTask,
        "start_selected_task" => SelectedTaskActionFamily::StartSelectedTask,
        "block_selected_task" => SelectedTaskActionFamily::BlockSelectedTask,
        "complete_selected_task" => SelectedTaskActionFamily::CompleteSelectedTask,
        "archive_selected_task" => SelectedTaskActionFamily::ArchiveSelectedTask,
        "prepare_delegation" => SelectedTaskActionFamily::PrepareDelegation,
        "inspect_runtime_evidence" => SelectedTaskActionFamily::InspectRuntimeEvidence,
        "review_work_evidence" => SelectedTaskActionFamily::ReviewWorkEvidence,
        "prepare_scm_handoff" => SelectedTaskActionFamily::PrepareScmHandoff,
        _ => SelectedTaskActionFamily::StartSelectedTask,
    }
}

pub(super) fn selected_task_review_decision_action(
    action: &str,
) -> SelectedTaskReviewDecisionAction {
    match action {
        "accept_evidence" => SelectedTaskReviewDecisionAction::AcceptEvidence,
        "reject_evidence" => SelectedTaskReviewDecisionAction::RejectEvidence,
        "request_changes" => SelectedTaskReviewDecisionAction::RequestChanges,
        "abandon_review" => SelectedTaskReviewDecisionAction::AbandonReview,
        _ => SelectedTaskReviewDecisionAction::AcceptEvidence,
    }
}
