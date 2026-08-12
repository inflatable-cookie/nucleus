//! Selected-task product matching helpers: identity filtering, matching
//! accessors for each source, and evidence-ref cleanup.
//!
//! Split from the builder god file; behavior unchanged.

use std::collections::BTreeSet;

use super::super::types::SelectedTaskProductAggregateInput;

pub(super) fn matching_drilldown<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::TaskWorkflowDrilldown,
) -> Option<&'a crate::TaskWorkflowDrilldown> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

pub(super) fn matching_readiness<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskActionReadiness,
) -> Option<&'a crate::SelectedTaskActionReadiness> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

pub(super) fn matching_gate<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskOperatorActionGate,
) -> Option<&'a crate::SelectedTaskOperatorActionGate> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

pub(super) fn matching_review_next<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskReviewNext,
) -> Option<&'a crate::SelectedTaskReviewNext> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

pub(super) fn matching_route<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskReviewOutcomeRoute,
) -> Option<&'a crate::SelectedTaskReviewOutcomeRoute> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

pub(super) fn matching_completion<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskCompletionRouteApply,
) -> Option<&'a crate::SelectedTaskCompletionRouteApply> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

pub(super) fn matching_rework<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskReworkPreparation,
) -> Option<&'a crate::SelectedTaskReworkPreparation> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

pub(super) fn matching_scm<'a>(
    input: &SelectedTaskProductAggregateInput,
    source: &'a crate::SelectedTaskScmHandoffReadiness,
) -> Option<&'a crate::SelectedTaskScmHandoffReadiness> {
    matches_selected(input, &source.project_id, &source.task_id).then_some(source)
}

pub(super) fn matches_selected(
    input: &SelectedTaskProductAggregateInput,
    project_id: &nucleus_projects::ProjectId,
    task_id: &nucleus_tasks::TaskId,
) -> bool {
    project_id == &input.project_id && task_id == &input.task_id
}

pub(super) fn clean_refs(refs: Vec<String>) -> Vec<String> {
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
