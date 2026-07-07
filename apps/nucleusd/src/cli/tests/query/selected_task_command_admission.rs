use super::*;

#[test]
fn cli_config_parses_selected_task_command_admission_query_domain() {
    let config = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-command-admission".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
        "--family".to_owned(),
        "start_selected_task".to_owned(),
        "--expected-revision".to_owned(),
        "rev:nucleus-local:bootstrap".to_owned(),
        "--operator".to_owned(),
        "operator:test".to_owned(),
    ])
    .expect("parse selected task command admission query");

    assert_eq!(
        config.query,
        Some(QueryDomain::SelectedTaskCommandAdmission {
            project_id: "project:nucleus-local".to_owned(),
            task_id: "task:nucleus-local:bootstrap".to_owned(),
            family: "start_selected_task".to_owned(),
            expected_revision: Some("rev:nucleus-local:bootstrap".to_owned()),
            reason: None,
            operator_ref: "operator:test".to_owned()
        })
    );
}

#[test]
fn cli_config_rejects_unknown_selected_task_command_admission_family() {
    let error = CliConfig::parse(vec![
        "query".to_owned(),
        "selected-task-command-admission".to_owned(),
        "--project".to_owned(),
        "project:nucleus-local".to_owned(),
        "--task".to_owned(),
        "task:nucleus-local:bootstrap".to_owned(),
        "--family".to_owned(),
        "not_a_family".to_owned(),
    ])
    .expect_err("reject unknown selected task command admission family");

    assert!(error.contains("unsupported selected task action family: not_a_family"));
}
