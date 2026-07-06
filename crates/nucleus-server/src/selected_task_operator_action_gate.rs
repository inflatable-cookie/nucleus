//! Read-only selected-task operator action gate.

mod builder;
mod mapping;
#[cfg(test)]
mod tests;
mod types;

pub use builder::selected_task_operator_action_gate;
pub use types::*;
