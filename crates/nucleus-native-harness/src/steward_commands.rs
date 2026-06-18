//! Native steward command records.
//!
//! These records describe requested and completed steward commands. They do
//! not execute tools, mutate project state, commit, push, publish, or call a
//! forge.

mod admission;
mod outcomes;
mod records;
mod requests;
mod safety;

pub use admission::{NativeStewardCommandAdmission, NativeStewardCommandAdmissionStatus};
pub use outcomes::{NativeStewardCommandOutcome, NativeStewardCommandReceiptLink};
pub use records::{
    NativeStewardCommandId, NativeStewardCommandKind, NativeStewardCommandScope,
    NativeStewardCommandStatus, NativeStewardCommandTarget,
};
pub use requests::NativeStewardCommandRequest;

#[cfg(test)]
mod tests;
