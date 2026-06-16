//! Server boundary identity types.

/// Stable client id assigned by the server boundary.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ClientId(pub String);

/// Stable command id supplied by a client or assigned at ingress.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ServerCommandId(pub String);

/// Stable query id supplied by a client or assigned at ingress.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ServerQueryId(pub String);

/// Stable request id for the transport-neutral control boundary.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ServerControlRequestId(pub String);

/// Stable event id emitted by the server boundary.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ServerEventId(pub String);
