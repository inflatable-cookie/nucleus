use std::collections::{BTreeMap, BTreeSet};

use super::types::PlanningProjectionImportActiveApplyRevisionExpectationRef;

pub(super) fn revision_expectation_map(
    refs: Vec<PlanningProjectionImportActiveApplyRevisionExpectationRef>,
) -> BTreeMap<String, String> {
    refs.into_iter()
        .filter_map(|revision_ref| {
            let operation_id = revision_ref.operation_id.trim().to_owned();
            let expected = revision_ref.expected_current_revision.trim().to_owned();
            (!operation_id.is_empty() && !expected.is_empty()).then_some((operation_id, expected))
        })
        .collect()
}

pub(super) fn sorted_unique_refs(refs: Vec<String>) -> Vec<String> {
    refs.into_iter()
        .map(|evidence_ref| evidence_ref.trim().to_owned())
        .filter(|evidence_ref| !evidence_ref.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub(super) fn non_empty_option(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}
