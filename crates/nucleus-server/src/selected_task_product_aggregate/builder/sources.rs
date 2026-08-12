//! Source health and gap projection: per-source presence states, missing and
//! identity-mismatch gaps, and the source-health rollup.
//!
//! Split from the builder god file; behavior unchanged.

use super::matching::matches_selected;
use super::super::types::{
    SelectedTaskProductAggregateInput, SelectedTaskProductGap, SelectedTaskProductSource,
    SelectedTaskProductSourceHealth, SelectedTaskProductSourceState,
    SelectedTaskProductSourceStatus,
};

pub(super) fn source_health(
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

pub(super) fn source_gaps(
    input: &SelectedTaskProductAggregateInput,
) -> Vec<SelectedTaskProductGap> {
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
