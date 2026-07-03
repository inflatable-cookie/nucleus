//! App-native deep research domain types.
//!
//! This crate owns research run brief vocabulary. It does not implement
//! crawling, browser automation, source retrieval, provider or model
//! execution, citation rendering, promotion, projection apply, task creation,
//! embeddings, semantic search, SCM/forge mutation, or UI behavior.

pub mod ids;
pub mod questions;
pub mod refs;
pub mod runs;
pub mod sources;
pub mod storage_shape;
pub mod synthesis;

pub use ids::{
    ResearchObservationId, ResearchQuestionId, ResearchRunBriefId, ResearchSourceId,
    ResearchSynthesisId,
};
pub use runs::{
    ResearchBrief, ResearchConfidence, ResearchCoverageSummary, ResearchRunBrief,
    ResearchRunBriefStatus, ResearchRunScopeBoundary, ResearchRunTimestamps, ResearchRunTitle,
};
