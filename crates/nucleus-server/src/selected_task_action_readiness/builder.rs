use super::actions::action;
use super::support::Facts;
use crate::{
    SelectedTaskActionBlocker, SelectedTaskActionFamily, SelectedTaskActionReadiness,
    SelectedTaskActionSourceCounts, SelectedTaskActionStatus, TaskWorkflowDrilldown,
    TaskWorkflowNoEffects,
};

pub fn selected_task_action_readiness(
    drilldown: &TaskWorkflowDrilldown,
) -> SelectedTaskActionReadiness {
    let facts = Facts::from(drilldown);
    let actions = SelectedTaskActionFamily::ORDERED
        .into_iter()
        .map(|family| action(family, drilldown, &facts))
        .collect::<Vec<_>>();
    let blockers = actions
        .iter()
        .filter(|action| action.status == SelectedTaskActionStatus::Blocked)
        .map(|action| SelectedTaskActionBlocker {
            family: action.family,
            reason: action.reason.clone(),
            evidence_refs: action.evidence_refs.clone(),
        })
        .collect::<Vec<_>>();

    SelectedTaskActionReadiness {
        readiness_id: format!("selected-task-action-readiness:{}", drilldown.task_id.0),
        project_id: drilldown.project_id.clone(),
        task_id: drilldown.task_id.clone(),
        actions,
        source_counts: SelectedTaskActionSourceCounts {
            task_records: drilldown.source_counts.task_records,
            readiness_refs: drilldown.source_counts.readiness_refs,
            work_items: drilldown.source_counts.work_items,
            active_work_items: facts.active_work_items,
            completed_work_items: facts.completed_work_items,
            runtime_evidence_refs: facts.runtime_evidence_refs.len(),
            completion_refs: drilldown.runtime.task_completion_refs.len(),
            review_refs: drilldown.review.review_refs.len(),
            scm_handoff_refs: drilldown.scm_handoff.handoff_refs.len(),
            gap_count: drilldown.gaps.len(),
        },
        blockers,
        no_effects: TaskWorkflowNoEffects::read_only(),
    }
}
