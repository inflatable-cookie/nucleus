//! Task ledger portal: inspect, create, or refine durable Nucleus tasks and
//! goals through one project-ledger portal.
//!
//! Module index over the ledger surface: the tool schema and the action
//! dispatch.

mod dispatch;
mod schema;
#[cfg(test)]
mod tests;

pub(super) use dispatch::execute;
pub(super) use schema::dynamic_tool_spec;
