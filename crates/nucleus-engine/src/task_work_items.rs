//! Engine-owned task agent work item records.
//!
//! A work item is the unit Nucleus can delegate, recover, validate, and review
//! without copying provider transcripts or raw runtime streams into task state.

mod impls;
mod review;
mod runtime_projection;
mod types;

pub use review::review_timeline_entry_from_transition;
pub use types::{
    EngineTaskWorkItemAssignment, EngineTaskWorkItemId, EngineTaskWorkItemRecord,
    EngineTaskWorkItemRefs, EngineTaskWorkItemReviewCommand, EngineTaskWorkItemReviewDecision,
    EngineTaskWorkItemReviewError, EngineTaskWorkItemReviewOutcome, EngineTaskWorkItemReviewState,
    EngineTaskWorkItemReviewTimelineEntry, EngineTaskWorkItemReviewTransition,
    EngineTaskWorkItemRuntimeLinkState, EngineTaskWorkItemRuntimeProjection,
    EngineTaskWorkItemRuntimeProjectionEntry, EngineTaskWorkItemRuntimeProjectionEntryKind,
    EngineTaskWorkItemRuntimeState, EngineTaskWorkItemSet,
};

#[cfg(test)]
mod tests;
