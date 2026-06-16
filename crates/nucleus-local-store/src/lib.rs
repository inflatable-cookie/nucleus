//! Server-local durable state boundary.
//!
//! This crate owns backend-adapter-shaped local persistence. SQLite is the
//! first concrete backend; backend transactions, projection import/export,
//! secret lookup, artifact payload storage, live runtime behavior, replay APIs,
//! subscriptions, and team-server database behavior remain out of scope.

pub mod backend;
pub mod domains;
pub mod errors;
pub mod fixtures;
pub mod repositories;
pub mod revisions;
pub mod sqlite;
pub mod transactions;

pub use backend::{
    LocalStoreBackendDescriptor, LocalStoreBackendFamily, LocalStoreBackendPlan,
    LocalStoreDeploymentRole,
};
pub use domains::{LocalStoreDomainBoundary, LocalStoreDomainSet};
pub use errors::{LocalStoreError, LocalStoreResult};
pub use fixtures::{fixture_record, InMemoryFixtureBoundary, InMemoryRepositoryFixture};
pub use repositories::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreRecordPayload, LocalStoreRepository,
    LocalStoreRepositoryBoundary, LocalStoreRepositoryDescriptor, RepositoryBoundary,
};
pub use revisions::{RevisionCheck, RevisionConflict, RevisionExpectation};
pub use sqlite::{SqliteBackend, SqliteRepository, SqliteStoreBoundary};
pub use transactions::{
    LocalStoreTransactionBoundary, LocalStoreTransactionMode, LocalStoreTransactionPosture,
};
