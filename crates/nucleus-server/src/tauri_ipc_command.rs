//! Tauri IPC command boundary skeleton.
//!
//! This module names the future desktop IPC command boundary without using
//! Tauri macros, starting a Tauri runtime, serializing payloads, or owning
//! durable server state.

use crate::control_api::{ServerControlRequest, ServerControlResponse};
use crate::control_envelope_dto::{
    ControlApiCodecError, ControlRequestEnvelopeDto, ControlResponseEnvelopeDto,
};
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

/// Server-side adapter intended for a future Tauri command macro.
#[derive(Clone, Debug)]
pub struct TauriIpcControlCommandAdapter<B> {
    boundary: TauriIpcCommandBoundary,
    handler: LocalControlRequestHandler<B>,
}

impl<B> TauriIpcControlCommandAdapter<B>
where
    B: LocalStoreBackend + Clone,
{
    /// Create a fixture-backed adapter without a Tauri runtime.
    pub fn fixture_backed(handler: LocalControlRequestHandler<B>) -> Self {
        Self {
            boundary: TauriIpcCommandBoundary {
                schema: TauriIpcCommandSchema::first_desktop_schema(),
                posture: TauriIpcCommandBoundaryPosture::FixtureBacked,
            },
            handler,
        }
    }

    /// Access the boundary metadata.
    pub fn boundary(&self) -> &TauriIpcCommandBoundary {
        &self.boundary
    }

    /// Decode a request envelope, route through the server handler, and encode
    /// the response envelope.
    pub fn submit_control_envelope(
        &mut self,
        request: ControlRequestEnvelopeDto,
    ) -> Result<ControlResponseEnvelopeDto, ControlApiCodecError> {
        let request = ServerControlRequest::try_from(request)?;
        let response = self.handler.handle(request);
        ControlResponseEnvelopeDto::try_from(&response)
    }
}

#[cfg(test)]
mod tests;
