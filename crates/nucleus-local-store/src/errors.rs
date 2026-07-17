//! Error vocabulary for server-local storage.

use nucleus_core::{PersistenceDomain, PersistenceRecordId};

use crate::revisions::RevisionConflict;

/// Local store result type.
pub type LocalStoreResult<T> = Result<T, LocalStoreError>;

/// Server-local storage errors.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalStoreError {
    Unavailable { reason: String },
    UnsupportedDomain { domain: PersistenceDomain },
    RecordNotFound { record_id: PersistenceRecordId },
    DuplicateRecord { record_id: PersistenceRecordId },
    RevisionConflict(RevisionConflict),
    TransactionRejected { reason: String },
    /// The backend is temporarily locked by another writer; safe to retry.
    BackendBusy { reason: String },
    BackendRejected { reason: String },
    InvalidRecord { reason: String },
    UnsupportedRecordKind { reason: String },
}

impl LocalStoreError {
    /// Returns true when retrying the same operation may succeed.
    pub fn is_retryable(&self) -> bool {
        matches!(self, LocalStoreError::BackendBusy { .. })
    }
}

impl std::fmt::Display for LocalStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable { reason } => write!(formatter, "store unavailable: {reason}"),
            Self::UnsupportedDomain { domain } => {
                write!(formatter, "unsupported domain: {domain:?}")
            }
            Self::RecordNotFound { record_id } => {
                write!(formatter, "record not found: {}", record_id.0)
            }
            Self::DuplicateRecord { record_id } => {
                write!(formatter, "duplicate record: {}", record_id.0)
            }
            Self::RevisionConflict(conflict) => write!(
                formatter,
                "revision conflict on {}: expected {:?}, actual {:?}",
                conflict.record_id.0, conflict.expected, conflict.actual
            ),
            Self::TransactionRejected { reason } => {
                write!(formatter, "transaction rejected: {reason}")
            }
            Self::BackendBusy { reason } => write!(formatter, "backend busy: {reason}"),
            Self::BackendRejected { reason } => write!(formatter, "backend rejected: {reason}"),
            Self::InvalidRecord { reason } => write!(formatter, "invalid record: {reason}"),
            Self::UnsupportedRecordKind { reason } => {
                write!(formatter, "unsupported record kind: {reason}")
            }
        }
    }
}

impl std::error::Error for LocalStoreError {}
