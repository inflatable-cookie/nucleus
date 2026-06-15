//! Control-plane client identity types.

use crate::deployment::AccessEndpoint;
use crate::ids::ClientId;

/// Control-plane client identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientIdentity {
    pub id: ClientId,
    pub kind: ClientKind,
    pub display_name: String,
}

/// Supported client categories.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientKind {
    Desktop,
    Web,
    Mobile,
    Cli,
    Service,
    Other(String),
}

/// Client connection record from the server's point of view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientConnection {
    pub client: ClientIdentity,
    pub endpoint: AccessEndpoint,
    pub connected: bool,
}
