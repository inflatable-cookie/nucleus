use crate::cli::{CliConfig, QueryDomain};

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
fn cli_config_parses_planning_projection_file_write_diagnostics_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "planning-projection-file-write-diagnostics".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse planning projection file-write diagnostics query");

    assert_eq!(
        config.query,
        Some(QueryDomain::PlanningProjectionFileWriteDiagnostics {
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
