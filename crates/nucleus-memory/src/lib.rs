//! App-native shared memory domain types.
//!
//! This crate owns proposal-side and accepted-memory storage vocabulary. It
//! does not implement autonomous extraction, embeddings, semantic search,
//! provider-native memory sync, projection apply, or UI behavior.

pub mod acceptance;
pub mod accepted;
pub mod accepted_storage;
pub mod ids;
pub mod proposals;
pub mod refs;
pub mod review;
pub mod review_receipt_storage;
pub mod storage_shape;

#[cfg(test)]
mod acceptance_tests;

pub use acceptance::{
    admit_memory_proposal_acceptance, MemoryProposalAcceptanceAdmission,
    MemoryProposalAcceptanceAdmissionStatus, MemoryProposalAcceptanceBlocker,
    MemoryProposalAcceptanceCommand, MemoryProposalAcceptanceNoEffects,
};
pub use accepted::{
    AcceptedMemory, AcceptedMemoryActors, AcceptedMemoryBody, AcceptedMemoryReview,
    AcceptedMemoryStatus, AcceptedMemoryTimestamps,
};
pub use accepted_storage::{
    decode_accepted_memory_storage_record, encode_accepted_memory_storage_payload,
    AcceptedMemoryRecordCodecError, AcceptedMemoryStorageActors, AcceptedMemoryStorageBody,
    AcceptedMemoryStorageRecord, AcceptedMemoryStorageReview, AcceptedMemoryStorageStatus,
    AcceptedMemorySupersessionStorageRefs, ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
};
pub use ids::{MemoryId, MemoryProposalId};
pub use proposals::{
    MemoryKind, MemoryProposal, MemoryProposalPayload, MemoryProposalStatus, MemoryProposalTitle,
    MemoryScope, MemoryTimestamps,
};
pub use refs::{MemorySourceKind, MemorySourceRef};
pub use review::{
    MemoryConfidence, MemoryRetentionPosture, MemoryReviewState, MemoryReviewStatus,
    MemorySensitivity, MemorySupersessionRefs,
};
pub use review_receipt_storage::{
    decode_accepted_memory_review_receipt_storage_record,
    encode_accepted_memory_review_receipt_storage_payload,
    AcceptedMemoryReviewReceiptAdmissionBlockerStorage,
    AcceptedMemoryReviewReceiptAdmissionStatusStorage, AcceptedMemoryReviewReceiptBlockerStorage,
    AcceptedMemoryReviewReceiptDecisionStorage, AcceptedMemoryReviewReceiptRecordCodecError,
    AcceptedMemoryReviewReceiptStatusStorage, AcceptedMemoryReviewReceiptStorageRecord,
    ACCEPTED_MEMORY_REVIEW_RECEIPT_STORAGE_SCHEMA_VERSION,
};
pub use storage_shape::{
    decode_memory_proposal_storage_record, encode_memory_proposal_storage_payload,
    MemoryConfidenceStorage, MemoryLinkStorageRefs, MemoryProposalRecordCodecError,
    MemoryProposalStorageKind, MemoryProposalStorageRecord, MemoryProposalStorageScope,
    MemoryProposalStorageStatus, MemoryRetentionStoragePosture, MemoryReviewStorageState,
    MemoryReviewStorageStatus, MemorySensitivityStorage, MemorySourceStorageKind,
    MemorySourceStorageRef, MemorySupersessionStorageRefs, MEMORY_STORAGE_SCHEMA_VERSION,
};
