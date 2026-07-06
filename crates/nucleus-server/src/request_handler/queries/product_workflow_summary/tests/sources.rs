use nucleus_projects::ProjectId;

use super::super::*;
use super::support::handler_with_project_task;
use crate::{ProductWorkflowGapArea, ProductWorkflowNextStepSource};

#[test]
fn product_workflow_summary_query_reads_project_and_task_sources_without_effects() {
    let (_temp_dir, handler) = handler_with_project_task();

    let result = product_workflow_summary_query(
        &handler,
        ProductWorkflowSummaryQuery {
            project_id: ProjectId("project:nucleus-local".to_owned()),
        },
    )
    .expect("product workflow summary");

    let ServerQueryResult::ProductWorkflowSummary(summary) = result else {
        panic!("expected product workflow summary result");
    };

    assert_eq!(summary.project_id.0, "project:nucleus-local");
    assert_eq!(
        summary.project.display_name,
        Some("Nucleus Local".to_owned())
    );
    assert_eq!(summary.project.status, Some("active".to_owned()));
    assert_eq!(summary.source_counts.task_candidates, 1);
    assert_eq!(summary.source_counts.scm_readiness_refs, 0);
    assert_eq!(
        summary
            .task_lanes
            .iter()
            .find(|lane| lane.lane == ProductWorkflowTaskLane::Ready)
            .expect("ready lane")
            .count,
        1
    );
    assert!(summary
        .gaps
        .iter()
        .all(|gap| gap.area != ProductWorkflowGapArea::Tasks));
    assert!(summary
        .gaps
        .iter()
        .any(|gap| gap.area == ProductWorkflowGapArea::ScmReadiness));
    assert!(summary
        .gaps
        .iter()
        .all(|gap| gap.area != ProductWorkflowGapArea::Next));
    assert_eq!(summary.next.source, ProductWorkflowNextStepSource::Task);
    assert_eq!(
        summary.next.next_ref,
        Some("task:nucleus-local:bootstrap".to_owned())
    );
    assert!(!summary.no_effects.task_mutation_performed);
    assert!(!summary.no_effects.provider_execution_performed);
    assert!(!summary.no_effects.scm_or_forge_mutation_performed);
    assert!(!summary.no_effects.ui_effect_performed);
}
