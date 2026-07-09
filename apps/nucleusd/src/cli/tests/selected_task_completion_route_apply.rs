use crate::cli::{CliConfig, QueryDomain};

#[test]
fn cli_config_parses_selected_task_completion_route_apply_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-completion-route-apply".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
        "--expected-revision".to_owned(),
        "rev:nucleus-local:bootstrap".to_owned(),
        "--operator".to_owned(),
        "operator:test".to_owned(),
        "--route-admission".to_owned(),
        "selected-task-route-admission:task:nucleus-local:bootstrap".to_owned(),
        "--review-decision".to_owned(),
        "selected-task-review-decision:task:nucleus-local:bootstrap".to_owned(),
        "--evidence-ref".to_owned(),
        "checkpoint:1".to_owned(),
        "--evidence-ref".to_owned(),
        "diff:1".to_owned(),
    ])
    .expect("parse selected task completion route apply query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskCompletionRouteApply {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            expected_revision: Some("rev:nucleus-local:bootstrap".to_owned()),
            operator_ref: "operator:test".to_owned(),
            route_admission_id: Some(
                "selected-task-route-admission:task:nucleus-local:bootstrap".to_owned()
            ),
            review_decision_ref: Some(
                "selected-task-review-decision:task:nucleus-local:bootstrap".to_owned()
            ),
            evidence_refs: vec!["checkpoint:1".to_owned(), "diff:1".to_owned()]
        })
    );
}

#[test]
fn cli_config_parses_selected_task_completion_route_apply_defaults() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-completion-route-apply".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
    ])
    .expect("parse selected task completion route apply query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskCompletionRouteApply {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            expected_revision: None,
            operator_ref: "operator:nucleusd".to_owned(),
            route_admission_id: None,
            review_decision_ref: None,
            evidence_refs: Vec::new()
        })
    );
}
