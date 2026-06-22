use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    ControlQueryDto, ControlRequestBodyDto, ControlRequestEnvelopeDto, CONTROL_API_PROTOCOL_FAMILY,
    CONTROL_API_PROTOCOL_VERSION_V1,
};

use crate::DesktopState;

#[test]
fn desktop_state_invokes_serialized_control_command() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-test-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

    let response = state
        .submit_control_envelope(ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: "desktop-request-1".to_owned(),
            client_id: "desktop-client".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::RuntimeMetadata {
                    query_id: "desktop-query-1".to_owned(),
                    action: "list_artifact_metadata".to_owned(),
                },
            },
        })
        .expect("desktop command should route through the server adapter");

    assert_eq!(response.request_id, "desktop-request-1");
    assert_eq!(
        response.status,
        nucleus_server::ControlResponseStatusDto::Complete
    );

    let _ = std::fs::remove_file(database_path);
}

#[test]
fn desktop_state_seeds_local_project_for_project_queries() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-project-seed-test-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

    let response = state
        .submit_control_envelope(ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: "desktop-request-projects".to_owned(),
            client_id: "desktop-client".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::State {
                    query_id: "desktop-query-projects".to_owned(),
                    domain: nucleus_server::ControlStateDomainDto::Projects,
                    scope: nucleus_server::ControlQueryScopeDto::List,
                },
            },
        })
        .expect("desktop project list should route through the server adapter");

    assert!(matches!(
        response.body,
        nucleus_server::ControlResponseBodyDto::ProjectRecords { records }
            if records.len() == 1 && records[0].display_name == "Nucleus Local"
    ));

    let _ = std::fs::remove_file(database_path);
}

#[test]
fn desktop_state_seeds_local_task_for_task_queries() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-task-seed-test-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

    let response = state
        .submit_control_envelope(ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: "desktop-request-tasks".to_owned(),
            client_id: "desktop-client".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::State {
                    query_id: "desktop-query-tasks".to_owned(),
                    domain: nucleus_server::ControlStateDomainDto::Tasks,
                    scope: nucleus_server::ControlQueryScopeDto::List,
                },
            },
        })
        .expect("desktop task list should route through the server adapter");

    assert!(matches!(
        response.body,
        nucleus_server::ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1
                && records[0].task_id == "task:nucleus-local:bootstrap"
                && records[0].project_id == "project:nucleus-local"
    ));

    let _ = std::fs::remove_file(database_path);
}
