use super::evidence::{evidence_summary, gaps, source_counts, target};
use super::next::next_step;
use super::readiness::readiness_summary;
use crate::{
    SelectedTaskScmHandoffNoEffects, SelectedTaskScmHandoffReadiness, TaskWorkflowDrilldown,
};

pub fn selected_task_scm_handoff_readiness(
    drilldown: &TaskWorkflowDrilldown,
) -> SelectedTaskScmHandoffReadiness {
    let evidence = evidence_summary(drilldown);
    let target = target(&evidence);
    let mut source_counts = source_counts(drilldown, &evidence);
    let gaps = gaps(drilldown, &evidence, &target);
    source_counts.gap_count = gaps.len();
    let readiness = readiness_summary(&evidence, &gaps);
    let next = next_step(&readiness, &target, &evidence, &gaps);

    SelectedTaskScmHandoffReadiness {
        handoff_id: format!("selected-task-scm-handoff:{}", drilldown.task_id.0),
        project_id: drilldown.project_id.clone(),
        task_id: drilldown.task_id.clone(),
        readiness,
        target,
        evidence,
        next,
        source_counts,
        gaps,
        no_effects: SelectedTaskScmHandoffNoEffects::read_only(),
    }
}
