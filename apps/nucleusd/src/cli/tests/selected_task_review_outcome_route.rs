use crate::cli::{CliConfig, QueryDomain};

#[test]
fn cli_config_parses_selected_task_review_outcome_route_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-review-outcome-route".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
    ])
    .expect("parse selected task review outcome route query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskReviewOutcomeRoute {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned()
        })
    );
}
