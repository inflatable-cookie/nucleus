//! Transaction posture vocabulary for server-local storage.

/// Transaction mode requested by a storage caller.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalStoreTransactionMode {
    Autocommit,
    ReadOnly,
    ReadWrite,
}

/// Transaction posture attached to repository operations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalStoreTransactionPosture {
    Autocommit,
    Existing(LocalStoreTransactionBoundary),
    Required(LocalStoreTransactionMode),
}

/// Symbolic transaction boundary.
///
/// This does not create, commit, roll back, or bind to a backend transaction.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LocalStoreTransactionBoundary {
    pub id: String,
}
