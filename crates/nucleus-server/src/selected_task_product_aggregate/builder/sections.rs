//! Selected-task product section builders: identity, workflow, readiness,
//! command previews, work evidence, review, rework, completion, and SCM
//! handoff projections.
//!
//! Split from the builder god file; behavior unchanged.

use super::matching::{
    clean_refs, matching_completion, matching_drilldown, matching_gate, matching_readiness,
    matching_review_next, matching_rework, matching_route, matching_scm, matches_selected,
};
use super::super::types::{
    SelectedTaskProductAggregateInput, SelectedTaskProductBlocker, SelectedTaskProductCommandPreview,
    SelectedTaskProductCommandPreviews, SelectedTaskProductCompletion,
    SelectedTaskProductIdentity, SelectedTaskProductReadiness, SelectedTaskProductReview,
    SelectedTaskProductRework, SelectedTaskProductScmHandoff, SelectedTaskProductUnavailableAction,
    SelectedTaskProductWorkEvidence, SelectedTaskProductWorkflow,
};
use crate::{
    SelectedTaskActionStatus, SelectedTaskCommandAdmissionStatus,
    SelectedTaskOperatorActionDisposition,
};

pub(super) fn identity(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductIdentity {
    let task = input.drilldown.as_ref().and_then(|drilldown| {
        matches_selected(input, &drilldown.project_id, &drilldown.task_id)
            .then_some(drilldown.task.as_ref())
            .flatten()
    });

    SelectedTaskProductIdentity {
        title: task.map(|task| task.title.clone()),
        activity: task.map(|task| task.activity.clone()),
        assignment: task.map(|task| task.assignment.clone()),
        action_type: task.map(|task| task.action_type.clone()),
        expected_revision: input.expected_revision.clone(),
    }
}

pub(super) fn workflow(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductWorkflow {
    if let Some(candidate) = input.operator_gate.as_ref().and_then(|gate| {
        matching_gate(input, gate).and_then(|gate| {
            gate.candidates
                .iter()
                .find(|candidate| {
                    candidate.disposition
                        == SelectedTaskOperatorActionDisposition::TaskCommandCandidate
                })
                .or_else(|| {
                    gate.candidates.iter().find(|candidate| {
                        candidate.disposition == SelectedTaskOperatorActionDisposition::ReadOnly
                    })
                })
        })
    }) {
        return SelectedTaskProductWorkflow {
            primary_next_action: candidate.label.clone(),
            reason: candidate.reason.clone(),
            phase: "operator_action".to_owned(),
            next_ref: candidate
                .task_command
                .as_ref()
                .map(|command| command.task_id.0.clone()),
            blocked_reason: None,
        };
    }

    if let Some(review_next) = input
        .review_next
        .as_ref()
        .and_then(|review_next| matching_review_next(input, review_next))
    {
        return SelectedTaskProductWorkflow {
            primary_next_action: format!("{:?}", review_next.next.category),
            reason: review_next.next.summary.clone(),
            phase: "review".to_owned(),
            next_ref: review_next.next.next_ref.clone(),
            blocked_reason: None,
        };
    }

    if let Some(drilldown) = input
        .drilldown
        .as_ref()
        .and_then(|drilldown| matching_drilldown(input, drilldown))
    {
        return SelectedTaskProductWorkflow {
            primary_next_action: format!("{:?}", drilldown.guidance.safe_action),
            reason: drilldown.guidance.reason.clone(),
            phase: format!("{:?}", drilldown.guidance.source),
            next_ref: drilldown.next.next_ref.clone(),
            blocked_reason: drilldown
                .guidance
                .blocked_reason
                .clone()
                .or_else(|| drilldown.next.blocked_reason.clone()),
        };
    }

    SelectedTaskProductWorkflow {
        primary_next_action: "InspectSourceGaps".to_owned(),
        reason: "selected-task aggregate is missing its workflow sources".to_owned(),
        phase: "source_gap".to_owned(),
        next_ref: None,
        blocked_reason: Some("selected task workflow sources are missing".to_owned()),
    }
}

pub(super) fn readiness(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductReadiness {
    let readiness = input
        .action_readiness
        .as_ref()
        .and_then(|readiness| matching_readiness(input, readiness));
    let allowed_action_count = readiness
        .map(|readiness| {
            readiness
                .actions
                .iter()
                .filter(|action| action.status == SelectedTaskActionStatus::Allowed)
                .count()
        })
        .unwrap_or_default();
    let blockers = readiness
        .map(|readiness| {
            readiness
                .blockers
                .iter()
                .map(|blocker| SelectedTaskProductBlocker {
                    family: blocker.family,
                    reason: blocker.reason.clone(),
                    evidence_refs: clean_refs(blocker.evidence_refs.clone()),
                })
                .collect()
        })
        .unwrap_or_default();
    let unavailable_actions = readiness
        .map(|readiness| {
            readiness
                .actions
                .iter()
                .filter(|action| action.status != SelectedTaskActionStatus::Allowed)
                .map(|action| SelectedTaskProductUnavailableAction {
                    family: action.family,
                    status: action.status,
                    reason: action.reason.clone(),
                })
                .collect()
        })
        .unwrap_or_default();

    SelectedTaskProductReadiness {
        blockers,
        unavailable_actions,
        allowed_action_count,
    }
}

pub(super) fn command_previews(
    input: &SelectedTaskProductAggregateInput,
) -> SelectedTaskProductCommandPreviews {
    let previews = input
        .command_admissions
        .iter()
        .filter(|admission| matches_selected(input, &admission.project_id, &admission.task_id))
        .map(|admission| SelectedTaskProductCommandPreview {
            family: admission.family,
            status: admission.status,
            command_available: admission.command.is_some(),
            refusal_reason: admission
                .refusal
                .as_ref()
                .map(|refusal| refusal.reason.clone()),
            evidence_refs: clean_refs(admission.evidence_refs.clone()),
        })
        .collect::<Vec<_>>();
    let admitted_count = previews
        .iter()
        .filter(|preview| preview.status == SelectedTaskCommandAdmissionStatus::Admitted)
        .count();
    let refused_count = previews.len().saturating_sub(admitted_count);

    SelectedTaskProductCommandPreviews {
        admitted_count,
        refused_count,
        previews,
    }
}

pub(super) fn work_evidence(
    input: &SelectedTaskProductAggregateInput,
) -> SelectedTaskProductWorkEvidence {
    let Some(drilldown) = input
        .drilldown
        .as_ref()
        .and_then(|drilldown| matching_drilldown(input, drilldown))
    else {
        return SelectedTaskProductWorkEvidence {
            work_item_refs: Vec::new(),
            active_work_item_count: 0,
            completed_work_item_count: 0,
            evidence_refs: Vec::new(),
            timeline_refs: Vec::new(),
        };
    };

    let work_item_refs = clean_refs(
        drilldown
            .work_progress
            .work_items
            .iter()
            .map(|item| item.work_item_ref.clone())
            .collect(),
    );
    let active_work_item_count = drilldown
        .work_progress
        .work_items
        .iter()
        .filter(|item| item.runtime_status != "completed")
        .count();
    let completed_work_item_count = drilldown
        .work_progress
        .work_items
        .iter()
        .filter(|item| item.runtime_status == "completed")
        .count();
    let evidence_refs = clean_refs(
        drilldown
            .runtime
            .runtime_receipt_refs
            .iter()
            .chain(drilldown.runtime.command_evidence_refs.iter())
            .chain(drilldown.runtime.task_completion_refs.iter())
            .chain(drilldown.review.review_refs.iter())
            .chain(
                drilldown
                    .work_progress
                    .work_items
                    .iter()
                    .flat_map(|item| item.checkpoint_refs.iter()),
            )
            .chain(
                drilldown
                    .work_progress
                    .work_items
                    .iter()
                    .flat_map(|item| item.diff_summary_refs.iter()),
            )
            .chain(
                drilldown
                    .work_progress
                    .work_items
                    .iter()
                    .flat_map(|item| item.validation_refs.iter()),
            )
            .cloned()
            .collect(),
    );
    let timeline_refs = clean_refs(
        drilldown
            .timeline
            .entry_refs
            .iter()
            .chain(
                drilldown
                    .work_progress
                    .work_items
                    .iter()
                    .flat_map(|item| item.timeline_entry_refs.iter()),
            )
            .cloned()
            .collect(),
    );

    SelectedTaskProductWorkEvidence {
        work_item_refs,
        active_work_item_count,
        completed_work_item_count,
        evidence_refs,
        timeline_refs,
    }
}

pub(super) fn review(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductReview {
    let review_next = input
        .review_next
        .as_ref()
        .and_then(|review_next| matching_review_next(input, review_next));
    let route = input
        .review_outcome_route
        .as_ref()
        .and_then(|route| matching_route(input, route));
    let blocker_reasons = route
        .map(|route| {
            route
                .blockers
                .iter()
                .map(|blocker| format!("{blocker:?}"))
                .collect()
        })
        .unwrap_or_default();

    SelectedTaskProductReview {
        state: review_next.map(|review_next| review_next.review.state),
        next_category: review_next.map(|review_next| review_next.next.category),
        route_status: route.map(|route| route.status),
        primary_route: route.map(|route| route.primary_route),
        decision_ref: route.and_then(|route| route.decision_ref.clone()),
        decision_available: route.is_some_and(|route| route.decision_ref.is_some()),
        blocker_reasons,
        evidence_refs: clean_refs(
            review_next
                .map(|review_next| {
                    review_next
                        .evidence
                        .receipt_refs
                        .iter()
                        .chain(review_next.evidence.checkpoint_refs.iter())
                        .chain(review_next.evidence.diff_summary_refs.iter())
                        .chain(review_next.evidence.validation_refs.iter())
                        .chain(review_next.evidence.timeline_refs.iter())
                        .chain(review_next.evidence.review_refs.iter())
                        .cloned()
                        .collect()
                })
                .unwrap_or_default(),
        ),
    }
}

pub(super) fn rework(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductRework {
    let preparation = input
        .rework_preparation
        .as_ref()
        .and_then(|preparation| matching_rework(input, preparation));

    SelectedTaskProductRework {
        status: preparation.map(|preparation| preparation.status),
        summary: preparation.and_then(|preparation| preparation.rework_summary.clone()),
        refusal_reason: preparation
            .and_then(|preparation| preparation.refusal.as_ref())
            .map(|refusal| refusal.reason.clone()),
        reviewed_work_item_refs: clean_refs(
            preparation
                .map(|preparation| preparation.reviewed_work_item_refs.clone())
                .unwrap_or_default(),
        ),
        reviewed_evidence_refs: clean_refs(
            preparation
                .map(|preparation| preparation.reviewed_evidence_refs.clone())
                .unwrap_or_default(),
        ),
    }
}

pub(super) fn completion(
    input: &SelectedTaskProductAggregateInput,
) -> SelectedTaskProductCompletion {
    let completion = input
        .completion_apply
        .as_ref()
        .and_then(|completion| matching_completion(input, completion));

    SelectedTaskProductCompletion {
        status: completion.map(|completion| completion.status),
        command_available: completion.is_some_and(|completion| completion.command.is_some()),
        refusal_reason: completion
            .and_then(|completion| completion.refusal.as_ref())
            .map(|refusal| refusal.reason.clone()),
        evidence_refs: clean_refs(
            completion
                .map(|completion| completion.evidence_refs.clone())
                .unwrap_or_default(),
        ),
    }
}

pub(super) fn scm_handoff(
    input: &SelectedTaskProductAggregateInput,
) -> SelectedTaskProductScmHandoff {
    let handoff = input
        .scm_handoff
        .as_ref()
        .and_then(|handoff| matching_scm(input, handoff));

    SelectedTaskProductScmHandoff {
        state: handoff.map(|handoff| handoff.readiness.state),
        next_category: handoff.map(|handoff| handoff.next.category),
        target_shape: handoff.map(|handoff| handoff.target.shape),
        blocker_refs: clean_refs(
            handoff
                .map(|handoff| handoff.readiness.blocker_refs.clone())
                .unwrap_or_default(),
        ),
        evidence_refs: clean_refs(
            handoff
                .map(|handoff| {
                    handoff
                        .evidence
                        .work_item_refs
                        .iter()
                        .chain(handoff.evidence.scm_handoff_refs.iter())
                        .chain(handoff.evidence.scm_work_session_refs.iter())
                        .chain(handoff.evidence.provider_change_refs.iter())
                        .chain(handoff.evidence.checkpoint_refs.iter())
                        .chain(handoff.evidence.diff_summary_refs.iter())
                        .chain(handoff.evidence.runtime_receipt_refs.iter())
                        .chain(handoff.evidence.validation_refs.iter())
                        .chain(handoff.evidence.review_refs.iter())
                        .chain(handoff.evidence.change_request_prep_refs.iter())
                        .chain(handoff.evidence.repair_refs.iter())
                        .cloned()
                        .collect()
                })
                .unwrap_or_default(),
        ),
        gap_count: handoff
            .map(|handoff| handoff.gaps.len())
            .unwrap_or_default(),
    }
}
