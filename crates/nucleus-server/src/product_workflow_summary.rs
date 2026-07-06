//! Read-only product workflow summary.

mod builder;
#[cfg(test)]
mod tests;
mod types;

pub use builder::product_workflow_summary;
pub use types::*;
