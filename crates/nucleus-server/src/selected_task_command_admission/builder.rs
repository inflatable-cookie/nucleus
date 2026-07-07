use crate::{
    SelectedTaskCommandAdmission, SelectedTaskCommandAdmissionInput,
    SelectedTaskCommandAdmissionRefusal, SelectedTaskCommandAdmissionRefusalKind,
    SelectedTaskCommandAdmissionStatus, SelectedTaskOperatorActionCandidate, TaskWorkflowNoEffects,
};

use super::mapping::{admitted_command, refusal};

pub fn selected_task_command_admission(
    input: SelectedTaskCommandAdmissionInput,
) -> SelectedTaskCommandAdmission {
    let candidate = input
        .gate
        .candidates
        .iter()
        .find(|candidate| candidate.family == input.intent.family)
        .cloned();
    let evidence_refs = candidate
        .as_ref()
        .map(|candidate| candidate.evidence_refs.clone())
        .unwrap_or_default();
    let result = match candidate.as_ref() {
        Some(candidate) => candidate_admission(candidate, &input),
        None => Err(refusal(
            SelectedTaskCommandAdmissionRefusalKind::CandidateNotFound,
            "selected gate candidate was not found",
        )),
    };
    let (status, command, refusal) = match result {
        Ok(command) => (
            SelectedTaskCommandAdmissionStatus::Admitted,
            Some(command),
            None,
        ),
        Err(refusal) => (
            SelectedTaskCommandAdmissionStatus::Refused,
            None,
            Some(refusal),
        ),
    };

    SelectedTaskCommandAdmission {
        admission_id: format!(
            "selected-task-command-admission:{}:{:?}",
            input.gate.task_id.0, input.intent.family
        ),
        project_id: input.gate.project_id,
        task_id: input.gate.task_id,
        family: input.intent.family,
        status,
        command,
        candidate,
        refusal,
        operator_ref: input.intent.operator_ref,
        evidence_refs,
        no_effects: TaskWorkflowNoEffects::read_only(),
    }
}

fn candidate_admission(
    candidate: &SelectedTaskOperatorActionCandidate,
    input: &SelectedTaskCommandAdmissionInput,
) -> Result<crate::TaskCommand, SelectedTaskCommandAdmissionRefusal> {
    if candidate
        .task_command
        .as_ref()
        .is_some_and(|command| command.task_id != input.gate.task_id)
    {
        return Err(refusal(
            SelectedTaskCommandAdmissionRefusalKind::CandidateTaskMismatch,
            "selected gate candidate task id does not match the selected task",
        ));
    }

    admitted_command(candidate, &input.intent)
}
