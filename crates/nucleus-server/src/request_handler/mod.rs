//! Transport-neutral local control request handler skeleton.
//!
//! This handler accepts control request values and returns control responses.
//! It executes read-only state queries and the first task activity-transition
//! mutations. It does not start providers, open transports, execute runtime
//! work, or deliver subscriptions yet.

mod boundary;
mod command_admission;
mod command_events;
pub mod command_projection;
mod commands;
mod event_store;
mod handler;
mod queries;
mod steward_commands;
mod task_commands;

pub use boundary::LocalControlRequestHandlerBoundary;
pub use handler::LocalControlRequestHandler;

#[cfg(test)]
mod tests;
