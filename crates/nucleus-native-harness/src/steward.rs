//! Native steward proposal records.
//!
//! These records describe proposed task and project-organization hygiene work.
//! They do not apply task mutations, change assignment, or rewrite history.

mod proposals;
mod records;
mod safety;
mod sync_assistance;

pub use proposals::{NativeStewardProposal, NativeStewardProposalId};
pub use records::{
    NativeStewardChangeField, NativeStewardChangeSemantic, NativeStewardEvidenceRef,
    NativeStewardEvidenceSource, NativeStewardProposalKind, NativeStewardProposalReview,
    NativeStewardProposalTarget, NativeStewardProposedChange,
};
pub use sync_assistance::{
    NativeStewardManagementCapturePlan, NativeStewardManagementCapturePlanStatus,
    NativeStewardManagementCaptureScope, NativeStewardSyncAssistance,
    NativeStewardSyncAssistanceId, NativeStewardSyncAssistanceKind,
    NativeStewardSyncAssistanceLinks, NativeStewardSyncDecisionConfidence,
    NativeStewardSyncDecisionId, NativeStewardSyncDecisionKind, NativeStewardSyncDecisionRecord,
    NativeStewardSyncNextAction,
};

#[cfg(test)]
mod tests;
