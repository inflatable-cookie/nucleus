//! Selected-task command admission proof.

mod builder;
mod mapping;
#[cfg(test)]
mod tests;
mod types;

pub use builder::selected_task_command_admission;
pub use types::*;
