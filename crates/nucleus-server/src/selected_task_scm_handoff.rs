//! Read-only selected-task SCM handoff readiness projection.

mod builder;
mod evidence;
mod next;
mod readiness;
#[cfg(test)]
mod tests;
mod types;

pub use builder::selected_task_scm_handoff_readiness;
pub use types::*;
