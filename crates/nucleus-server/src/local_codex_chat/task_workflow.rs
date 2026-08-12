//! Task workflow portal: inspect or run one durable task or one Goal's
//! ordered task snapshot.
//!
//! Module index over the workflow surface: wire types, inspection, and the
//! run path through mandates and Goal-run admission.

mod inspect;
mod run;
mod types;
#[cfg(test)]
mod tests;

pub use types::{TaskWorkflowReceipt, TaskWorkflowReceiptStatus};
pub(super) use inspect::{dynamic_tool_spec, execute};
