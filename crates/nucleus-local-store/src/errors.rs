//! Error vocabulary for server-local storage.

use nucleus_core::{PersistenceDomain, PersistenceRecordId};

use crate::revisions::RevisionConflict;

/// Local store result type.
pub type LocalStoreResult<T> = Result<T, LocalStoreError>;

/// Server-local storage errors before any backend exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalStoreError {
    Unavailable { reason: String },
    UnsupportedDomain { domain: PersistenceDomain },
    RecordNotFound { record_id: PersistenceRecordId },
    DuplicateRecord { record_id: PersistenceRecordId },
    RevisionConflict(RevisionConflict),
    TransactionRejected { reason: String },
    BackendRejected { reason: String },
    InvalidRecord { reason: String },
    UnsupportedRecordKind { reason: String },
}
