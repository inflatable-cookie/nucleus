use nucleus_projects::ProjectId;

use super::super::*;
use super::support::{handler_with_project_task, seed_accepted_memory};
use crate::memory_proposal_seed::{seed_local_memory_proposal, LocalMemoryProposalSeed};
use crate::research_run_brief_seed::{seed_local_research_run_brief, LocalResearchRunBriefSeed};
use crate::ProductWorkflowGapArea;

#[test]
fn product_workflow_summary_query_composes_memory_and_research_context() {
    let (_temp_dir, handler) = handler_with_project_task();
    seed_local_memory_proposal(
        handler.state(),
        LocalMemoryProposalSeed::nucleus_local_bootstrap(),
    )
    .expect("memory proposal");
    seed_accepted_memory(&handler);
    seed_local_research_run_brief(
        handler.state(),
        LocalResearchRunBriefSeed::nucleus_local_bootstrap(),
    )
    .expect("research run brief");

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

    assert_eq!(summary.source_counts.memory_proposals, 1);
    assert_eq!(summary.source_counts.accepted_memories, 1);
    assert_eq!(summary.source_counts.research_runs, 1);
    assert_eq!(
        summary.context.memory_proposal_refs,
        vec!["memory-proposal:nucleus-local:harness-identity".to_owned()]
    );
    assert_eq!(
        summary.context.accepted_memory_refs,
        vec!["memory:nucleus-local:harness-identity".to_owned()]
    );
    assert_eq!(
        summary.context.research_run_refs,
        vec!["research-run:nucleus-local:harness-communications".to_owned()]
    );
    assert!(summary
        .gaps
        .iter()
        .all(|gap| gap.area != ProductWorkflowGapArea::Context));
    assert!(!summary.no_effects.accepted_memory_apply_performed);
    assert!(!summary.no_effects.provider_execution_performed);
    assert!(!summary.no_effects.projection_write_performed);
}
