//! JSON storage codec for deep research run brief records.
//!
//! Storage records preserve sanitized research structure only. They do not
//! store raw browser caches, copyrighted source payloads, raw transcripts,
//! provider payloads, private notes, credentials, or secret-bearing files.

mod records;

#[cfg(test)]
mod tests;

pub use records::{
    decode_research_run_brief_storage_record, encode_research_run_brief_storage_payload,
    ResearchConfidenceStorage, ResearchCoverageStorageSummary, ResearchObservationStorageKind,
    ResearchObservationStorageRecord, ResearchPromotionTargetStorageRefs,
    ResearchQuestionSourceRequirementStorage, ResearchQuestionStoragePriority,
    ResearchQuestionStorageRecord, ResearchQuestionStorageStatus, ResearchRecordCodecError,
    ResearchRetrievalStorageMethodHint, ResearchRunBriefStorageRecord,
    ResearchRunBriefStorageStatus, ResearchRunScopeStorageBoundary, ResearchSourceStorageKind,
    ResearchSourceStorageRef, ResearchSourceStorageReliability, ResearchSynthesisStorageKind,
    ResearchSynthesisStorageRef, RESEARCH_STORAGE_SCHEMA_VERSION,
};
