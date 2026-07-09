use crate::cli::{CliConfig, QueryDomain};

#[test]
fn cli_config_parses_selected_task_product_aggregate_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-product-aggregate".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
        "--expected-revision".to_owned(),
        "rev:task:1".to_owned(),
        "--operator".to_owned(),
        "operator:test".to_owned(),
    ])
    .expect("parse selected task product aggregate query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskProductAggregate {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            expected_revision: Some("rev:task:1".to_owned()),
            operator_ref: "operator:test".to_owned()
        })
    );
}

#[test]
fn cli_config_parses_selected_task_product_aggregate_defaults() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-product-aggregate".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
    ])
    .expect("parse selected task product aggregate query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskProductAggregate {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            expected_revision: None,
            operator_ref: "operator:nucleusd".to_owned()
        })
    );
}
