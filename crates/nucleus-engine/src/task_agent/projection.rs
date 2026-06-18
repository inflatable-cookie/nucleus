use std::collections::BTreeMap;

use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use super::types::{
    EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus,
    EngineTaskAgentWorkUnitSourceCursor, EngineTaskAgentWorkUnitSourceId,
    EngineTaskAgentWorkUnitSourceRecord,
};
use crate::EngineTaskWorkItemId;

/// Rebuildable projection for one task-backed work unit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskAgentWorkUnitProjection {
    pub work_item_id: EngineTaskWorkItemId,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub runtime: EngineTaskAgentWorkUnitRuntimeStatus,
    pub review: EngineTaskAgentWorkUnitReviewStatus,
    pub last_source_id: EngineTaskAgentWorkUnitSourceId,
    pub last_cursor: EngineTaskAgentWorkUnitSourceCursor,
    pub source_count: usize,
    pub issues: Vec<EngineTaskAgentWorkUnitProjectionIssue>,
    pub summary: String,
}

/// Projection issue that clients can show without gaining mutation authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskAgentWorkUnitProjectionIssue {
    EmptyActorRef,
    EmptyAdapterRef,
    EmptyProviderInstanceRef,
    ForbiddenSummaryTerm(String),
}

/// Rebuild task-agent work-unit state from source records.
pub fn project_task_agent_work_units(
    records: &[EngineTaskAgentWorkUnitSourceRecord],
) -> Vec<EngineTaskAgentWorkUnitProjection> {
    let mut grouped: BTreeMap<String, Vec<&EngineTaskAgentWorkUnitSourceRecord>> = BTreeMap::new();
    for record in records {
        grouped
            .entry(record.work_item_id.0.clone())
            .or_default()
            .push(record);
    }

    grouped
        .into_values()
        .map(|mut group| {
            group.sort_by(|left, right| left.source_cursor.0.cmp(&right.source_cursor.0));
            let latest = group.last().expect("group has at least one record");
            EngineTaskAgentWorkUnitProjection {
                work_item_id: latest.work_item_id.clone(),
                project_id: latest.project_id.clone(),
                task_id: latest.task_id.clone(),
                runtime: latest.runtime.clone(),
                review: latest.review.clone(),
                last_source_id: latest.source_id.clone(),
                last_cursor: latest.source_cursor.clone(),
                source_count: group.len(),
                issues: group
                    .iter()
                    .flat_map(|record| projection_issues(record))
                    .collect(),
                summary: latest.summary.clone(),
            }
        })
        .collect()
}

fn projection_issues(
    record: &EngineTaskAgentWorkUnitSourceRecord,
) -> Vec<EngineTaskAgentWorkUnitProjectionIssue> {
    let mut issues = Vec::new();
    if record.actor_ref.trim().is_empty() {
        issues.push(EngineTaskAgentWorkUnitProjectionIssue::EmptyActorRef);
    }
    if record.adapter_id.trim().is_empty() {
        issues.push(EngineTaskAgentWorkUnitProjectionIssue::EmptyAdapterRef);
    }
    if record.provider_instance_id.trim().is_empty() {
        issues.push(EngineTaskAgentWorkUnitProjectionIssue::EmptyProviderInstanceRef);
    }
    for term in [
        "raw stdout",
        "raw stderr",
        "terminal stream",
        "provider payload",
    ] {
        if record.summary.to_lowercase().contains(term) {
            issues.push(
                EngineTaskAgentWorkUnitProjectionIssue::ForbiddenSummaryTerm(term.to_owned()),
            );
        }
    }
    issues
}
