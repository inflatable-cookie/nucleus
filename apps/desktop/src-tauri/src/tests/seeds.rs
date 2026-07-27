use nucleus_core::RevisionId;
use nucleus_local_store::{LocalStoreRecordPayload, RevisionExpectation, SqliteBackend};
use nucleus_server::{
    seed_local_project_with_resource_root, ControlQueryDto, ControlRequestBodyDto,
    ControlRequestEnvelopeDto, LocalControlRequestHandler, LocalProjectSeed,
    CONTROL_API_PROTOCOL_FAMILY, CONTROL_API_PROTOCOL_VERSION_V1,
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
            assert_eq!(records[0].resource_count, 1);
            assert_eq!(records[0].repository_count, 1);
            assert_eq!(records[0].resources.len(), 1);
            assert!(records[0].resources[0].locator_available);
            assert_eq!(records[0].location_status, "present");
        }
        other => panic!("expected project records, got {other:?}"),
    }

    let _ = std::fs::remove_file(database_path);
}

#[test]
fn desktop_startup_repairs_the_legacy_local_resource_authority() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-project-authority-repair-test-{}.sqlite",
        std::process::id()
    ));
    let resource_root = std::env::temp_dir().join(format!(
        "nucleus-desktop-project-authority-resource-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let _ = std::fs::remove_dir_all(&resource_root);
    std::fs::create_dir_all(&resource_root).expect("resource root");

    let backend = SqliteBackend::new(database_path.clone());
    let handler = LocalControlRequestHandler::new(backend.clone(), None);
    let mut record = seed_local_project_with_resource_root(
        handler.state(),
        LocalProjectSeed::nucleus_local(),
        Some(resource_root.clone()),
    )
    .expect("legacy project seed");
    record.revision_id = RevisionId("rev:legacy-local-authority".to_owned());
    record.payload = LocalStoreRecordPayload {
        media_type: Some("application/json".to_owned()),
        bytes: serde_json::to_vec(&serde_json::json!({
            "project_id": "project:nucleus-local",
            "display_name": "Nucleus Local",
            "status": "active",
            "importance_level": "normal",
            "repo_count": 1,
            "primary_location": resource_root.to_string_lossy(),
            "location_status": "present"
        }))
        .expect("legacy project payload"),
    };
    handler
        .state()
        .projects()
        .put(record, RevisionExpectation::Any)
        .expect("legacy project write");
    drop(handler);

    let state = DesktopState::new(backend);
    let response = state
        .submit_control_envelope(ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: "desktop-request-project-authority-repair".to_owned(),
            client_id: "desktop-client".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::State {
                    query_id: "desktop-query-project-authority-repair".to_owned(),
                    domain: nucleus_server::ControlStateDomainDto::Projects,
                    scope: nucleus_server::ControlQueryScopeDto::List,
                },
            },
        })
        .expect("desktop project list");

    assert!(matches!(
        response.body,
        nucleus_server::ControlResponseBodyDto::ProjectRecords { records }
            if records.len() == 1
                && records[0].resources.len() == 1
                && records[0].authority_host_ref == "host:embedded-desktop"
                && records[0].resources[0].authority_host_ref == "host:embedded-desktop"
    ));

    let _ = std::fs::remove_file(database_path);
    let _ = std::fs::remove_dir_all(resource_root);
}

#[test]
fn desktop_state_binds_seeded_project_to_explicit_proof_fixture() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-proof-fixture-test-{}.sqlite",
        std::process::id()
    ));
    let fixture_root = std::env::temp_dir().join(format!(
        "nucleus-desktop-proof-fixture-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let _ = std::fs::remove_dir_all(&fixture_root);
    std::fs::create_dir_all(&fixture_root).expect("fixture root");
    let state = DesktopState::new_with_proof_fixture(
        SqliteBackend::new(database_path.clone()),
        fixture_root.clone(),
    );

    let response = state
        .submit_control_envelope(ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: "desktop-request-proof-fixture".to_owned(),
            client_id: "desktop-client".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::State {
                    query_id: "desktop-query-proof-fixture".to_owned(),
                    domain: nucleus_server::ControlStateDomainDto::Projects,
                    scope: nucleus_server::ControlQueryScopeDto::List,
                },
            },
        })
        .expect("desktop project list");

    match response.body {
        nucleus_server::ControlResponseBodyDto::ProjectRecords { records } => {
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].resource_count, 1);
            assert!(records[0].resources[0].locator_available);
        }
        other => panic!("expected project records, got {other:?}"),
    }

    std::fs::write(fixture_root.join("FIXTURE.md"), "proof fixture\n").expect("fixture file");
    let files = nucleus_server::list_editor_files(
        &state.server_state,
        "project:nucleus-local",
        Some("resource:nucleus-local"),
    )
    .expect("fixture files");
    assert!(files.iter().any(|file| file.display_path == "FIXTURE.md"));

    let _ = std::fs::remove_file(database_path);
    let _ = std::fs::remove_dir_all(fixture_root);
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
    let accepted_memory = state
        .submit_control_envelope(query_request(ControlQueryDto::AcceptedMemory {
            query_id: "desktop-query-accepted-memory".to_owned(),
            action: "memory".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
        }))
        .expect("desktop accepted memory should route through the server adapter");
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
        accepted_memory.body,
        nucleus_server::ControlResponseBodyDto::AcceptedMemory {
            ref memories,
            client_can_mutate: false,
            ..
        } if memories.is_empty()
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

    for response in [planning, memory, accepted_memory, research] {
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
