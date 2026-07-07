use crate::{
    SelectedTaskCommandAdmissionStatus, SelectedTaskCompletionRouteApply,
    SelectedTaskCompletionRouteApplyInput, SelectedTaskCompletionRouteApplyRefusal,
    SelectedTaskCompletionRouteApplyRefusalKind, SelectedTaskCompletionRouteApplyStatus,
    SelectedTaskReviewOutcomeRouteNoEffects, SelectedTaskRouteAdmissionStatus, TaskCommand,
};

pub fn selected_task_completion_route_apply(
    input: SelectedTaskCompletionRouteApplyInput,
) -> SelectedTaskCompletionRouteApply {
    let refusal = apply_refusal(&input);
    let command_admission = input.route_admission.completion.command_admission.clone();
    let command = if refusal.is_none() {
        command_admission
            .as_ref()
            .and_then(|admission| admission.command.clone())
    } else {
        None
    };
    let status = if refusal.is_some() {
        SelectedTaskCompletionRouteApplyStatus::Refused
    } else {
        SelectedTaskCompletionRouteApplyStatus::Admitted
    };

    SelectedTaskCompletionRouteApply {
        apply_id: format!("selected-task-completion-route-apply:{}", input.task_id.0),
        project_id: input.project_id,
        task_id: input.task_id,
        route_admission_id: input.route_admission_id,
        route_id: input.route_admission.route_id,
        review_decision_ref: input.route_admission.completion.decision_ref,
        status,
        command,
        command_admission,
        refusal,
        evidence_refs: clean_refs(input.evidence_refs),
        operator_ref: input.operator_ref,
        no_effects: SelectedTaskReviewOutcomeRouteNoEffects::read_only(),
    }
}

fn apply_refusal(
    input: &SelectedTaskCompletionRouteApplyInput,
) -> Option<SelectedTaskCompletionRouteApplyRefusal> {
    if input.project_id != input.route_admission.project_id {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::ProjectMismatch,
            "apply project id does not match route admission",
        ));
    }
    if input.task_id != input.route_admission.task_id {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::TaskMismatch,
            "apply task id does not match route admission",
        ));
    }
    if input.operator_ref.trim().is_empty() {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::MissingOperatorIntent,
            "completion route apply requires an operator ref",
        ));
    }
    if input.expected_revision.is_none() {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::MissingExpectedRevision,
            "completion route apply requires an expected task revision",
        ));
    }
    if input.route_admission_id != input.route_admission.admission_id {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::RouteAdmissionMismatch,
            "provided route admission id does not match the selected route admission",
        ));
    }
    if input.route_admission.completion.status != SelectedTaskRouteAdmissionStatus::Admitted {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::RouteAdmissionRefused,
            "completion route apply requires an admitted completion route",
        ));
    }

    let Some(decision_ref) = input.route_admission.completion.decision_ref.as_ref() else {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::MissingReviewDecision,
            "completion route apply requires a reviewed decision ref",
        ));
    };
    if input.review_decision_ref != *decision_ref {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::ReviewDecisionMismatch,
            "provided review decision ref does not match the admitted completion route",
        ));
    }

    let reviewed_refs = clean_refs(input.evidence_refs.clone());
    if reviewed_refs.is_empty() {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::MissingReviewedEvidence,
            "completion route apply requires reviewed evidence refs",
        ));
    }
    if !reviewed_refs.iter().all(|reference| {
        input
            .route_admission
            .completion
            .evidence_refs
            .contains(reference)
    }) {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::EvidenceMismatch,
            "provided evidence refs must be present on the admitted completion route",
        ));
    }

    let Some(command_admission) = input.route_admission.completion.command_admission.as_ref()
    else {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::MissingCommandAdmission,
            "completion route apply requires selected-task command admission",
        ));
    };
    if command_admission.operator_ref != input.operator_ref {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::MissingOperatorIntent,
            "operator ref does not match selected-task command admission",
        ));
    }
    if command_admission.status != SelectedTaskCommandAdmissionStatus::Admitted {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::CommandAdmissionRefused,
            "selected-task command admission refused completion",
        ));
    }

    let Some(TaskCommand::Complete(command)) = command_admission.command.as_ref() else {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::UnsupportedCommand,
            "completion route apply only supports task complete commands",
        ));
    };
    if command.task_id != input.task_id {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::TaskMismatch,
            "selected-task command targets a different task",
        ));
    }
    if command.expected_revision != input.expected_revision {
        return Some(refusal(
            SelectedTaskCompletionRouteApplyRefusalKind::StaleTaskState,
            "selected-task command expected revision does not match apply intent",
        ));
    }

    None
}

fn refusal(
    kind: SelectedTaskCompletionRouteApplyRefusalKind,
    reason: &str,
) -> SelectedTaskCompletionRouteApplyRefusal {
    SelectedTaskCompletionRouteApplyRefusal {
        kind,
        reason: reason.to_owned(),
    }
}

fn clean_refs(refs: Vec<String>) -> Vec<String> {
    let mut refs = refs
        .into_iter()
        .map(|reference| reference.trim().to_owned())
        .filter(|reference| !reference.is_empty())
        .collect::<Vec<_>>();
    refs.sort();
    refs.dedup();
    refs
}
