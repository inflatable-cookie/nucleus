//! Local control transport trait boundary.
//!
//! This module names the request/response transport boundary for local
//! clients. It does not implement a socket, HTTP server, WebSocket server,
//! Tauri IPC command, remote pairing flow, or live subscription channel.

use crate::control_api::{ServerControlRequest, ServerControlResponse};
use crate::transport_readiness::{LocalTransportCandidate, LocalTransportReadiness};

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_api::{
        ServerControlError, ServerControlResponseBody, ServerControlResponseStatus,
    };
    use crate::ids::{ClientId, ServerControlRequestId};
    use crate::transport_readiness::{
        LocalTransportReadinessBlocker, LocalTransportReadinessStatus,
    };

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
}
