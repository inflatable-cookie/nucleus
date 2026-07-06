use crate::{
    SelectedTaskAction, SelectedTaskActionFamily, SelectedTaskActionStatus,
    SelectedTaskOperatorActionCandidate, SelectedTaskOperatorActionDisposition,
    SelectedTaskOperatorTaskCommandAction, SelectedTaskOperatorTaskCommandCandidate,
};
use nucleus_core::RevisionId;
use nucleus_tasks::TaskId;

pub(super) fn candidate(
    action: &SelectedTaskAction,
    task_id: &TaskId,
    expected_revision: &Option<RevisionId>,
) -> SelectedTaskOperatorActionCandidate {
    if let Some(command_action) = task_command_action(action.family) {
        return task_command_candidate(action, command_action, task_id, expected_revision);
    }

    match action.family {
        SelectedTaskActionFamily::PlanSelectedTask
        | SelectedTaskActionFamily::InspectRuntimeEvidence => read_only_candidate(action),
        SelectedTaskActionFamily::PrepareDelegation
        | SelectedTaskActionFamily::ReviewWorkEvidence
        | SelectedTaskActionFamily::PrepareScmHandoff => deferred_candidate(action),
        SelectedTaskActionFamily::StartSelectedTask
        | SelectedTaskActionFamily::BlockSelectedTask
        | SelectedTaskActionFamily::CompleteSelectedTask
        | SelectedTaskActionFamily::ArchiveSelectedTask => unreachable!("handled above"),
    }
}

fn task_command_candidate(
    action: &SelectedTaskAction,
    command_action: SelectedTaskOperatorTaskCommandAction,
    task_id: &TaskId,
    expected_revision: &Option<RevisionId>,
) -> SelectedTaskOperatorActionCandidate {
    let disposition = match action.status {
        SelectedTaskActionStatus::Allowed => {
            SelectedTaskOperatorActionDisposition::TaskCommandCandidate
        }
        SelectedTaskActionStatus::Blocked => SelectedTaskOperatorActionDisposition::Blocked,
        SelectedTaskActionStatus::NotApplicable => SelectedTaskOperatorActionDisposition::ReadOnly,
        SelectedTaskActionStatus::DifferentLane => SelectedTaskOperatorActionDisposition::Deferred,
    };
    let task_command = (disposition == SelectedTaskOperatorActionDisposition::TaskCommandCandidate)
        .then(|| SelectedTaskOperatorTaskCommandCandidate {
            action: command_action,
            task_id: task_id.clone(),
            expected_revision: expected_revision.clone(),
        });

    SelectedTaskOperatorActionCandidate {
        family: action.family,
        readiness_status: action.status,
        disposition,
        task_command,
        label: action.label.clone(),
        reason: action.reason.clone(),
        evidence_refs: action.evidence_refs.clone(),
        blocker_refs: action.blocker_refs.clone(),
        expected_revision_required: true,
        reason_required: command_action == SelectedTaskOperatorTaskCommandAction::Block,
    }
}

fn read_only_candidate(action: &SelectedTaskAction) -> SelectedTaskOperatorActionCandidate {
    passive_candidate(action, SelectedTaskOperatorActionDisposition::ReadOnly)
}

fn deferred_candidate(action: &SelectedTaskAction) -> SelectedTaskOperatorActionCandidate {
    passive_candidate(action, SelectedTaskOperatorActionDisposition::Deferred)
}

fn passive_candidate(
    action: &SelectedTaskAction,
    disposition: SelectedTaskOperatorActionDisposition,
) -> SelectedTaskOperatorActionCandidate {
    SelectedTaskOperatorActionCandidate {
        family: action.family,
        readiness_status: action.status,
        disposition,
        task_command: None,
        label: action.label.clone(),
        reason: action.reason.clone(),
        evidence_refs: action.evidence_refs.clone(),
        blocker_refs: action.blocker_refs.clone(),
        expected_revision_required: false,
        reason_required: false,
    }
}

fn task_command_action(
    family: SelectedTaskActionFamily,
) -> Option<SelectedTaskOperatorTaskCommandAction> {
    match family {
        SelectedTaskActionFamily::StartSelectedTask => {
            Some(SelectedTaskOperatorTaskCommandAction::Start)
        }
        SelectedTaskActionFamily::BlockSelectedTask => {
            Some(SelectedTaskOperatorTaskCommandAction::Block)
        }
        SelectedTaskActionFamily::CompleteSelectedTask => {
            Some(SelectedTaskOperatorTaskCommandAction::Complete)
        }
        SelectedTaskActionFamily::ArchiveSelectedTask => {
            Some(SelectedTaskOperatorTaskCommandAction::Archive)
        }
        SelectedTaskActionFamily::PlanSelectedTask
        | SelectedTaskActionFamily::PrepareDelegation
        | SelectedTaskActionFamily::InspectRuntimeEvidence
        | SelectedTaskActionFamily::ReviewWorkEvidence
        | SelectedTaskActionFamily::PrepareScmHandoff => None,
    }
}
