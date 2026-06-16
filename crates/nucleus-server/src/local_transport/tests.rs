use super::*;
use crate::commands::{ServerCommand, ServerCommandKind, TaskCommand};
use crate::control_api::{
    ServerControlError, ServerControlRequest, ServerControlRequestKind, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus, ServerQuery, ServerQueryKind,
    ServerQueryResult, StateRecordQuery, StateRecordQueryScope,
};
use crate::ids::{ClientId, ServerCommandId, ServerControlRequestId, ServerQueryId};
use crate::request_handler::LocalControlRequestHandler;
use crate::state::ServerStateDomain;
use crate::transport_readiness::{
    LocalTransportCandidate, LocalTransportReadiness, LocalTransportReadinessBlocker,
    LocalTransportReadinessStatus,
};
use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
use nucleus_local_store::{fixture_record, RevisionExpectation, SqliteBackend};
use nucleus_tasks::TaskId;

struct ShapeOnlyTransport {
    ready: bool,
}

impl LocalControlTransport for ShapeOnlyTransport {
    fn candidate(&self) -> LocalTransportCandidate {
        LocalTransportCandidate::InProcess
    }

    fn readiness(&self) -> LocalTransportReadiness {
        if self.ready {
            LocalTransportReadiness {
                candidate: self.candidate(),
                status: LocalTransportReadinessStatus::Ready,
                blockers: Vec::new(),
            }
        } else {
            LocalTransportReadiness {
                candidate: self.candidate(),
                status: LocalTransportReadinessStatus::Blocked,
                blockers: vec![LocalTransportReadinessBlocker::RequestHandlerMissing],
            }
        }
    }

    fn exchange(
        &mut self,
        request: ServerControlRequest,
    ) -> Result<LocalControlTransportExchange, LocalControlTransportError> {
        if !self.ready {
            return Err(LocalControlTransportError::Unavailable {
                reason: "shape-only handler missing".to_owned(),
            });
        }

        let response = ServerControlResponse {
            request_id: request.id.clone(),
            status: ServerControlResponseStatus::Rejected,
            body: ServerControlResponseBody::Error(ServerControlError::Deferred {
                reason: "shape-only transport has no handler".to_owned(),
            }),
        };
        Ok(LocalControlTransportExchange { request, response })
    }
}

fn request() -> ServerControlRequest {
    ServerControlRequest {
        id: ServerControlRequestId("request:shape".to_owned()),
        client_id: ClientId("client:shape".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:shape".to_owned()),
            client_id: ClientId("client:shape".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(
                crate::control_api::RuntimeMetadataQuery::ListArtifactMetadata,
            ),
        }),
    }
}

#[test]
fn local_transport_trait_can_report_readiness() {
    let ready = ShapeOnlyTransport { ready: true };
    let blocked = ShapeOnlyTransport { ready: false };

    assert_eq!(
        ready.readiness().status,
        LocalTransportReadinessStatus::Ready
    );
    assert_eq!(
        blocked.readiness().status,
        LocalTransportReadinessStatus::Blocked
    );
}

#[test]
fn local_transport_trait_can_carry_request_response_exchange() {
    let mut transport = ShapeOnlyTransport { ready: true };
    let exchange = transport.exchange(request()).expect("exchange");

    assert_eq!(exchange.request.id, exchange.response.request_id);
    assert!(matches!(
        exchange.response.body,
        ServerControlResponseBody::Error(ServerControlError::Deferred { .. })
    ));
}

#[test]
fn in_process_fixture_carries_scripted_request_response_exchanges() {
    let request = request();
    let response = ServerControlResponse {
        request_id: request.id.clone(),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::Empty),
    };
    let mut fixture = InProcessControlClientFixture::ready(vec![response.clone()]);

    let exchange = fixture.exchange(request.clone()).expect("fixture exchange");

    assert_eq!(exchange.request, request);
    assert_eq!(exchange.response, response);
    assert_eq!(fixture.exchanges(), &[exchange]);
}

#[test]
fn in_process_fixture_reports_blocked_without_handler() {
    let mut fixture = InProcessControlClientFixture::blocked();

    assert_eq!(
        fixture.readiness().status,
        LocalTransportReadinessStatus::Blocked
    );
    assert!(matches!(
        fixture.exchange(request()),
        Err(LocalControlTransportError::Unavailable { .. })
    ));
}

#[test]
fn handler_backed_fixture_routes_state_query_through_handler() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let handler = LocalControlRequestHandler::new(backend, None);
    let record = fixture_record(
        PersistenceDomain::Projects,
        PersistenceRecordKind::Project,
        "project:transport",
        "rev:1",
    );
    handler
        .state()
        .projects()
        .put(record.clone(), RevisionExpectation::MustNotExist)
        .expect("seed project");
    let mut fixture = InProcessControlHandlerFixture::new(handler);

    let exchange = fixture.exchange(project_list_request()).expect("exchange");

    assert_eq!(
        exchange.response.status,
        ServerControlResponseStatus::Complete
    );
    assert!(matches!(
        exchange.response.body,
        ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
            crate::control_api::ServerStateRecordSet { records, .. }
        )) if records == vec![record]
    ));
    assert_eq!(fixture.exchanges().len(), 1);
}

#[test]
fn handler_backed_fixture_routes_command_receipt_through_handler() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let handler = LocalControlRequestHandler::new(backend, None);
    let mut fixture = InProcessControlHandlerFixture::new(handler);

    let exchange = fixture
        .exchange(ServerControlRequest {
            id: ServerControlRequestId("request:command:transport".to_owned()),
            client_id: ClientId("client:transport".to_owned()),
            kind: ServerControlRequestKind::Command(ServerCommand {
                id: ServerCommandId("command:transport".to_owned()),
                client_id: ClientId("client:transport".to_owned()),
                kind: ServerCommandKind::Task(TaskCommand::Start(TaskId(
                    "task:transport".to_owned(),
                ))),
            }),
        })
        .expect("exchange");

    assert_eq!(
        exchange.response.status,
        ServerControlResponseStatus::Accepted
    );
    assert!(matches!(
        exchange.response.body,
        ServerControlResponseBody::Command(crate::control_api::ServerCommandReceipt {
            status: crate::control_api::ServerCommandReceiptStatus::AcceptedForStateMutation,
            ..
        })
    ));
}

fn project_list_request() -> ServerControlRequest {
    ServerControlRequest {
        id: ServerControlRequestId("request:project-list:transport".to_owned()),
        client_id: ClientId("client:transport".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:project-list:transport".to_owned()),
            client_id: ClientId("client:transport".to_owned()),
            kind: ServerQueryKind::Project(StateRecordQuery {
                domain: ServerStateDomain::Projects,
                scope: StateRecordQueryScope::List,
            }),
        }),
    }
}
