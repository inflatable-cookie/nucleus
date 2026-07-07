use crate::cli::{CliConfig, QueryDomain};

#[test]
fn cli_config_parses_selected_task_route_admission_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-route-admission".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
        "--expected-revision".to_owned(),
        "rev:nucleus-local:bootstrap".to_owned(),
        "--operator".to_owned(),
        "operator:test".to_owned(),
    ])
    .expect("parse selected task route admission query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskRouteAdmission {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            expected_revision: Some("rev:nucleus-local:bootstrap".to_owned()),
            operator_ref: "operator:test".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_selected_task_route_admission_default_operator() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-route-admission".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
    ])
    .expect("parse selected task route admission query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskRouteAdmission {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            expected_revision: None,
            operator_ref: "operator:nucleusd".to_owned()
        })
    );
}
