use super::types::{
    EngineTaskWorkItemRecord, EngineTaskWorkItemReviewState, EngineTaskWorkItemRuntimeState,
    EngineTaskWorkItemSet,
};

impl EngineTaskWorkItemRecord {
    /// True when provider work may be done but operator acceptance is still
    /// pending.
    pub fn awaits_operator_acceptance(&self) -> bool {
        self.runtime == EngineTaskWorkItemRuntimeState::Completed
            && matches!(self.review, EngineTaskWorkItemReviewState::AwaitingReview)
    }

    /// True when the work item only links to evidence refs, not raw streams.
    pub fn uses_reference_only_runtime_links(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_raw_runtime_term(summary))
            .unwrap_or(true)
    }
}

fn contains_forbidden_raw_runtime_term(summary: &str) -> bool {
    ["raw transcript", "raw provider payload", "terminal stream"]
        .iter()
        .any(|term| summary.to_lowercase().contains(term))
}

impl EngineTaskWorkItemSet {
    /// Return work items belonging to the set task id.
    pub fn records_for_task(&self) -> Vec<&EngineTaskWorkItemRecord> {
        self.work_items
            .iter()
            .filter(|work_item| work_item.task_id == self.task_id)
            .collect()
    }
}
