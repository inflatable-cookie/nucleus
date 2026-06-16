use super::*;
use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
use nucleus_local_store::{fixture_record, RevisionExpectation, SqliteBackend};
use nucleus_tasks::TaskId;

use crate::client_auth::{
    ClientAuthPosture, ClientAuthReadiness, ClientAuthReadinessBlocker, ClientAuthReadinessStatus,
};
use crate::clients::{ClientIdentity, ClientKind};
use crate::commands::{AgentSessionCommand, ServerCommand, ServerCommandKind, TaskCommand};
use crate::control_api::{
    AdapterSessionQuery, RuntimeMetadataQuery, ServerCommandReceipt, ServerCommandReceiptStatus,
    ServerControlError, ServerControlRequest, ServerControlRequestKind, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQuery, ServerQueryKind, ServerQueryResult,
    ServerStateRecordSet, StateRecordQuery, StateRecordQueryScope,
};
use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId, ServerQueryId};
use crate::state::ServerStateDomain;

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
fn handler_accepts_state_command_receipt_without_mutation_execution() {
    let (_temp_dir, mut handler) = handler(None);
    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:command".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:start-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Start(TaskId("task:1".to_owned()))),
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
