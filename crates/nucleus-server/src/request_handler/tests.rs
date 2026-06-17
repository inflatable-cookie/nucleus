use super::*;
use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
use nucleus_local_store::{fixture_record, RevisionExpectation, SqliteBackend};
use nucleus_tasks::TaskId;

use crate::client_auth::{
    ClientAuthPosture, ClientAuthReadiness, ClientAuthReadinessBlocker, ClientAuthReadinessStatus,
};
use crate::clients::{ClientIdentity, ClientKind};
use crate::commands::{
    AgentSessionCommand, ServerCommand, ServerCommandKind, TaskCommand, TaskTransitionCommand,
};
use crate::control_api::{
    AdapterSessionQuery, RuntimeMetadataQuery, ServerCommandReceipt, ServerCommandReceiptStatus,
    ServerControlError, ServerControlRequest, ServerControlRequestKind, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQuery, ServerQueryKind, ServerQueryResult,
    ServerStateRecordSet, StateRecordQuery, StateRecordQueryScope,
};
use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId, ServerQueryId};
use crate::project_seed::{seed_local_project, LocalProjectSeed};
use crate::state::ServerStateDomain;
use crate::task_seed::{seed_local_task, LocalTaskSeed};

fn handler(
    auth_readiness: Option<ClientAuthReadiness>,
) -> (tempfile::TempDir, LocalControlRequestHandler<SqliteBackend>) {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    (
        temp_dir,
        LocalControlRequestHandler::new(backend, auth_readiness),
    )
}

mod read_only_commands;

fn query_request() -> ServerControlRequest {
    ServerControlRequest {
        id: ServerControlRequestId("request:query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:projects".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Project(StateRecordQuery {
                domain: ServerStateDomain::Projects,
                scope: StateRecordQueryScope::List,
            }),
        }),
    }
}

#[test]
fn handler_executes_project_list_query() {
    let (_temp_dir, mut handler) = handler(None);
    let record = fixture_record(
        PersistenceDomain::Projects,
        PersistenceRecordKind::Project,
        "project:1",
        "rev:1",
    );
    handler
        .state()
        .projects()
        .put(record.clone(), RevisionExpectation::MustNotExist)
        .expect("seed project");

    let response = handler.handle(query_request());

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
            ServerStateRecordSet { records, .. }
        )) if records == vec![record]
    ));
}

#[test]
fn handler_executes_task_transition_command_and_reads_back_task_dto() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_task(
        handler.state(),
        LocalTaskSeed {
            task_id: "task:1".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Seed Task".to_owned(),
            action_type: nucleus_tasks::TaskActionType::Plan,
            importance: nucleus_tasks::TaskImportance::Normal,
        },
    )
    .expect("seed task");

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:command".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:start-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Start(TaskTransitionCommand {
                task_id: TaskId("task:1".to_owned()),
                expected_revision: None,
            })),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            status: ServerCommandReceiptStatus::AcceptedForStateMutation,
            ..
        })
    ));

    let query_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:task-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:tasks".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Task(StateRecordQuery {
                domain: ServerStateDomain::Tasks,
                scope: StateRecordQueryScope::List,
            }),
        }),
    });
    let dto = crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&query_response)
        .expect("task dto response");

    assert!(matches!(
        dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1 && records[0].activity == "active"
    ));
}

#[test]
fn handler_executes_task_create_command_and_reads_back_task_dto() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("seed project");

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:create-task".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:create-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Create(
                crate::commands::TaskCreateCommand {
                    project_id: nucleus_projects::ProjectId("project:nucleus-local".to_owned()),
                    title: "Create task through handler".to_owned(),
                    description: Some("Write a task record through server authority.".to_owned()),
                    acceptance_criteria: vec![nucleus_tasks::AcceptanceCriterion {
                        text: "Task appears in read-after-write DTO".to_owned(),
                        required: true,
                    }],
                    importance: nucleus_tasks::TaskImportance::High,
                    action_type: nucleus_tasks::TaskActionType::Plan,
                    activity: nucleus_tasks::TaskActivityState::Proposed,
                    agent_readiness: nucleus_tasks::AgentReadiness {
                        ready_for_agent: true,
                        required_context_refs: vec![
                            "docs/contracts/005-task-contract.md".to_owned()
                        ],
                        allowed_actions: vec![nucleus_tasks::TaskActionType::Plan],
                        stop_conditions: Vec::new(),
                        validation_commands: vec!["effigy test --plan".to_owned()],
                    },
                },
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);

    let query_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:created-task-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:created-tasks".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Task(StateRecordQuery {
                domain: ServerStateDomain::Tasks,
                scope: StateRecordQueryScope::List,
            }),
        }),
    });
    let dto = crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&query_response)
        .expect("task dto response");

    assert!(matches!(
        dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1
                && records[0].task_id == "task:command:create-task"
                && records[0].title == "Create task through handler"
                && records[0].importance == "high"
                && records[0].agent_ready
    ));
}

#[test]
fn handler_executes_task_update_command_with_revision_check() {
    let (_temp_dir, mut handler) = handler(None);
    let seeded = seed_local_task(
        handler.state(),
        LocalTaskSeed {
            task_id: "task:update".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Seed Task".to_owned(),
            action_type: nucleus_tasks::TaskActionType::Plan,
            importance: nucleus_tasks::TaskImportance::Normal,
        },
    )
    .expect("seed task");

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:update-task".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:update-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Update(
                crate::commands::TaskUpdateCommand {
                    task_id: TaskId("task:update".to_owned()),
                    expected_revision: Some(seeded.revision_id.clone()),
                    changes: crate::commands::TaskUpdateChanges {
                        title: Some("Updated Task".to_owned()),
                        importance: Some(nucleus_tasks::TaskImportance::Critical),
                        activity: Some(nucleus_tasks::TaskActivityState::Ready),
                        ..Default::default()
                    },
                },
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);

    let query_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:updated-task-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:updated-tasks".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Task(StateRecordQuery {
                domain: ServerStateDomain::Tasks,
                scope: StateRecordQueryScope::List,
            }),
        }),
    });
    let dto = crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&query_response)
        .expect("task dto response");

    assert!(matches!(
        dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1
                && records[0].title == "Updated Task"
                && records[0].importance == "critical"
                && records[0].activity == "ready"
    ));
}

#[test]
fn handler_rejects_runtime_session_start_until_scheduler_refs_exist() {
    let (_temp_dir, mut handler) = handler(None);
    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:start-session".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:start-session".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::AgentSession(AgentSessionCommand::StartSession {
                adapter_id: "adapter:codex".to_owned(),
                project_id: nucleus_projects::ProjectId("project:1".to_owned()),
            }),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            status: ServerCommandReceiptStatus::Rejected(
                ServerControlError::RuntimeUnavailable { .. }
            ),
            ..
        })
    ));
    assert!(handler.scheduler().queued_items().is_empty());
}

#[test]
fn skeleton_denies_requests_when_auth_readiness_is_denied() {
    let auth_readiness = ClientAuthReadiness {
        client: ClientIdentity {
            id: ClientId("client:mobile".to_owned()),
            kind: ClientKind::Mobile,
            display_name: "mobile".to_owned(),
        },
        observed_posture: ClientAuthPosture::UnpairedLocal,
        status: ClientAuthReadinessStatus::Denied,
        blockers: vec![ClientAuthReadinessBlocker::UnsupportedClientKind {
            kind: ClientKind::Mobile,
        }],
    };
    let (_temp_dir, mut handler) = handler(Some(auth_readiness));
    let response = handler.handle(query_request());

    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Error(ServerControlError::Unauthorized { .. })
    ));
}

#[test]
fn handler_executes_adapter_session_and_runtime_metadata_queries() {
    let (_temp_dir, mut handler) = handler(None);
    let adapter_record = fixture_record(
        PersistenceDomain::AdapterRegistry,
        PersistenceRecordKind::AdapterInstance,
        "adapter:codex",
        "rev:1",
    );
    let evidence_record = fixture_record(
        PersistenceDomain::CommandEvidence,
        PersistenceRecordKind::CommandEvidence,
        "evidence:1",
        "rev:1",
    );
    handler
        .state()
        .adapter_registry()
        .put(adapter_record.clone(), RevisionExpectation::MustNotExist)
        .expect("seed adapter");
    handler
        .state()
        .command_evidence()
        .put(evidence_record.clone(), RevisionExpectation::MustNotExist)
        .expect("seed evidence");

    let adapter_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:adapters".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:adapters".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::AdapterSession(AdapterSessionQuery::ListAdapters),
        }),
    });
    let evidence_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:evidence".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:evidence".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListCommandEvidence),
        }),
    });

    assert!(matches!(
        adapter_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::AdapterSessions(
            ServerStateRecordSet { records, .. }
        )) if records == vec![adapter_record]
    ));
    assert!(matches!(
        evidence_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::RuntimeMetadata(
            ServerStateRecordSet { records, .. }
        )) if records == vec![evidence_record]
    ));
}

#[test]
fn handler_reports_unsupported_indexed_filters_without_transport_errors() {
    let (_temp_dir, mut handler) = handler(None);
    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:project-index".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:sessions-for-project".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::AdapterSession(AdapterSessionQuery::ListSessionsForProject(
                nucleus_projects::ProjectId("project:1".to_owned()),
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Unsupported { .. })
    ));
}
