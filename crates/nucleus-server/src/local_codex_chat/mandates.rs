//! Workflow mandates: bounded execution authority cited against the current
//! operator turn and frozen scope snapshot.
//!
//! Module index over the mandate surface: wire types, creation, closure, and
//! the durable store.

mod close;
mod create;
mod store;
mod types;
#[cfg(test)]
mod tests;

pub use close::{cancel_workflow_mandate, revoke_workflow_mandate};
pub(crate) use close::expire_workflow_mandate;
pub use create::create_workflow_mandate;
pub(crate) use store::find_workflow_mandate;
pub use store::read_workflow_mandate;
pub use types::{
    WorkflowMandate, WorkflowMandateAdmission, WorkflowMandateScope, WorkflowMandateStatus,
};
