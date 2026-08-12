//! SQLite backend adapter and connection lifecycle.
//!
//! Split from the sqlite god file; behavior unchanged.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags};

use super::connection::{
    configure_connection, configure_read_only_connection, poisoned_connection_error,
};
use super::repository::SqliteRepository;
use super::schema::initialize_schema;
use super::table::{sqlite_error, table_for_domain};
use crate::backend::{
    LocalStoreBackendDescriptor, LocalStoreBackendFamily, LocalStoreDeploymentRole,
};
use crate::errors::LocalStoreResult;
use crate::repositories::{LocalStoreBackend, LocalStoreRepository};
use nucleus_core::PersistenceDomain;

/// Boundary marker for SQLite storage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqliteStoreBoundary;

/// Shared handle to one SQLite connection.
///
/// All repositories opened from one backend share a single connection, so
/// schema initialization runs once and in-process writers serialize through
/// the mutex instead of racing on separate connections.
pub(super) type SqliteConnectionHandle = Arc<Mutex<Connection>>;

/// SQLite backend adapter.
///
/// This is the single-player local backend path. Team-server backends such as
/// PostgreSQL should implement `LocalStoreBackend` separately.
#[derive(Clone, Debug)]
pub struct SqliteBackend {
    path: PathBuf,
    read_only: bool,
    shared: Arc<Mutex<Option<SqliteConnectionHandle>>>,
}

impl PartialEq for SqliteBackend {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path && self.read_only == other.read_only
    }
}

impl Eq for SqliteBackend {}

impl SqliteBackend {
    /// Create a SQLite backend adapter for a database path.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            read_only: false,
            shared: Arc::new(Mutex::new(None)),
        }
    }

    /// Open an existing SQLite store without schema or record mutation.
    pub fn new_read_only(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            read_only: true,
            shared: Arc::new(Mutex::new(None)),
        }
    }

    /// Open (once) and return the backend's shared connection handle.
    fn connection_handle(&self) -> LocalStoreResult<SqliteConnectionHandle> {
        let mut slot = self
            .shared
            .lock()
            .map_err(|_| poisoned_connection_error())?;
        if let Some(handle) = slot.as_ref() {
            return Ok(handle.clone());
        }
        let connection = if self.read_only {
            Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(sqlite_error)?
        } else {
            Connection::open(&self.path).map_err(sqlite_error)?
        };
        if self.read_only {
            configure_read_only_connection(&connection)?;
        } else {
            configure_connection(&connection)?;
            initialize_schema(&connection)?;
        }
        let handle: SqliteConnectionHandle = Arc::new(Mutex::new(connection));
        *slot = Some(handle.clone());
        Ok(handle)
    }
}

impl LocalStoreBackend for SqliteBackend {
    fn backend_descriptor(&self) -> LocalStoreBackendDescriptor {
        LocalStoreBackendDescriptor {
            family: LocalStoreBackendFamily::Sqlite,
            role: LocalStoreDeploymentRole::SinglePlayerLocal,
            supports_backend_transactions: false,
        }
    }

    fn open_repository(
        &self,
        domain: PersistenceDomain,
    ) -> LocalStoreResult<Box<dyn LocalStoreRepository>> {
        let table = table_for_domain(&domain)?;
        let connection = self.connection_handle()?;
        Ok(Box::new(SqliteRepository {
            domain,
            table,
            connection,
        }))
    }
}
