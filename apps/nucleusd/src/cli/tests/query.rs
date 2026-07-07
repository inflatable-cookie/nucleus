use crate::cli::{CliConfig, QueryDomain};

mod accepted_memory_active_apply;
mod accepted_memory_import_apply_review;
mod accepted_memory_review_receipt_storage;
mod planning_product;
mod selected_task_command_admission;

#[test]
fn cli_config_parses_query_domain() {
    let config =
        CliConfig::parse(vec!["query".to_owned(), "tasks".to_owned()]).expect("parse query");

    assert_eq!(config.query, Some(QueryDomain::Tasks));
}

#[test]
fn cli_config_parses_command_evidence_query_domain() {
    let config = CliConfig::parse(vec!["query".to_owned(), "command-evidence".to_owned()])
        .expect("parse command evidence query");

    assert_eq!(config.query, Some(QueryDomain::CommandEvidence));
}

#[test]
fn cli_config_parses_provider_read_intent_query_domain() {
    let config = CliConfig::parse(vec!["query".to_owned(), "provider-read-intent".to_owned()])
        .expect("parse provider read-intent query");

    assert_eq!(config.query, Some(QueryDomain::ProviderReadIntent));
}

#[test]
fn cli_config_parses_provider_readiness_overview_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "provider-readiness-overview".to_owned(),
    ])
    .expect("parse provider readiness overview query");

    assert_eq!(config.query, Some(QueryDomain::ProviderReadinessOverview));
}

#[test]
fn cli_config_parses_provider_live_read_executor_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "provider-live-read-executor".to_owned(),
    ])
    .expect("parse provider live-read executor query");

    assert_eq!(config.query, Some(QueryDomain::ProviderLiveReadExecutor));
}

#[test]
fn cli_config_parses_provider_live_read_smoke_evidence_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "provider-live-read-smoke-evidence".to_owned(),
    ])
    .expect("parse provider live-read smoke evidence query");

    assert_eq!(
        config.query,
        Some(QueryDomain::ProviderLiveReadSmokeEvidence)
    );
}

#[test]
fn cli_config_parses_task_timeline_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "task-timeline".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
    ])
    .expect("parse task timeline query");

    assert_eq!(
        config.query,
        Some(QueryDomain::TaskTimeline {
            task_id: "task:nucleus-local:bootstrap".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_task_readiness_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "task-readiness".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse task readiness query");

    assert_eq!(
        config.query,
        Some(QueryDomain::TaskReadiness {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_task_workflow_drilldown_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "task-workflow-drilldown".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
    ])
    .expect("parse task workflow drilldown query");

    assert_eq!(
        config.query,
        Some(QueryDomain::TaskWorkflowDrilldown {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_selected_task_action_readiness_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-action-readiness".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
    ])
    .expect("parse selected task action readiness query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskActionReadiness {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_selected_task_operator_action_gate_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-operator-action-gate".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
    ])
    .expect("parse selected task operator action gate query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskOperatorActionGate {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_selected_task_review_next_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-review-next".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
    ])
    .expect("parse selected task review next query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskReviewNext {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_planning_task_seeds_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "planning-task-seeds".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse planning task seeds query");

    assert_eq!(
        config.query,
        Some(QueryDomain::PlanningTaskSeeds {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_planning_sessions_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "planning-sessions".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse planning sessions query");

    assert_eq!(
        config.query,
        Some(QueryDomain::PlanningSessions {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_memory_proposals_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "memory-proposals".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse memory proposals query");

    assert_eq!(
        config.query,
        Some(QueryDomain::MemoryProposals {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_accepted_memory_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "accepted-memory".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse accepted memory query");

    assert_eq!(
        config.query,
        Some(QueryDomain::AcceptedMemory {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_accepted_memory_projection_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "accepted-memory-projection".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse accepted memory projection query");

    assert_eq!(
        config.query,
        Some(QueryDomain::AcceptedMemoryProjection {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_accepted_memory_projection_writes_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "accepted-memory-projection-writes".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse accepted memory projection writes query");

    assert_eq!(
        config.query,
        Some(QueryDomain::AcceptedMemoryProjectionWrites {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_accepted_memory_projection_import_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "accepted-memory-projection-import".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse accepted memory projection import query");

    assert_eq!(
        config.query,
        Some(QueryDomain::AcceptedMemoryProjectionImport {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_accepted_memory_import_alias_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "accepted-memory-import".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse accepted memory import query alias");

    assert_eq!(
        config.query,
        Some(QueryDomain::AcceptedMemoryProjectionImport {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_accepted_memory_projection_import_apply_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "accepted-memory-projection-import-apply".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse accepted memory projection import apply query");

    assert_eq!(
        config.query,
        Some(QueryDomain::AcceptedMemoryProjectionImportApply {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_accepted_memory_import_apply_alias_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "accepted-memory-import-apply".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse accepted memory import apply query alias");

    assert_eq!(
        config.query,
        Some(QueryDomain::AcceptedMemoryProjectionImportApply {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_accepted_memory_review_readiness_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "accepted-memory-review-readiness".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse accepted memory review readiness query");

    assert_eq!(
        config.query,
        Some(QueryDomain::AcceptedMemoryReviewReadiness {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_memory_proposal_review_diagnostics_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "memory-proposal-review-diagnostics".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse memory proposal review diagnostics query");

    assert_eq!(
        config.query,
        Some(QueryDomain::MemoryProposalReviewDiagnostics {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_research_run_briefs_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "research-run-briefs".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse research run briefs query");

    assert_eq!(
        config.query,
        Some(QueryDomain::ResearchRunBriefs {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_project_authority_map_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "project-authority-map".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse project authority-map query");

    assert_eq!(
        config.query,
        Some(QueryDomain::ProjectAuthorityMap {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_rejects_unknown_query_domain() {
    let error = CliConfig::parse(vec!["query".to_owned(), "agents".to_owned()])
        .expect_err("unknown query domain");

    assert_eq!(error, "unsupported query domain: agents");
}
