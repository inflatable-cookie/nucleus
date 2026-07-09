//! Product-facing selected-task workflow aggregate.

mod builder;
#[cfg(test)]
mod tests;
mod types;

pub use builder::selected_task_product_aggregate;
pub use types::*;
