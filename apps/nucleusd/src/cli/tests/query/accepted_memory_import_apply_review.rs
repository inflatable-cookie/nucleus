use crate::cli::{CliConfig, QueryDomain};

#[test]
fn cli_config_parses_accepted_memory_import_apply_review_diagnostics_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "accepted-memory-import-apply-review-diagnostics".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse accepted memory import apply review diagnostics query");

    assert_eq!(
        config.query,
        Some(QueryDomain::AcceptedMemoryImportApplyReviewDiagnostics {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}
