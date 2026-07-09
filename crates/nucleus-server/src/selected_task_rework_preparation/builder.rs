use crate::{
    SelectedTaskReviewOutcomeRouteCandidate, SelectedTaskReworkPreparation,
    SelectedTaskReworkPreparationInput, SelectedTaskReworkPreparationNoEffects,
    SelectedTaskReworkPreparationRefusal, SelectedTaskReworkPreparationRefusalKind,
    SelectedTaskReworkPreparationStatus, SelectedTaskRouteAdmissionPreviewFamily,
    SelectedTaskRouteAdmissionStatus,
};

pub fn selected_task_rework_preparation(
    input: SelectedTaskReworkPreparationInput,
) -> SelectedTaskReworkPreparation {
    let refusal = preparation_refusal(&input);
    let status = if refusal.is_some() {
        SelectedTaskReworkPreparationStatus::Refused
    } else {
        SelectedTaskReworkPreparationStatus::Admitted
    };
    let rework_summary = if refusal.is_none() {
        input
            .route_admission
            .rework_delegation
            .rework_preview
            .as_ref()
            .map(|preview| preview.summary.clone())
    } else {
        None
    };

    SelectedTaskReworkPreparation {
        preparation_id: format!("selected-task-rework-preparation:{}", input.task_id.0),
        project_id: input.project_id,
        task_id: input.task_id,
        route_admission_id: input.route_admission_id,
        route_id: input.route_admission.route_id,
        review_decision_ref: input.route_admission.rework_delegation.decision_ref,
        status,
        refusal,
        reviewed_work_item_refs: clean_refs(input.reviewed_work_item_refs),
        reviewed_evidence_refs: clean_refs(input.reviewed_evidence_refs),
        operator_ref: input.operator_ref,
        expected_task_revision: input.expected_task_revision,
        expected_work_item_revision: input.expected_work_item_revision,
        rework_summary,
        no_effects: SelectedTaskReworkPreparationNoEffects::read_only(),
    }
}

fn preparation_refusal(
    input: &SelectedTaskReworkPreparationInput,
) -> Option<SelectedTaskReworkPreparationRefusal> {
    if input.project_id != input.route_admission.project_id {
        return Some(refusal(
            SelectedTaskReworkPreparationRefusalKind::ProjectMismatch,
            "rework preparation project id does not match route admission",
        ));
    }
    if input.task_id != input.route_admission.task_id {
        return Some(refusal(
            SelectedTaskReworkPreparationRefusalKind::TaskMismatch,
            "rework preparation task id does not match route admission",
        ));
    }
    if input.operator_ref.trim().is_empty() {
        return Some(refusal(
            SelectedTaskReworkPreparationRefusalKind::MissingOperatorIntent,
            "rework preparation requires an operator ref",
        ));
    }
    if input.route_admission_id != input.route_admission.rework_delegation.admission_id {
        return Some(refusal(
            SelectedTaskReworkPreparationRefusalKind::RouteAdmissionMismatch,
            "provided route admission id does not match the selected rework route admission",
        ));
    }
    if input.route_admission.rework_delegation.status != SelectedTaskRouteAdmissionStatus::Admitted
    {
        return Some(refusal(
            SelectedTaskReworkPreparationRefusalKind::RouteAdmissionRefused,
            "rework preparation requires an admitted rework route",
        ));
    }

    let Some(decision_ref) = input
        .route_admission
        .rework_delegation
        .decision_ref
        .as_ref()
    else {
        return Some(refusal(
            SelectedTaskReworkPreparationRefusalKind::MissingReviewDecision,
            "rework preparation requires a reviewed decision ref",
        ));
    };
    if input.review_decision_ref != *decision_ref {
        return Some(refusal(
            SelectedTaskReworkPreparationRefusalKind::ReviewDecisionMismatch,
            "provided review decision ref does not match the admitted rework route",
        ));
    }

    let reviewed_work_refs = clean_refs(input.reviewed_work_item_refs.clone());
    if reviewed_work_refs.is_empty() {
        return Some(refusal(
            SelectedTaskReworkPreparationRefusalKind::MissingReviewedWorkItems,
            "rework preparation requires reviewed work item refs",
        ));
    }
    if !reviewed_work_refs.iter().all(|reference| {
        input
            .route_admission
            .rework_delegation
            .work_item_refs
            .contains(reference)
    }) {
        return Some(refusal(
            SelectedTaskReworkPreparationRefusalKind::WorkItemMismatch,
            "provided work item refs must be present on the admitted rework route",
        ));
    }

    let reviewed_evidence_refs = clean_refs(input.reviewed_evidence_refs.clone());
    if reviewed_evidence_refs.is_empty() {
        return Some(refusal(
            SelectedTaskReworkPreparationRefusalKind::MissingReviewedEvidence,
            "rework preparation requires reviewed evidence refs",
        ));
    }
    if !reviewed_evidence_refs.iter().all(|reference| {
        input
            .route_admission
            .rework_delegation
            .evidence_refs
            .contains(reference)
    }) {
        return Some(refusal(
            SelectedTaskReworkPreparationRefusalKind::EvidenceMismatch,
            "provided evidence refs must be present on the admitted rework route",
        ));
    }

    let has_rework_preview = input
        .route_admission
        .rework_delegation
        .rework_preview
        .as_ref()
        .is_some_and(|preview| {
            preview.family == SelectedTaskRouteAdmissionPreviewFamily::PrepareRework
        });
    let has_rework_route = input.route_admission.rework_delegation.route_candidate
        == SelectedTaskReviewOutcomeRouteCandidate::ReadyForReworkAdmission;
    if !has_rework_preview || !has_rework_route {
        return Some(refusal(
            SelectedTaskReworkPreparationRefusalKind::UnsupportedRoute,
            "rework preparation only supports admitted rejected or needs-changes routes",
        ));
    }

    None
}

fn refusal(
    kind: SelectedTaskReworkPreparationRefusalKind,
    reason: &str,
) -> SelectedTaskReworkPreparationRefusal {
    SelectedTaskReworkPreparationRefusal {
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
