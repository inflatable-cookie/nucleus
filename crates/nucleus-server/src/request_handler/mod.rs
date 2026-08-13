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
mod git_branch_worktree_runner_commands;
mod goal_commands;
mod handler;
mod project_commands;
mod project_resource_commands;
mod queries;
pub(crate) mod run_commands;
pub(crate) mod run_delivery;
pub(crate) mod run_review;
mod steward_commands;
mod task_commands;

pub use boundary::LocalControlRequestHandlerBoundary;
pub use handler::LocalControlRequestHandler;

#[cfg(test)]
mod tests;
