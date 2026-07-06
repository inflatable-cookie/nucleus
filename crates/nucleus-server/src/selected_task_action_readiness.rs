//! Read-only selected-task action readiness.

mod actions;
mod builder;
mod support;
#[cfg(test)]
mod tests;
mod types;

pub use builder::selected_task_action_readiness;
pub use types::*;
