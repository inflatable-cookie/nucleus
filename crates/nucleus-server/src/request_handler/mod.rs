//! Transport-neutral local control request handler skeleton.
//!
//! This handler accepts control request values and returns control responses.
//! It executes read-only state queries. It does not mutate state, run commands,
//! start providers, open transports, or deliver subscriptions yet.

mod boundary;
mod commands;
mod handler;
mod queries;

pub use boundary::LocalControlRequestHandlerBoundary;
pub use handler::LocalControlRequestHandler;

#[cfg(test)]
mod tests;
