use std::collections::BTreeSet;

use super::types::{
    SelectedTaskProductAggregate, SelectedTaskProductAggregateInput, SelectedTaskProductBlocker,
    SelectedTaskProductCommandPreview, SelectedTaskProductCommandPreviews,
    SelectedTaskProductCompletion, SelectedTaskProductGap, SelectedTaskProductIdentity,
    SelectedTaskProductReadiness, SelectedTaskProductReview, SelectedTaskProductRework,
    SelectedTaskProductScmHandoff, SelectedTaskProductSource, SelectedTaskProductSourceHealth,
    SelectedTaskProductSourceState, SelectedTaskProductSourceStatus,
    SelectedTaskProductUnavailableAction, SelectedTaskProductWorkEvidence,
    SelectedTaskProductWorkflow,
};
use crate::{
    SelectedTaskActionStatus, SelectedTaskCommandAdmissionStatus,
    SelectedTaskOperatorActionDisposition, TaskWorkflowNoEffects,
};

pub fn selected_task_product_aggregate(
    input: SelectedTaskProductAggregateInput,
) -> SelectedTaskProductAggregate {
    let gaps = source_gaps(&input);
    let source_health = source_health(&input, &gaps);

    SelectedTaskProductAggregate {
        aggregate_id: format!("selected-task-product-aggregate:{}", input.task_id.0),
        project_id: input.project_id.clone(),
        task_id: input.task_id.clone(),
        identity: identity(&input),
        workflow: workflow(&input),
        readiness: readiness(&input),
        command_previews: command_previews(&input),
        work_evidence: work_evidence(&input),
        review: review(&input),
        rework: rework(&input),
        completion: completion(&input),
        scm_handoff: scm_handoff(&input),
        source_health,
        gaps,
        no_effects: TaskWorkflowNoEffects::read_only(),
    }
}

fn identity(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductIdentity {
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

fn workflow(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductWorkflow {
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

fn readiness(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductReadiness {
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

fn command_previews(
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

fn work_evidence(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductWorkEvidence {
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

fn review(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductReview {
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

fn rework(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductRework {
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

fn completion(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductCompletion {
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

fn scm_handoff(input: &SelectedTaskProductAggregateInput) -> SelectedTaskProductScmHandoff {
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

fn source_health(
    input: &SelectedTaskProductAggregateInput,
    gaps: &[SelectedTaskProductGap],
) -> SelectedTaskProductSourceHealth {
    let sources = [
        source_status(
            input,
            SelectedTaskProductSource::Drilldown,
            input
                .drilldown
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        source_status(
            input,
            SelectedTaskProductSource::ActionReadiness,
            input
                .action_readiness
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        source_status(
            input,
            SelectedTaskProductSource::OperatorGate,
            input
                .operator_gate
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        command_admissions_status(input),
        source_status(
            input,
            SelectedTaskProductSource::ReviewNext,
            input
                .review_next
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        source_status(
            input,
            SelectedTaskProductSource::ReviewOutcomeRoute,
            input
                .review_outcome_route
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        source_status(
            input,
            SelectedTaskProductSource::RouteAdmission,
            input
                .route_admission
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        source_status(
            input,
            SelectedTaskProductSource::CompletionApply,
            input
                .completion_apply
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        source_status(
            input,
            SelectedTaskProductSource::ReworkPreparation,
            input
                .rework_preparation
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        source_status(
            input,
            SelectedTaskProductSource::ScmHandoff,
            input
                .scm_handoff
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
    ]
    .into_iter()
    .collect::<Vec<_>>();

    SelectedTaskProductSourceHealth {
        missing_count: sources
            .iter()
            .filter(|source| source.state == SelectedTaskProductSourceState::Missing)
            .count(),
        partial_count: sources
            .iter()
            .filter(|source| source.state == SelectedTaskProductSourceState::Partial)
            .count(),
        sources: sources
            .into_iter()
            .map(|mut status| {
                if let Some(gap) = gaps.iter().find(|gap| gap.source == status.source) {
                    status.reason = Some(gap.reason.clone());
                }
                status
            })
            .collect(),
    }
}

fn source_gaps(input: &SelectedTaskProductAggregateInput) -> Vec<SelectedTaskProductGap> {
    let mut gaps = Vec::new();

    push_gap_if_missing(
        &mut gaps,
        input.drilldown.is_none(),
        SelectedTaskProductSource::Drilldown,
        "task workflow drilldown source is missing",
    );
    push_gap_if_missing(
        &mut gaps,
        input.action_readiness.is_none(),
        SelectedTaskProductSource::ActionReadiness,
        "selected-task action readiness source is missing",
    );
    push_gap_if_missing(
        &mut gaps,
        input.operator_gate.is_none(),
        SelectedTaskProductSource::OperatorGate,
        "selected-task operator action gate source is missing",
    );
    push_gap_if_missing(
        &mut gaps,
        input.command_admissions.is_empty(),
        SelectedTaskProductSource::CommandAdmissions,
        "selected-task command admission sources are missing",
    );
    push_gap_if_missing(
        &mut gaps,
        input.review_next.is_none(),
        SelectedTaskProductSource::ReviewNext,
        "selected-task review next-step source is missing",
    );
    push_gap_if_missing(
        &mut gaps,
        input.review_outcome_route.is_none(),
        SelectedTaskProductSource::ReviewOutcomeRoute,
        "selected-task review outcome route source is missing",
    );
    push_gap_if_missing(
        &mut gaps,
        input.route_admission.is_none(),
        SelectedTaskProductSource::RouteAdmission,
        "selected-task route admission source is missing",
    );
    push_gap_if_missing(
        &mut gaps,
        input.completion_apply.is_none(),
        SelectedTaskProductSource::CompletionApply,
        "selected-task completion route apply preview source is missing",
    );
    push_gap_if_missing(
        &mut gaps,
        input.rework_preparation.is_none(),
        SelectedTaskProductSource::ReworkPreparation,
        "selected-task rework preparation source is missing",
    );
    push_gap_if_missing(
        &mut gaps,
        input.scm_handoff.is_none(),
        SelectedTaskProductSource::ScmHandoff,
        "selected-task SCM handoff source is missing",
    );

    gaps.extend(mismatch_gaps(input));
    gaps
}

fn mismatch_gaps(input: &SelectedTaskProductAggregateInput) -> Vec<SelectedTaskProductGap> {
    let mut gaps = Vec::new();
    let sources = [
        (
            SelectedTaskProductSource::Drilldown,
            input
                .drilldown
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        (
            SelectedTaskProductSource::ActionReadiness,
            input
                .action_readiness
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        (
            SelectedTaskProductSource::OperatorGate,
            input
                .operator_gate
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        (
            SelectedTaskProductSource::ReviewNext,
            input
                .review_next
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        (
            SelectedTaskProductSource::ReviewOutcomeRoute,
            input
                .review_outcome_route
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        (
            SelectedTaskProductSource::RouteAdmission,
            input
                .route_admission
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        (
            SelectedTaskProductSource::CompletionApply,
            input
                .completion_apply
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        (
            SelectedTaskProductSource::ReworkPreparation,
            input
                .rework_preparation
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
        (
            SelectedTaskProductSource::ScmHandoff,
            input
                .scm_handoff
                .as_ref()
                .map(|source| (&source.project_id, &source.task_id)),
        ),
    ];

    for (source, ids) in sources {
        if let Some((project_id, task_id)) = ids {
            if !matches_selected(input, project_id, task_id) {
                gaps.push(SelectedTaskProductGap {
                    source,
                    reason: "source project/task identity does not match aggregate request"
                        .to_owned(),
                });
            }
        }
    }
    if input
        .command_admissions
        .iter()
        .any(|source| !matches_selected(input, &source.project_id, &source.task_id))
    {
        gaps.push(SelectedTaskProductGap {
            source: SelectedTaskProductSource::CommandAdmissions,
            reason: "one or more command admission sources do not match aggregate request"
                .to_owned(),
        });
    }

    gaps
}

fn source_status(
    input: &SelectedTaskProductAggregateInput,
    source: SelectedTaskProductSource,
    ids: Option<(&nucleus_projects::ProjectId, &nucleus_tasks::TaskId)>,
) -> SelectedTaskProductSourceStatus {
    match ids {
        None => SelectedTaskProductSourceStatus {
            source,
            state: SelectedTaskProductSourceState::Missing,
            reason: None,
        },
        Some((project_id, task_id)) if matches_selected(input, project_id, task_id) => {
            SelectedTaskProductSourceStatus {
                source,
                state: SelectedTaskProductSourceState::Present,
                reason: None,
            }
        }
        Some(_) => SelectedTaskProductSourceStatus {
            source,
            state: SelectedTaskProductSourceState::Partial,
            reason: None,
        },
    }
}

fn command_admissions_status(
    input: &SelectedTaskProductAggregateInput,
) -> SelectedTaskProductSourceStatus {
    if input.command_admissions.is_empty() {
        return SelectedTaskProductSourceStatus {
            source: SelectedTaskProductSource::CommandAdmissions,
            state: SelectedTaskProductSourceState::Missing,
            reason: None,
        };
    }

    let has_mismatch = input
        .command_admissions
        .iter()
        .any(|source| !matches_selected(input, &source.project_id, &source.task_id));
    SelectedTaskProductSourceStatus {
        source: SelectedTaskProductSource::CommandAdmissions,
        state: if has_mismatch {
            SelectedTaskProductSourceState::Partial
        } else {
            SelectedTaskProductSourceState::Present
        },
        reason: None,
    }
}

fn push_gap_if_missing(
    gaps: &mut Vec<SelectedTaskProductGap>,
    condition: bool,
    source: SelectedTaskProductSource,
    reason: &str,
) {
    if condition {
        gaps.push(SelectedTaskProductGap {
            source,
            reason: reason.to_owned(),
        });
    }
}

fn matching_drilldown<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::TaskWorkflowDrilldown,
) -> Option<&'a crate::TaskWorkflowDrilldown> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

fn matching_readiness<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskActionReadiness,
) -> Option<&'a crate::SelectedTaskActionReadiness> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

fn matching_gate<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskOperatorActionGate,
) -> Option<&'a crate::SelectedTaskOperatorActionGate> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

fn matching_review_next<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskReviewNext,
) -> Option<&'a crate::SelectedTaskReviewNext> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

fn matching_route<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskReviewOutcomeRoute,
) -> Option<&'a crate::SelectedTaskReviewOutcomeRoute> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

fn matching_completion<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskCompletionRouteApply,
) -> Option<&'a crate::SelectedTaskCompletionRouteApply> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

fn matching_rework<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskReworkPreparation,
) -> Option<&'a crate::SelectedTaskReworkPreparation> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

fn matching_scm<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskScmHandoffReadiness,
) -> Option<&'a crate::SelectedTaskScmHandoffReadiness> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

fn matches_selected(
    input: &SelectedTaskProductAggregateInput,
    project_id: &nucleus_projects::ProjectId,
    task_id: &nucleus_tasks::TaskId,
) -> bool {
    project_id == &input.project_id && task_id == &input.task_id
}

fn clean_refs(refs: Vec<String>) -> Vec<String> {
    let mut refs = refs
        .into_iter()
        .map(|reference| reference.trim().to_owned())
        .filter(|reference| !reference.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    refs.sort();
    refs
}
