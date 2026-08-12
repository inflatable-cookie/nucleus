//! Terminal host runtime: session registry, spawn, output buffering, and
//! host environment.
//!
//! Module index over the terminal surface: wire types, the hosted session,
//! spawning, the runtime host, and environment helpers.

mod env;
mod host;
mod session;
mod spawn;
mod types;
#[cfg(test)]
mod tests;

pub use host::TerminalHostRuntime;
pub use types::{
    TerminalEvent, TerminalEventSink, TerminalOpenRequest, TerminalSessionSnapshot,
};

const OUTPUT_BUFFER_LIMIT: usize = 1024 * 1024;
const LOCAL_HOST_ID: &str = "host:embedded-desktop";
