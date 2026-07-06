use crate::cli::{CliConfig, QueryDomain};

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
fn cli_config_parses_planning_projection_import_diagnostics_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "planning-projection-import-diagnostics".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse planning projection import diagnostics query");

    assert_eq!(
        config.query,
        Some(QueryDomain::PlanningProjectionImportDiagnostics {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_planning_projection_import_apply_diagnostics_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "planning-projection-import-apply-diagnostics".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse planning projection import apply diagnostics query");

    assert_eq!(
        config.query,
        Some(QueryDomain::PlanningProjectionImportApplyDiagnostics {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_planning_projection_import_active_apply_diagnostics_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "planning-projection-import-active-apply-diagnostics".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse planning projection import active apply diagnostics query");

    assert_eq!(
        config.query,
        Some(
            QueryDomain::PlanningProjectionImportActiveApplyDiagnostics {
                project_id: "project:nucleus-local".to_owned()
            }
        )
    );
}

#[test]
fn cli_config_parses_planning_capture_publication_diagnostics_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "planning-capture-publication-diagnostics".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse planning capture publication diagnostics query");

    assert_eq!(
        config.query,
        Some(QueryDomain::PlanningCapturePublicationDiagnostics {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_product_workflow_summary_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "product-workflow-summary".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse product workflow summary query");

    assert_eq!(
        config.query,
        Some(QueryDomain::ProductWorkflowSummary {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}
