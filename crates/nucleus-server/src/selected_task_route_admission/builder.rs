use crate::{
    selected_task_command_admission, SelectedTaskActionFamily, SelectedTaskCommandAdmissionInput,
    SelectedTaskCommandAdmissionStatus, SelectedTaskCommandOperatorIntent,
    SelectedTaskCompletionRouteAdmission, SelectedTaskCompletionRouteAdmissionInput,
    SelectedTaskReviewDecisionOutcome, SelectedTaskReviewOutcomeRouteBlocker,
    SelectedTaskReviewOutcomeRouteCandidate, SelectedTaskReviewOutcomeRouteNoEffects,
    SelectedTaskReviewOutcomeRouteStatus, SelectedTaskReworkDelegationRouteAdmission,
    SelectedTaskReworkDelegationRouteAdmissionInput, SelectedTaskRouteAdmission,
    SelectedTaskRouteAdmissionInput, SelectedTaskRouteAdmissionPreview,
    SelectedTaskRouteAdmissionPreviewFamily, SelectedTaskRouteAdmissionRefusal,
    SelectedTaskRouteAdmissionRefusalKind, SelectedTaskRouteAdmissionStatus,
};

pub fn selected_task_route_admission(
    input: SelectedTaskRouteAdmissionInput,
) -> SelectedTaskRouteAdmission {
    let completion =
        selected_task_completion_route_admission(SelectedTaskCompletionRouteAdmissionInput {
            route: input.route.clone(),
            gate: input.gate,
            expected_revision: input.expected_revision,
            operator_ref: input.operator_ref,
        });
    let rework_delegation = selected_task_rework_delegation_route_admission(
        SelectedTaskReworkDelegationRouteAdmissionInput {
            route: input.route.clone(),
        },
    );

    SelectedTaskRouteAdmission {
        admission_id: format!("selected-task-route-admission:{}", input.route.task_id.0),
        project_id: input.route.project_id.clone(),
        task_id: input.route.task_id.clone(),
        route_id: input.route.route_id,
        completion,
        rework_delegation,
        no_effects: SelectedTaskReviewOutcomeRouteNoEffects::read_only(),
    }
}

pub fn selected_task_completion_route_admission(
    input: SelectedTaskCompletionRouteAdmissionInput,
) -> SelectedTaskCompletionRouteAdmission {
    let route_refusal = route_refusal(&input);
    let command_admission = if route_refusal.is_none() {
        let admission = selected_task_command_admission(SelectedTaskCommandAdmissionInput {
            gate: input.gate.clone(),
            intent: SelectedTaskCommandOperatorIntent {
                family: SelectedTaskActionFamily::CompleteSelectedTask,
                expected_revision: input.expected_revision.clone(),
                reason: None,
                operator_ref: input.operator_ref.clone(),
            },
        });
        Some(admission)
    } else {
        None
    };

    let command_refusal = command_admission
        .as_ref()
        .and_then(|admission| match admission.status {
            SelectedTaskCommandAdmissionStatus::Admitted => None,
            SelectedTaskCommandAdmissionStatus::Refused => Some(refusal(
                SelectedTaskRouteAdmissionRefusalKind::CommandAdmissionRefused,
                admission
                    .refusal
                    .as_ref()
                    .map(|refusal| refusal.reason.as_str())
                    .unwrap_or("selected task command admission refused completion"),
            )),
        });
    let final_refusal = route_refusal.or(command_refusal);
    let status = if final_refusal.is_some() {
        SelectedTaskRouteAdmissionStatus::Refused
    } else {
        SelectedTaskRouteAdmissionStatus::Admitted
    };

    SelectedTaskCompletionRouteAdmission {
        admission_id: format!(
            "selected-task-completion-route-admission:{}",
            input.route.task_id.0
        ),
        project_id: input.route.project_id,
        task_id: input.route.task_id,
        route_id: input.route.route_id,
        route_candidate: input.route.primary_route,
        decision_ref: input.route.decision_ref,
        status,
        command_admission,
        refusal: final_refusal,
        evidence_refs: input.route.evidence_refs,
        no_effects: SelectedTaskReviewOutcomeRouteNoEffects::read_only(),
    }
}

pub fn selected_task_rework_delegation_route_admission(
    input: SelectedTaskReworkDelegationRouteAdmissionInput,
) -> SelectedTaskReworkDelegationRouteAdmission {
    let route_refusal = rework_route_refusal(&input);
    let status = if route_refusal.is_some() {
        SelectedTaskRouteAdmissionStatus::Refused
    } else {
        SelectedTaskRouteAdmissionStatus::Admitted
    };
    let rework_preview = route_refusal.is_none().then(|| {
        preview(
            SelectedTaskRouteAdmissionPreviewFamily::PrepareRework,
            "Prepare rework from rejected or needs-changes review evidence.",
            &input.route,
        )
    });
    let delegation_preview = (route_refusal.is_none()
        && input
            .route
            .candidates
            .contains(&SelectedTaskReviewOutcomeRouteCandidate::ReadyForDelegationAdmission))
    .then(|| {
        preview(
            SelectedTaskRouteAdmissionPreviewFamily::DelegateRework,
            "Delegation may be prepared later, but this preview does not schedule an agent.",
            &input.route,
        )
    });

    SelectedTaskReworkDelegationRouteAdmission {
        admission_id: format!(
            "selected-task-rework-delegation-route-admission:{}",
            input.route.task_id.0
        ),
        project_id: input.route.project_id,
        task_id: input.route.task_id,
        route_id: input.route.route_id,
        route_candidate: input.route.primary_route,
        decision_ref: input.route.decision_ref,
        status,
        rework_preview,
        delegation_preview,
        refusal: route_refusal,
        work_item_refs: input.route.work_item_refs,
        evidence_refs: input.route.evidence_refs,
        no_effects: SelectedTaskReviewOutcomeRouteNoEffects::read_only(),
    }
}

fn route_refusal(
    input: &SelectedTaskCompletionRouteAdmissionInput,
) -> Option<SelectedTaskRouteAdmissionRefusal> {
    if input.route.project_id != input.gate.project_id {
        return Some(refusal(
            SelectedTaskRouteAdmissionRefusalKind::ProjectMismatch,
            "route project id does not match selected task gate",
        ));
    }
    if input.route.task_id != input.gate.task_id {
        return Some(refusal(
            SelectedTaskRouteAdmissionRefusalKind::TaskMismatch,
            "route task id does not match selected task gate",
        ));
    }
    if input.route.decision_ref.is_none() {
        return Some(refusal(
            SelectedTaskRouteAdmissionRefusalKind::MissingDecisionRecord,
            "completion route admission requires a persisted accepted review decision",
        ));
    }
    if input.route.evidence_refs.is_empty() {
        return Some(refusal(
            SelectedTaskRouteAdmissionRefusalKind::MissingReviewEvidence,
            "completion route admission requires accepted review evidence refs",
        ));
    }
    if input
        .route
        .blockers
        .contains(&SelectedTaskReviewOutcomeRouteBlocker::PlanningAmbiguity)
    {
        return Some(refusal(
            SelectedTaskRouteAdmissionRefusalKind::PlanningAmbiguity,
            "completion route admission is blocked by planning ambiguity",
        ));
    }
    if input.route.status == SelectedTaskReviewOutcomeRouteStatus::Stale
        || input
            .route
            .blockers
            .contains(&SelectedTaskReviewOutcomeRouteBlocker::StaleTaskState)
    {
        return Some(refusal(
            SelectedTaskRouteAdmissionRefusalKind::StaleTaskState,
            "completion route admission requires current review outcome state",
        ));
    }
    if input.route.status != SelectedTaskReviewOutcomeRouteStatus::Ready
        || input.route.primary_route
            != SelectedTaskReviewOutcomeRouteCandidate::ReadyForCompletionAdmission
        || input.route.decision_outcome != Some(SelectedTaskReviewDecisionOutcome::Accepted)
        || has_hard_blocker(input)
    {
        return Some(refusal(
            SelectedTaskRouteAdmissionRefusalKind::UnsupportedRoute,
            "completion route admission only supports ready accepted-review completion routes",
        ));
    }

    None
}

fn rework_route_refusal(
    input: &SelectedTaskReworkDelegationRouteAdmissionInput,
) -> Option<SelectedTaskRouteAdmissionRefusal> {
    if input.route.decision_ref.is_none() {
        return Some(refusal(
            SelectedTaskRouteAdmissionRefusalKind::MissingDecisionRecord,
            "rework route admission requires a persisted rejected or needs-changes review decision",
        ));
    }
    if input.route.evidence_refs.is_empty() {
        return Some(refusal(
            SelectedTaskRouteAdmissionRefusalKind::MissingReviewEvidence,
            "rework route admission requires reviewed evidence refs",
        ));
    }
    if input
        .route
        .blockers
        .contains(&SelectedTaskReviewOutcomeRouteBlocker::PlanningAmbiguity)
    {
        return Some(refusal(
            SelectedTaskRouteAdmissionRefusalKind::PlanningAmbiguity,
            "rework route admission is blocked by planning ambiguity",
        ));
    }
    if input.route.status == SelectedTaskReviewOutcomeRouteStatus::Stale
        || input
            .route
            .blockers
            .contains(&SelectedTaskReviewOutcomeRouteBlocker::StaleTaskState)
    {
        return Some(refusal(
            SelectedTaskRouteAdmissionRefusalKind::StaleTaskState,
            "rework route admission requires current review outcome state",
        ));
    }
    if input.route.status != SelectedTaskReviewOutcomeRouteStatus::Ready
        || input.route.primary_route
            != SelectedTaskReviewOutcomeRouteCandidate::ReadyForReworkAdmission
        || !matches!(
            input.route.decision_outcome,
            Some(SelectedTaskReviewDecisionOutcome::Rejected)
                | Some(SelectedTaskReviewDecisionOutcome::NeedsChanges)
        )
        || has_rework_hard_blocker(input)
    {
        return Some(refusal(
            SelectedTaskRouteAdmissionRefusalKind::UnsupportedRoute,
            "rework route admission only supports ready rejected or needs-changes routes",
        ));
    }

    None
}

fn has_hard_blocker(input: &SelectedTaskCompletionRouteAdmissionInput) -> bool {
    input.route.blockers.iter().any(|blocker| {
        *blocker != SelectedTaskReviewOutcomeRouteBlocker::DownstreamCommandNotDefined
    })
}

fn has_rework_hard_blocker(input: &SelectedTaskReworkDelegationRouteAdmissionInput) -> bool {
    input.route.blockers.iter().any(|blocker| {
        *blocker != SelectedTaskReviewOutcomeRouteBlocker::DownstreamCommandNotDefined
    })
}

fn preview(
    family: SelectedTaskRouteAdmissionPreviewFamily,
    summary: &str,
    route: &crate::SelectedTaskReviewOutcomeRoute,
) -> SelectedTaskRouteAdmissionPreview {
    SelectedTaskRouteAdmissionPreview {
        family,
        summary: summary.to_owned(),
        source_refs: route.work_item_refs.clone(),
        evidence_refs: route.evidence_refs.clone(),
    }
}

fn refusal(
    kind: SelectedTaskRouteAdmissionRefusalKind,
    reason: &str,
) -> SelectedTaskRouteAdmissionRefusal {
    SelectedTaskRouteAdmissionRefusal {
        kind,
        reason: reason.to_owned(),
    }
}
