//! Tauri IPC command boundary skeleton.
//!
//! This module names the future desktop IPC command boundary without using
//! Tauri macros, starting a Tauri runtime, serializing payloads, or owning
//! durable server state.

use crate::control_api::{ServerControlRequest, ServerControlResponse};
use crate::request_handler::LocalControlRequestHandler;
use crate::tauri_ipc_readiness::TauriIpcCommandSchema;
use nucleus_local_store::LocalStoreBackend;

/// Marker for a Tauri IPC command boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TauriIpcCommandBoundary {
    pub schema: TauriIpcCommandSchema,
    pub posture: TauriIpcCommandBoundaryPosture,
}

impl TauriIpcCommandBoundary {
    /// Create the first schema-only desktop boundary.
    pub fn schema_only() -> Self {
        Self {
            schema: TauriIpcCommandSchema::first_desktop_schema(),
            posture: TauriIpcCommandBoundaryPosture::SchemaOnly,
        }
    }
}

/// Implementation posture for a Tauri IPC command boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TauriIpcCommandBoundaryPosture {
    SchemaOnly,
    FixtureBacked,
    TauriRuntimeBacked,
    Custom(String),
}

/// One request/response exchange through a Tauri IPC-shaped command boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TauriIpcCommandExchange {
    pub request: ServerControlRequest,
    pub response: ServerControlResponse,
}

/// Error returned by a Tauri IPC command boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TauriIpcCommandBoundaryError {
    CommandNotImplemented { reason: String },
    SerializationUnavailable { reason: String },
    ServerUnavailable { reason: String },
    Rejected { reason: String },
}

/// Narrow command boundary for future Tauri IPC.
///
/// Implementations submit server control requests and return server control
/// responses. They must not become the authority for durable project, task,
/// workspace, agent, or runtime state.
pub trait TauriIpcCommandBoundaryHandler {
    fn boundary(&self) -> &TauriIpcCommandBoundary;

    fn submit_control_request(
        &mut self,
        request: ServerControlRequest,
    ) -> Result<TauriIpcCommandExchange, TauriIpcCommandBoundaryError>;
}

/// Non-production Tauri IPC-shaped command fixture backed by the local handler.
#[derive(Clone, Debug)]
pub struct TauriIpcCommandHandlerFixture<B> {
    boundary: TauriIpcCommandBoundary,
    handler: LocalControlRequestHandler<B>,
    exchanges: Vec<TauriIpcCommandExchange>,
}

impl<B> TauriIpcCommandHandlerFixture<B>
where
    B: LocalStoreBackend + Clone,
{
    /// Create a fixture-backed command boundary.
    pub fn new(handler: LocalControlRequestHandler<B>) -> Self {
        Self {
            boundary: TauriIpcCommandBoundary {
                schema: TauriIpcCommandSchema::first_desktop_schema(),
                posture: TauriIpcCommandBoundaryPosture::FixtureBacked,
            },
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

    /// Recorded command-boundary exchanges.
    pub fn exchanges(&self) -> &[TauriIpcCommandExchange] {
        &self.exchanges
    }
}

impl<B> TauriIpcCommandBoundaryHandler for TauriIpcCommandHandlerFixture<B>
where
    B: LocalStoreBackend + Clone,
{
    fn boundary(&self) -> &TauriIpcCommandBoundary {
        &self.boundary
    }

    fn submit_control_request(
        &mut self,
        request: ServerControlRequest,
    ) -> Result<TauriIpcCommandExchange, TauriIpcCommandBoundaryError> {
        let response = self.handler.handle(request.clone());
        let exchange = TauriIpcCommandExchange { request, response };
        self.exchanges.push(exchange.clone());
        Ok(exchange)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_api::{
        RuntimeMetadataQuery, ServerControlError, ServerControlRequestKind,
        ServerControlResponseBody, ServerControlResponseStatus, ServerQuery, ServerQueryKind,
        ServerQueryResult, ServerStateRecordSet, StateRecordQuery, StateRecordQueryScope,
    };
    use crate::ids::{ClientId, ServerControlRequestId, ServerQueryId};
    use crate::request_handler::LocalControlRequestHandler;
    use crate::state::ServerStateDomain;
    use crate::tauri_ipc_readiness::TauriIpcCommandShape;
    use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
    use nucleus_local_store::{fixture_record, RevisionExpectation, SqliteBackend};

    #[derive(Clone, Debug)]
    struct ShapeOnlyBoundary {
        boundary: TauriIpcCommandBoundary,
    }

    impl TauriIpcCommandBoundaryHandler for ShapeOnlyBoundary {
        fn boundary(&self) -> &TauriIpcCommandBoundary {
            &self.boundary
        }

        fn submit_control_request(
            &mut self,
            request: ServerControlRequest,
        ) -> Result<TauriIpcCommandExchange, TauriIpcCommandBoundaryError> {
            let response = ServerControlResponse {
                request_id: request.id.clone(),
                status: ServerControlResponseStatus::Rejected,
                body: ServerControlResponseBody::Error(ServerControlError::Deferred {
                    reason: "shape-only Tauri IPC boundary has no runtime".to_owned(),
                }),
            };
            Ok(TauriIpcCommandExchange { request, response })
        }
    }

    #[test]
    fn schema_only_boundary_names_submit_command_without_tauri_runtime() {
        let boundary = TauriIpcCommandBoundary::schema_only();

        assert_eq!(boundary.posture, TauriIpcCommandBoundaryPosture::SchemaOnly);
        assert!(boundary
            .schema
            .commands
            .contains(&TauriIpcCommandShape::SubmitControlRequest));
    }

    #[test]
    fn boundary_handler_carries_server_control_request_and_response() {
        let mut handler = ShapeOnlyBoundary {
            boundary: TauriIpcCommandBoundary::schema_only(),
        };
        let request = ServerControlRequest {
            id: ServerControlRequestId("request:tauri-ipc:shape".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: ServerQueryId("query:tauri-ipc:shape".to_owned()),
                client_id: ClientId("client:desktop".to_owned()),
                kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListArtifactMetadata),
            }),
        };

        let exchange = handler
            .submit_control_request(request.clone())
            .expect("shape-only exchange");

        assert_eq!(exchange.request, request);
        assert_eq!(exchange.response.request_id, exchange.request.id);
        assert!(matches!(
            exchange.response.body,
            ServerControlResponseBody::Error(ServerControlError::Deferred { .. })
        ));
    }

    #[test]
    fn fixture_backed_boundary_routes_state_query_through_local_handler() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);
        let record = fixture_record(
            PersistenceDomain::Projects,
            PersistenceRecordKind::Project,
            "project:tauri-ipc",
            "rev:1",
        );
        handler
            .state()
            .projects()
            .put(record.clone(), RevisionExpectation::MustNotExist)
            .expect("seed project");
        let mut fixture = TauriIpcCommandHandlerFixture::new(handler);

        let exchange = fixture
            .submit_control_request(ServerControlRequest {
                id: ServerControlRequestId("request:tauri-ipc:project-list".to_owned()),
                client_id: ClientId("client:desktop".to_owned()),
                kind: ServerControlRequestKind::Query(ServerQuery {
                    id: ServerQueryId("query:tauri-ipc:project-list".to_owned()),
                    client_id: ClientId("client:desktop".to_owned()),
                    kind: ServerQueryKind::Project(StateRecordQuery {
                        domain: ServerStateDomain::Projects,
                        scope: StateRecordQueryScope::List,
                    }),
                }),
            })
            .expect("fixture exchange");

        assert_eq!(
            fixture.boundary().posture,
            TauriIpcCommandBoundaryPosture::FixtureBacked
        );
        assert_eq!(fixture.exchanges(), &[exchange.clone()]);
        assert_eq!(
            exchange.response.status,
            ServerControlResponseStatus::Complete
        );
        assert!(matches!(
            exchange.response.body,
            ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
                ServerStateRecordSet { records, .. }
            )) if records == vec![record]
        ));
    }
}
