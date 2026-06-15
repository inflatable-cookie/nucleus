//! Server boundary and control-plane API composition types.
//!
//! This crate names the server authority surface only. It does not implement
//! networking, storage, authentication, process control, or runtime routing yet.

pub mod authority;
pub mod clients;
pub mod commands;
pub mod deployment;
pub mod events;
pub mod ids;

pub use authority::{AuthorityArea, ServerAuthority};
pub use clients::{ClientConnection, ClientIdentity, ClientKind};
pub use commands::{
    AgentSessionCommand, ProjectCommand, ServerCommand, TaskCommand, WorkspaceCommand,
};
pub use deployment::{AccessEndpoint, DeploymentMode, ServerRuntime};
pub use events::{ServerEvent, ServerEventKind};
pub use ids::{ClientId, ServerCommandId, ServerEventId};
