//! Revision-check vocabulary for server-local storage.

use nucleus_core::{PersistenceRecordId, RevisionId};

/// Caller expectation for a write against a persisted record revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RevisionExpectation {
    Any,
    MustNotExist,
    MustExist,
    Exact(RevisionId),
}

/// Result of checking a write expectation against current storage state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RevisionCheck {
    Satisfied,
    Conflict(RevisionConflict),
}

/// Revision conflict evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevisionConflict {
    pub record_id: PersistenceRecordId,
    pub expected: RevisionExpectation,
    pub actual: Option<RevisionId>,
}
