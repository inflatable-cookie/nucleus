//! SQLite connection hygiene: WAL, busy timeouts, read-only enforcement,
//! and poison handling.
//!
//! Split from the sqlite god file; behavior unchanged.

use std::time::Duration;

use rusqlite::Connection;

use super::table::sqlite_error;
use crate::errors::LocalStoreResult;

/// Connection hygiene applied once per opened connection: WAL for concurrent
/// readers, a busy timeout so cross-process writers wait instead of failing
/// immediately, and durable-enough sync for a local store.
pub(super) fn configure_connection(connection: &Connection) -> LocalStoreResult<()> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(sqlite_error)?;
    // In-memory databases report journal modes other than WAL; that is fine.
    let _ = connection.pragma_update(None, "journal_mode", "WAL");
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(sqlite_error)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(sqlite_error)?;
    Ok(())
}

pub(super) fn configure_read_only_connection(connection: &Connection) -> LocalStoreResult<()> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(sqlite_error)?;
    connection
        .pragma_update(None, "query_only", "ON")
        .map_err(sqlite_error)?;
    Ok(())
}

pub(super) fn poisoned_connection_error() -> crate::errors::LocalStoreError {
    crate::errors::LocalStoreError::BackendRejected {
        reason: "SQLite connection mutex poisoned".to_owned(),
    }
}
