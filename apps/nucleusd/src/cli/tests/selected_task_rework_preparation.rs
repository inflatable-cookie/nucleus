use crate::cli::{CliConfig, QueryDomain};

#[test]
fn cli_config_parses_selected_task_rework_preparation_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-rework-preparation".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
        "--operator".to_owned(),
        "operator:test".to_owned(),
        "--route-admission".to_owned(),
        "selected-task-rework-delegation-route-admission:task:nucleus-local:bootstrap".to_owned(),
        "--review-decision".to_owned(),
        "selected-task-review-decision:task:nucleus-local:bootstrap".to_owned(),
        "--work-item-ref".to_owned(),
        "work:1".to_owned(),
        "--evidence-ref".to_owned(),
        "checkpoint:1".to_owned(),
        "--expected-task-revision".to_owned(),
        "rev:task:1".to_owned(),
        "--expected-work-item-revision".to_owned(),
        "rev:work:1".to_owned(),
    ])
    .expect("parse selected task rework preparation query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskReworkPreparation {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            operator_ref: "operator:test".to_owned(),
            route_admission_id: Some(
                "selected-task-rework-delegation-route-admission:task:nucleus-local:bootstrap"
                    .to_owned()
            ),
            review_decision_ref: Some(
                "selected-task-review-decision:task:nucleus-local:bootstrap".to_owned()
            ),
            reviewed_work_item_refs: vec!["work:1".to_owned()],
            reviewed_evidence_refs: vec!["checkpoint:1".to_owned()],
            expected_task_revision: Some("rev:task:1".to_owned()),
            expected_work_item_revision: Some("rev:work:1".to_owned())
        })
    );
}

#[test]
fn cli_config_parses_selected_task_rework_preparation_defaults() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-rework-preparation".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
    ])
    .expect("parse selected task rework preparation query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskReworkPreparation {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            operator_ref: "operator:nucleusd".to_owned(),
            route_admission_id: None,
            review_decision_ref: None,
            reviewed_work_item_refs: Vec::new(),
            reviewed_evidence_refs: Vec::new(),
            expected_task_revision: None,
            expected_work_item_revision: None
        })
    );
}
