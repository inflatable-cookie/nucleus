use nucleus_projects::ProjectId;

use super::super::*;
use super::support::handler_with_project_task;
use crate::planning_seed::{seed_local_planning_task_seed, LocalPlanningTaskSeed};
use crate::planning_session_seed::{seed_local_planning_session, LocalPlanningSessionSeed};
use crate::ProductWorkflowGapArea;

#[test]
fn product_workflow_summary_query_composes_planning_sessions_and_task_seeds() {
    let (_temp_dir, handler) = handler_with_project_task();
    seed_local_planning_task_seed(
        handler.state(),
        LocalPlanningTaskSeed::nucleus_local_bootstrap(),
    )
    .expect("planning task seed");
    seed_local_planning_session(
        handler.state(),
        LocalPlanningSessionSeed::nucleus_local_bootstrap(),
    )
    .expect("planning session");

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

    assert_eq!(summary.source_counts.planning_sessions, 1);
    assert_eq!(summary.source_counts.task_seeds, 1);
    assert_eq!(
        summary.planning_context.planning_session_refs,
        vec!["planning-session:nucleus-local:bootstrap".to_owned()]
    );
    assert_eq!(
        summary.planning_context.task_seed_refs,
        vec!["seed:nucleus-local:planning-bootstrap".to_owned()]
    );
    assert!(summary
        .gaps
        .iter()
        .all(|gap| gap.area != ProductWorkflowGapArea::Planning));
    assert!(!summary.no_effects.task_mutation_performed);
    assert!(!summary.no_effects.projection_write_performed);
}

#[test]
fn product_workflow_summary_query_keeps_planning_gap_when_sources_are_empty() {
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

    assert_eq!(summary.source_counts.planning_sessions, 0);
    assert_eq!(summary.source_counts.task_seeds, 0);
    assert!(summary
        .gaps
        .iter()
        .any(|gap| gap.area == ProductWorkflowGapArea::Planning));
    assert!(summary
        .gaps
        .iter()
        .any(|gap| gap.area == ProductWorkflowGapArea::Context));
    assert!(!summary.no_effects.task_mutation_performed);
    assert!(!summary.no_effects.projection_write_performed);
}
