use crate::{
    SelectedTaskCommandAdmissionRefusal, SelectedTaskCommandAdmissionRefusalKind,
    SelectedTaskCommandOperatorIntent, SelectedTaskOperatorActionCandidate,
    SelectedTaskOperatorActionDisposition, SelectedTaskOperatorTaskCommandAction, TaskCommand,
    TaskTransitionCommand,
};

pub(super) fn admitted_command(
    candidate: &SelectedTaskOperatorActionCandidate,
    intent: &SelectedTaskCommandOperatorIntent,
) -> Result<TaskCommand, SelectedTaskCommandAdmissionRefusal> {
    if intent.operator_ref.trim().is_empty() {
        return Err(refusal(
            SelectedTaskCommandAdmissionRefusalKind::MissingOperatorIntent,
            "selected task command admission requires an operator ref",
        ));
    }
    if candidate.disposition != SelectedTaskOperatorActionDisposition::TaskCommandCandidate {
        return Err(refusal(
            SelectedTaskCommandAdmissionRefusalKind::CandidateNotAdmitted,
            "selected gate candidate is not a task command candidate",
        ));
    }
    if candidate.expected_revision_required && intent.expected_revision.is_none() {
        return Err(refusal(
            SelectedTaskCommandAdmissionRefusalKind::ExpectedRevisionRequired,
            "selected task command admission requires an expected revision",
        ));
    }

    let Some(task_command) = candidate.task_command.as_ref() else {
        return Err(refusal(
            SelectedTaskCommandAdmissionRefusalKind::UnsupportedAction,
            "selected gate candidate has no task command",
        ));
    };
    if task_command.task_id.0.trim().is_empty() {
        return Err(refusal(
            SelectedTaskCommandAdmissionRefusalKind::CandidateTaskMismatch,
            "selected gate candidate has an empty task id",
        ));
    }

    match task_command.action {
        SelectedTaskOperatorTaskCommandAction::Start => Ok(TaskCommand::Start(transition_command(
            task_command.task_id.clone(),
            intent,
        ))),
        SelectedTaskOperatorTaskCommandAction::Block => {
            let reason = intent.reason.as_deref().unwrap_or("").trim();
            if reason.is_empty() {
                return Err(refusal(
                    SelectedTaskCommandAdmissionRefusalKind::ReasonRequired,
                    "blocking a selected task requires a reason",
                ));
            }
            Ok(TaskCommand::Block {
                task_id: task_command.task_id.clone(),
                reason: reason.to_owned(),
                expected_revision: intent.expected_revision.clone(),
            })
        }
        SelectedTaskOperatorTaskCommandAction::Complete => Ok(TaskCommand::Complete(
            transition_command(task_command.task_id.clone(), intent),
        )),
        SelectedTaskOperatorTaskCommandAction::Archive => Ok(TaskCommand::Archive(
            transition_command(task_command.task_id.clone(), intent),
        )),
    }
}

pub(super) fn refusal(
    kind: SelectedTaskCommandAdmissionRefusalKind,
    reason: &str,
) -> SelectedTaskCommandAdmissionRefusal {
    SelectedTaskCommandAdmissionRefusal {
        kind,
        reason: reason.to_owned(),
    }
}

fn transition_command(
    task_id: nucleus_tasks::TaskId,
    intent: &SelectedTaskCommandOperatorIntent,
) -> TaskTransitionCommand {
    TaskTransitionCommand {
        task_id,
        expected_revision: intent.expected_revision.clone(),
    }
}
