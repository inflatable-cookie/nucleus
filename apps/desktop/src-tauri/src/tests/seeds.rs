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

    match response.body {
        nucleus_server::ControlResponseBodyDto::ProjectRecords { records } => {
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].display_name, "Nucleus Local");
            assert_eq!(records[0].repo_count, 1);
            assert!(records[0].primary_location.is_some());
            assert_eq!(records[0].location_status, "present");
        }
        other => panic!("expected project records, got {other:?}"),
    }

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

#[test]
fn desktop_state_routes_goal_list_to_typed_goal_records() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-goal-query-test-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

    let response = state
        .submit_control_envelope(ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: "desktop-request-goals".to_owned(),
            client_id: "desktop-client".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::State {
                    query_id: "desktop-query-goals".to_owned(),
                    domain: nucleus_server::ControlStateDomainDto::Goals,
                    scope: nucleus_server::ControlQueryScopeDto::List,
                },
            },
        })
        .expect("desktop goal list should route through the server adapter");

    assert!(matches!(
        response.body,
        nucleus_server::ControlResponseBodyDto::GoalRecords { records } if records.is_empty()
    ));

    let _ = std::fs::remove_file(database_path);
}

#[test]
fn desktop_state_seeds_planning_memory_and_research_for_proof_queries() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-planning-proof-seed-test-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

    let planning = state
        .submit_control_envelope(query_request(ControlQueryDto::PlanningSessions {
            query_id: "desktop-query-planning-sessions".to_owned(),
            action: "sessions".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
        }))
        .expect("desktop planning sessions should route through the server adapter");
    let memory = state
        .submit_control_envelope(query_request(ControlQueryDto::MemoryProposals {
            query_id: "desktop-query-memory-proposals".to_owned(),
            action: "proposals".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
        }))
        .expect("desktop memory proposals should route through the server adapter");
    let research = state
        .submit_control_envelope(query_request(ControlQueryDto::ResearchRunBriefs {
            query_id: "desktop-query-research-run-briefs".to_owned(),
            action: "runs".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
        }))
        .expect("desktop research run briefs should route through the server adapter");

    assert!(matches!(
        planning.body,
        nucleus_server::ControlResponseBodyDto::PlanningSessions {
            ref sessions,
            client_can_mutate: false,
            provider_execution_available: false,
            ..
        } if sessions.len() == 1
            && sessions[0].session_id == "planning-session:nucleus-local:bootstrap"
    ));
    assert!(matches!(
        memory.body,
        nucleus_server::ControlResponseBodyDto::MemoryProposals {
            ref proposals,
            client_can_mutate: false,
            provider_execution_available: false,
            ..
        } if proposals.len() == 1
            && proposals[0].proposal_id == "memory-proposal:nucleus-local:harness-identity"
    ));
    assert!(matches!(
        research.body,
        nucleus_server::ControlResponseBodyDto::ResearchRunBriefs {
            ref runs,
            client_can_mutate: false,
            provider_execution_available: false,
            ..
        } if runs.len() == 1
            && runs[0].run_id == "research-run:nucleus-local:harness-communications"
    ));

    for response in [planning, memory, research] {
        let json = serde_json::to_string(&response).expect("response json");
        for forbidden in [
            "raw_transcript",
            "raw_provider_payload",
            "secret",
            "credential",
            "private_note",
            "browser_cache",
            "source_body",
        ] {
            assert!(
                !json.contains(forbidden),
                "planning proof seed response should not contain {forbidden}"
            );
        }
    }

    let _ = std::fs::remove_file(database_path);
}

fn query_request(query: ControlQueryDto) -> ControlRequestEnvelopeDto {
    ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
        protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
        request_id: "desktop-request-planning-proof".to_owned(),
        client_id: "desktop-client".to_owned(),
        body: ControlRequestBodyDto::Query { query },
    }
}
