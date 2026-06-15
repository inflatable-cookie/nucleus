//! State revision and journal types.

use std::time::SystemTime;

use crate::persistence::{PersistenceDomain, PersistenceRecordId};

/// Stable state revision id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RevisionId(pub String);

/// Snapshot marker for a persisted state domain.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StateSnapshot {
    pub revision_id: RevisionId,
    pub domain: PersistenceDomain,
    pub created_at: Option<SystemTime>,
    pub record_count: Option<u64>,
}

/// Change journal entry for future replay/recovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangeJournalEntry {
    pub revision_id: RevisionId,
    pub domain: PersistenceDomain,
    pub record_id: PersistenceRecordId,
    pub operation: ChangeOperation,
    pub recorded_at: Option<SystemTime>,
}

/// Persisted state change operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChangeOperation {
    Create,
    Update,
    Delete,
    Snapshot,
}
