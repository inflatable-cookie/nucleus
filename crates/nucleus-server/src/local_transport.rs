//! Local control transport trait boundary.
//!
//! This module names the request/response transport boundary for local
//! clients. It does not implement a socket, HTTP server, WebSocket server,
//! Tauri IPC command, remote pairing flow, or live subscription channel.

use crate::control_api::{ServerControlRequest, ServerControlResponse};
use crate::request_handler::LocalControlRequestHandler;
use crate::transport_readiness::{
    LocalTransportCandidate, LocalTransportReadiness, LocalTransportReadinessBlocker,
    LocalTransportReadinessStatus,
};
use nucleus_local_store::LocalStoreBackend;

/// Boundary marker for local control transports.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalControlTransportBoundary;

/// Request/response exchange captured at the transport boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalControlTransportExchange {
    pub request: ServerControlRequest,
    pub response: ServerControlResponse,
}

/// Transport boundary error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalControlTransportError {
    Unavailable { reason: String },
    Rejected { reason: String },
    Unsupported { reason: String },
}

/// Local request/response transport.
///
/// Implementations may be in-process fixtures, Tauri IPC, local sockets,
/// named pipes, loopback HTTP, or another local mechanism. The trait is
/// synchronous until a concrete transport needs a runtime.
pub trait LocalControlTransport {
    fn candidate(&self) -> LocalTransportCandidate;

    fn readiness(&self) -> LocalTransportReadiness;

    fn exchange(
        &mut self,
        request: ServerControlRequest,
    ) -> Result<LocalControlTransportExchange, LocalControlTransportError>;
}

/// Non-production in-process client fixture.
///
/// This fixture carries request/response exchanges without a server handler.
/// Handler-backed routing lands in the next card.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct InProcessControlClientFixture {
    ready: bool,
    scripted_responses: Vec<ServerControlResponse>,
    exchanges: Vec<LocalControlTransportExchange>,
}

impl InProcessControlClientFixture {
    /// Create a ready in-process fixture with scripted responses.
    pub fn ready(scripted_responses: Vec<ServerControlResponse>) -> Self {
        Self {
            ready: true,
            scripted_responses,
            exchanges: Vec::new(),
        }
    }

    /// Create a blocked in-process fixture.
    pub fn blocked() -> Self {
        Self {
            ready: false,
            scripted_responses: Vec::new(),
            exchanges: Vec::new(),
        }
    }

    /// Recorded request/response exchanges.
    pub fn exchanges(&self) -> &[LocalControlTransportExchange] {
        &self.exchanges
    }
}

impl LocalControlTransport for InProcessControlClientFixture {
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
                reason: "in-process fixture is blocked".to_owned(),
            });
        }

        let Some(response) = self.scripted_responses.first().cloned() else {
            return Err(LocalControlTransportError::Unavailable {
                reason: "in-process fixture has no scripted response".to_owned(),
            });
        };
        self.scripted_responses.remove(0);

        let exchange = LocalControlTransportExchange { request, response };
        self.exchanges.push(exchange.clone());
        Ok(exchange)
    }
}

/// In-process transport fixture backed by the local request handler.
#[derive(Clone, Debug)]
pub struct InProcessControlHandlerFixture<B> {
    handler: LocalControlRequestHandler<B>,
    exchanges: Vec<LocalControlTransportExchange>,
}

impl<B> InProcessControlHandlerFixture<B>
where
    B: LocalStoreBackend + Clone,
{
    /// Create a handler-backed in-process transport fixture.
    pub fn new(handler: LocalControlRequestHandler<B>) -> Self {
        Self {
            handler,
            exchanges: Vec::new(),
        }
    }

    /// Access the backing handler.
    pub fn handler(&self) -> &LocalControlRequestHandler<B> {
        &self.handler
    }

    /// Access the backing handler mutably for fixture setup.
    pub fn handler_mut(&mut self) -> &mut LocalControlRequestHandler<B> {
        &mut self.handler
    }

    /// Recorded request/response exchanges.
    pub fn exchanges(&self) -> &[LocalControlTransportExchange] {
        &self.exchanges
    }
}

impl<B> LocalControlTransport for InProcessControlHandlerFixture<B>
where
    B: LocalStoreBackend + Clone,
{
    fn candidate(&self) -> LocalTransportCandidate {
        LocalTransportCandidate::InProcess
    }

    fn readiness(&self) -> LocalTransportReadiness {
        LocalTransportReadiness {
            candidate: self.candidate(),
            status: LocalTransportReadinessStatus::Ready,
            blockers: Vec::new(),
        }
    }

    fn exchange(
        &mut self,
        request: ServerControlRequest,
    ) -> Result<LocalControlTransportExchange, LocalControlTransportError> {
        let response = self.handler.handle(request.clone());
        let exchange = LocalControlTransportExchange { request, response };
        self.exchanges.push(exchange.clone());
        Ok(exchange)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_api::{
        ServerControlError, ServerControlResponseBody, ServerControlResponseStatus,
    };
    use crate::ids::{ClientId, ServerControlRequestId};
    use crate::request_handler::LocalControlRequestHandler;
    use crate::transport_readiness::LocalTransportReadinessStatus;
    use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
    use nucleus_local_store::{fixture_record, RevisionExpectation, SqliteBackend};

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
            kind: crate::control_api::ServerControlRequestKind::Query(
                crate::control_api::ServerQuery {
                    id: crate::ids::ServerQueryId("query:shape".to_owned()),
                    client_id: ClientId("client:shape".to_owned()),
                    kind: crate::control_api::ServerQueryKind::RuntimeMetadata(
                        crate::control_api::RuntimeMetadataQuery::ListArtifactMetadata,
                    ),
                },
            ),
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
            body: ServerControlResponseBody::Query(crate::control_api::ServerQueryResult::Empty),
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
            ServerControlResponseBody::Query(crate::control_api::ServerQueryResult::StateRecords(
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
            .exchange(crate::control_api::ServerControlRequest {
                id: ServerControlRequestId("request:command:transport".to_owned()),
                client_id: ClientId("client:transport".to_owned()),
                kind: crate::control_api::ServerControlRequestKind::Command(
                    crate::commands::ServerCommand {
                        id: crate::ids::ServerCommandId("command:transport".to_owned()),
                        client_id: ClientId("client:transport".to_owned()),
                        kind: crate::commands::ServerCommandKind::Task(
                            crate::commands::TaskCommand::Start(nucleus_tasks::TaskId(
                                "task:transport".to_owned(),
                            )),
                        ),
                    },
                ),
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
            kind: crate::control_api::ServerControlRequestKind::Query(
                crate::control_api::ServerQuery {
                    id: crate::ids::ServerQueryId("query:project-list:transport".to_owned()),
                    client_id: ClientId("client:transport".to_owned()),
                    kind: crate::control_api::ServerQueryKind::Project(
                        crate::control_api::StateRecordQuery {
                            domain: crate::state::ServerStateDomain::Projects,
                            scope: crate::control_api::StateRecordQueryScope::List,
                        },
                    ),
                },
            ),
        }
    }
}
