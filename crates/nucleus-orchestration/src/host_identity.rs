//! Host and client identity vocabulary shared by runtime-effect
//! ordering, replay, and subscription records.

/// Stable client id assigned by the server boundary.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ClientId(pub String);

/// Stable event id emitted by the server boundary.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ServerEventId(pub String);

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

