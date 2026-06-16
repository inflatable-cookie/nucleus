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
