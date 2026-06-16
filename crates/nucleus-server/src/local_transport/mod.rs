//! Local control transport trait boundary.
//!
//! This module names the request/response transport boundary for local
//! clients. It does not implement a socket, HTTP server, WebSocket server,
//! Tauri IPC command, remote pairing flow, or live subscription channel.

mod handler_fixture;
mod scripted_fixture;
mod types;

pub use handler_fixture::InProcessControlHandlerFixture;
pub use scripted_fixture::InProcessControlClientFixture;
pub use types::{
    LocalControlTransport, LocalControlTransportBoundary, LocalControlTransportError,
    LocalControlTransportExchange,
};

#[cfg(test)]
mod tests;
