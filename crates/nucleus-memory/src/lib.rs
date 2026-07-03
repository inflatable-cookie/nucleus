//! App-native shared memory proposal domain types.
//!
//! This crate owns proposal-side memory vocabulary. It does not implement
//! accepted-memory mutation, autonomous extraction, embeddings, semantic
//! search, provider-native memory sync, projection apply, or UI behavior.

pub mod ids;
pub mod proposals;
pub mod refs;
pub mod review;
pub mod storage_shape;

pub use ids::MemoryProposalId;
pub use proposals::{
    MemoryKind, MemoryProposal, MemoryProposalPayload, MemoryProposalStatus, MemoryProposalTitle,
    MemoryScope, MemoryTimestamps,
};
pub use refs::{MemorySourceKind, MemorySourceRef};
pub use review::{
    MemoryConfidence, MemoryRetentionPosture, MemoryReviewState, MemoryReviewStatus,
    MemorySensitivity, MemorySupersessionRefs,
};
pub use storage_shape::{
    decode_memory_proposal_storage_record, encode_memory_proposal_storage_payload,
    MemoryConfidenceStorage, MemoryLinkStorageRefs, MemoryProposalRecordCodecError,
    MemoryProposalStorageKind, MemoryProposalStorageRecord, MemoryProposalStorageScope,
    MemoryProposalStorageStatus, MemoryRetentionStoragePosture, MemoryReviewStorageState,
    MemoryReviewStorageStatus, MemorySensitivityStorage, MemorySourceStorageKind,
    MemorySourceStorageRef, MemorySupersessionStorageRefs, MEMORY_STORAGE_SCHEMA_VERSION,
};
