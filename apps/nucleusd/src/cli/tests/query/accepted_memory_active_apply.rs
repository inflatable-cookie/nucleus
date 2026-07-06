use crate::cli::{CliConfig, QueryDomain};

#[test]
fn cli_config_parses_accepted_memory_active_apply_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "accepted-memory-active-apply-diagnostics".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
    ])
    .expect("parse accepted memory active apply diagnostics query");

    assert_eq!(
        config.query,
        Some(QueryDomain::AcceptedMemoryActiveApplyDiagnostics {
            project_id: "project:nucleus-local".to_owned()
        })
    );
}
