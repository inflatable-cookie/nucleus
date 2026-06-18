//! Engine-owned task agent work item records.
//!
//! A work item is the unit Nucleus can delegate, recover, validate, and review
//! without copying provider transcripts or raw runtime streams into task state.

mod impls;
mod review;
mod runtime_projection;
mod types;

pub use types::{
    EngineTaskWorkItemAssignment, EngineTaskWorkItemId, EngineTaskWorkItemRecord,
    EngineTaskWorkItemRefs, EngineTaskWorkItemReviewDecision, EngineTaskWorkItemReviewError,
    EngineTaskWorkItemReviewOutcome, EngineTaskWorkItemReviewState,
    EngineTaskWorkItemReviewTransition, EngineTaskWorkItemRuntimeLinkState,
    EngineTaskWorkItemRuntimeProjection, EngineTaskWorkItemRuntimeProjectionEntry,
    EngineTaskWorkItemRuntimeProjectionEntryKind, EngineTaskWorkItemRuntimeState,
    EngineTaskWorkItemSet,
};

#[cfg(test)]
mod tests;
