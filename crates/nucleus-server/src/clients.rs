//! Client identity re-exports plus server-side connection records.
//!
//! Identity vocabulary relocated to nucleus-orchestration::host_identity
//! (contract 022); the connection record stays host-side.

pub use nucleus_orchestration::host_identity::{ClientIdentity, ClientKind};

use crate::deployment::AccessEndpoint;

/// Client connection record from the server's point of view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientConnection {
    pub client: ClientIdentity,
    pub endpoint: AccessEndpoint,
    pub connected: bool,
}
