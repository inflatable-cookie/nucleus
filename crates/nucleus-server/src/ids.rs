//! Server boundary identity types.

pub use nucleus_orchestration::host_identity::ClientId;

/// Stable command id supplied by a client or assigned at ingress.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ServerCommandId(pub String);

/// Stable query id supplied by a client or assigned at ingress.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ServerQueryId(pub String);

/// Stable request id for the transport-neutral control boundary.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ServerControlRequestId(pub String);

pub use nucleus_orchestration::host_identity::ServerEventId;
