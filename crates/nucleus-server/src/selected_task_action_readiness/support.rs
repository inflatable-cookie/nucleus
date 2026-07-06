use std::collections::HashSet;

use crate::TaskWorkflowDrilldown;

pub(super) struct Facts {
    pub(super) activity: Option<String>,
    pub(super) readiness_lane: Option<String>,
    pub(super) is_closed: bool,
    pub(super) has_active_work: bool,
    pub(super) active_work_items: usize,
    pub(super) completed_work_items: usize,
    pub(super) has_runtime_evidence: bool,
    pub(super) has_completion_evidence: bool,
    pub(super) has_review_evidence: bool,
    pub(super) runtime_evidence_refs: Vec<String>,
    active_work_refs: Vec<String>,
}

impl Facts {
    pub(super) fn from(drilldown: &TaskWorkflowDrilldown) -> Self {
        let activity = drilldown.task.as_ref().map(|task| task.activity.clone());
        let readiness_lane = drilldown
            .readiness
            .as_ref()
            .map(|readiness| readiness.lane.clone());
        let active_work_refs = drilldown
            .work_progress
            .work_items
            .iter()
            .filter(|item| {
                !matches!(
                    item.runtime_status.as_str(),
                    "completed" | "failed" | "cancelled"
                )
            })
            .map(|item| item.work_item_ref.clone())
            .collect::<Vec<_>>();
        let completed_work_items = drilldown
            .work_progress
            .work_items
            .iter()
            .filter(|item| item.runtime_status == "completed")
            .count();
        let runtime_evidence_refs = runtime_evidence_refs(drilldown);
        let has_runtime_evidence = !runtime_evidence_refs.is_empty();
        let has_completion_evidence = !drilldown.runtime.task_completion_refs.is_empty();
        let has_review_evidence = !drilldown.review.review_refs.is_empty();
        let is_closed = matches!(activity.as_deref(), Some("done" | "archived"));

        Self {
            activity,
            readiness_lane,
            is_closed,
            has_active_work: !active_work_refs.is_empty(),
            active_work_items: active_work_refs.len(),
            completed_work_items,
            has_runtime_evidence,
            has_completion_evidence,
            has_review_evidence,
            runtime_evidence_refs,
            active_work_refs,
        }
    }

    pub(super) fn readiness_refs(&self, drilldown: &TaskWorkflowDrilldown) -> Vec<String> {
        drilldown
            .readiness
            .as_ref()
            .map(|readiness| readiness.rationale_refs.clone())
            .unwrap_or_default()
    }

    pub(super) fn active_work_refs(&self) -> Vec<String> {
        self.active_work_refs.clone()
    }

    pub(super) fn completion_and_review_refs(
        &self,
        drilldown: &TaskWorkflowDrilldown,
    ) -> Vec<String> {
        clean_refs(
            drilldown
                .runtime
                .task_completion_refs
                .iter()
                .chain(drilldown.review.review_refs.iter())
                .cloned()
                .collect(),
        )
    }

    pub(super) fn gap_refs(&self, drilldown: &TaskWorkflowDrilldown) -> Vec<String> {
        clean_refs(
            drilldown
                .gaps
                .iter()
                .map(|gap| format!("gap:{:?}", gap.area))
                .collect(),
        )
    }
}

fn runtime_evidence_refs(drilldown: &TaskWorkflowDrilldown) -> Vec<String> {
    clean_refs(
        drilldown
            .runtime
            .runtime_receipt_refs
            .iter()
            .chain(drilldown.runtime.command_evidence_refs.iter())
            .chain(drilldown.runtime.task_completion_refs.iter())
            .chain(
                drilldown
                    .work_progress
                    .work_items
                    .iter()
                    .flat_map(|item| item.receipt_refs.iter()),
            )
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
            .chain(
                drilldown
                    .work_progress
                    .work_items
                    .iter()
                    .flat_map(|item| item.artifact_refs.iter()),
            )
            .cloned()
            .collect(),
    )
}

pub(super) fn clean_refs(refs: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut cleaned = refs
        .into_iter()
        .map(|reference| reference.trim().to_owned())
        .filter(|reference| !reference.is_empty())
        .filter(|reference| seen.insert(reference.clone()))
        .collect::<Vec<_>>();
    cleaned.sort();
    cleaned
}
