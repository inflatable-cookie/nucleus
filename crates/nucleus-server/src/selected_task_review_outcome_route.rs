//! Read-only route model for selected-task review outcomes.

mod builder;
#[cfg(test)]
mod tests;
mod types;

pub use builder::selected_task_review_outcome_route;
pub use types::*;
