//! Shared nucleus primitives.
//!
//! This crate holds cross-cutting type vocabulary only. It does not implement
//! persistence, scheduling, storage engines, or runtime behavior yet.

pub mod persistence;
pub mod revisions;

pub use persistence::{
    PersistenceDomain, PersistenceRecord, PersistenceRecordId, PersistenceRecordKind,
    StorageBackendKind, StorageLocation,
};
pub use revisions::{ChangeJournalEntry, ChangeOperation, RevisionId, StateSnapshot};
