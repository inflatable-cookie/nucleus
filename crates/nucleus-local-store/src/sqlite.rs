//! SQLite backend for first server-local storage domains.

mod kinds;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use kinds::{kind_from_text, kind_to_text};
use nucleus_core::{PersistenceDomain, PersistenceRecordId, RevisionId};
use rusqlite::{params, Connection, OptionalExtension};

use crate::backend::{
    LocalStoreBackendDescriptor, LocalStoreBackendFamily, LocalStoreDeploymentRole,
};
use crate::errors::{LocalStoreError, LocalStoreResult};
use crate::repositories::{
    LocalStoreBackend, LocalStoreRecord, LocalStoreRecordPayload, LocalStoreRepository,
    LocalStoreRepositoryDescriptor,
};
use crate::revisions::{RevisionConflict, RevisionExpectation};
use crate::transactions::LocalStoreTransactionPosture;

/// Boundary marker for SQLite storage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqliteStoreBoundary;

/// Shared handle to one SQLite connection.
///
/// All repositories opened from one backend share a single connection, so
/// schema initialization runs once and in-process writers serialize through
/// the mutex instead of racing on separate connections.
type SqliteConnectionHandle = Arc<Mutex<Connection>>;

/// SQLite backend adapter.
///
/// This is the single-player local backend path. Team-server backends such as
/// PostgreSQL should implement `LocalStoreBackend` separately.
#[derive(Clone, Debug)]
pub struct SqliteBackend {
    path: PathBuf,
    shared: Arc<Mutex<Option<SqliteConnectionHandle>>>,
}

impl PartialEq for SqliteBackend {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path
    }
}

impl Eq for SqliteBackend {}

impl SqliteBackend {
    /// Create a SQLite backend adapter for a database path.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
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
        let connection = Connection::open(&self.path).map_err(sqlite_error)?;
        configure_connection(&connection)?;
        initialize_schema(&connection)?;
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

/// SQLite repository for one first-slice domain.
///
/// This implements generic record persistence for first-slice durable domains.
/// It does not implement backend transactions, projection import/export,
/// migrations beyond the initial schema, or domain object serialization.
pub struct SqliteRepository {
    domain: PersistenceDomain,
    table: &'static str,
    connection: SqliteConnectionHandle,
}

impl SqliteRepository {
    /// Open a SQLite repository at a filesystem path.
    pub fn open(path: impl AsRef<Path>, domain: PersistenceDomain) -> LocalStoreResult<Self> {
        let connection = Connection::open(path).map_err(sqlite_error)?;
        Self::from_connection(connection, domain)
    }

    /// Open an in-memory SQLite repository.
    pub fn open_in_memory(domain: PersistenceDomain) -> LocalStoreResult<Self> {
        let connection = Connection::open_in_memory().map_err(sqlite_error)?;
        Self::from_connection(connection, domain)
    }

    fn from_connection(
        connection: Connection,
        domain: PersistenceDomain,
    ) -> LocalStoreResult<Self> {
        let table = table_for_domain(&domain)?;
        configure_connection(&connection)?;
        initialize_schema(&connection)?;
        Ok(Self {
            domain,
            table,
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    fn lock_connection(&self) -> LocalStoreResult<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| poisoned_connection_error())
    }

    fn check_transaction(transaction: LocalStoreTransactionPosture) -> LocalStoreResult<()> {
        match transaction {
            LocalStoreTransactionPosture::Autocommit => Ok(()),
            LocalStoreTransactionPosture::Existing(_)
            | LocalStoreTransactionPosture::Required(_) => {
                Err(LocalStoreError::TransactionRejected {
                    reason: "SQLite repository supports autocommit only in this slice".to_owned(),
                })
            }
        }
    }

    fn check_domain_and_kind(&self, record: &LocalStoreRecord) -> LocalStoreResult<()> {
        if record.domain != self.domain {
            return Err(LocalStoreError::UnsupportedDomain {
                domain: record.domain.clone(),
            });
        }
        if kind_to_text(&record.kind).is_some() {
            Ok(())
        } else {
            Err(LocalStoreError::UnsupportedRecordKind {
                reason: format!("unsupported SQLite record kind: {:?}", record.kind),
            })
        }
    }

    fn current_revision(
        connection: &Connection,
        table: &str,
        id: &PersistenceRecordId,
    ) -> LocalStoreResult<Option<RevisionId>> {
        let sql = format!("SELECT revision_id FROM {table} WHERE id = ?1");
        connection
            .query_row(&sql, params![id.0], |row| {
                let revision: String = row.get(0)?;
                Ok(RevisionId(revision))
            })
            .optional()
            .map_err(sqlite_error)
    }

    fn check_revision(
        connection: &Connection,
        table: &str,
        id: &PersistenceRecordId,
        expectation: RevisionExpectation,
    ) -> LocalStoreResult<()> {
        let actual = Self::current_revision(connection, table, id)?;
        let satisfied = match (&expectation, &actual) {
            (RevisionExpectation::Any, _) => true,
            (RevisionExpectation::MustNotExist, None) => true,
            (RevisionExpectation::MustExist, Some(_)) => true,
            (RevisionExpectation::Exact(expected), Some(actual)) => expected == actual,
            _ => false,
        };

        if satisfied {
            Ok(())
        } else {
            Err(LocalStoreError::RevisionConflict(RevisionConflict {
                record_id: id.clone(),
                expected: expectation,
                actual,
            }))
        }
    }

    /// Run `operation` inside an immediate transaction so the revision check
    /// and the write commit or fail as one atomic unit, including against
    /// writers on other connections or processes.
    fn with_immediate_transaction<T>(
        connection: &Connection,
        operation: impl FnOnce(&Connection) -> LocalStoreResult<T>,
    ) -> LocalStoreResult<T> {
        connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(sqlite_error)?;
        match operation(connection) {
            Ok(value) => {
                connection.execute_batch("COMMIT").map_err(sqlite_error)?;
                Ok(value)
            }
            Err(error) => {
                let _ = connection.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
}

impl LocalStoreRepository for SqliteRepository {
    fn descriptor(&self) -> LocalStoreRepositoryDescriptor {
        LocalStoreRepositoryDescriptor {
            domain: self.domain.clone(),
            supports_transactions: false,
        }
    }

    fn get(&self, id: &PersistenceRecordId) -> LocalStoreResult<Option<LocalStoreRecord>> {
        let connection = self.lock_connection()?;
        let sql = format!(
            "SELECT id, kind, revision_id, media_type, payload FROM {} WHERE id = ?1",
            self.table
        );
        connection
            .query_row(&sql, params![id.0], |row| row_to_record(row, &self.domain))
            .optional()
            .map_err(sqlite_error)
            .and_then(|record| record.transpose())
    }

    fn list(&self) -> LocalStoreResult<Vec<LocalStoreRecord>> {
        let connection = self.lock_connection()?;
        let sql = format!(
            "SELECT id, kind, revision_id, media_type, payload FROM {} ORDER BY id",
            self.table
        );
        let mut statement = connection.prepare(&sql).map_err(sqlite_error)?;
        let rows = statement
            .query_map([], |row| row_to_record(row, &self.domain))
            .map_err(sqlite_error)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(sqlite_error)??);
        }
        Ok(records)
    }

    fn list_in_insertion_order(&self) -> LocalStoreResult<Vec<LocalStoreRecord>> {
        let connection = self.lock_connection()?;
        let sql = format!(
            "SELECT id, kind, revision_id, media_type, payload FROM {} ORDER BY seq, rowid",
            self.table
        );
        let mut statement = connection.prepare(&sql).map_err(sqlite_error)?;
        let rows = statement
            .query_map([], |row| row_to_record(row, &self.domain))
            .map_err(sqlite_error)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(sqlite_error)??);
        }
        Ok(records)
    }

    fn put(
        &mut self,
        record: LocalStoreRecord,
        revision: RevisionExpectation,
        transaction: LocalStoreTransactionPosture,
    ) -> LocalStoreResult<LocalStoreRecord> {
        Self::check_transaction(transaction)?;
        self.check_domain_and_kind(&record)?;
        let kind = kind_to_text(&record.kind).expect("kind already checked before SQLite write");
        let connection = self.lock_connection()?;
        let table = self.table;
        Self::with_immediate_transaction(&connection, |connection| {
            Self::check_revision(connection, table, &record.id, revision.clone())?;
            // seq is assigned max+1 inside this immediate transaction, so
            // insertion order is monotonic even across connections; updates
            // keep their original seq.
            let sql = format!(
                "INSERT INTO {table} (id, kind, revision_id, media_type, payload, seq)
                 VALUES (?1, ?2, ?3, ?4, ?5,
                         (SELECT COALESCE(MAX(seq), 0) + 1 FROM {table}))
                 ON CONFLICT(id) DO UPDATE SET
                   kind = excluded.kind,
                   revision_id = excluded.revision_id,
                   media_type = excluded.media_type,
                   payload = excluded.payload"
            );
            connection
                .execute(
                    &sql,
                    params![
                        record.id.0,
                        kind,
                        record.revision_id.0,
                        record.payload.media_type,
                        record.payload.bytes
                    ],
                )
                .map_err(sqlite_error)?;
            Ok(())
        })?;
        Ok(record)
    }

    fn delete(
        &mut self,
        id: &PersistenceRecordId,
        revision: RevisionExpectation,
        transaction: LocalStoreTransactionPosture,
    ) -> LocalStoreResult<()> {
        Self::check_transaction(transaction)?;
        let connection = self.lock_connection()?;
        let table = self.table;
        Self::with_immediate_transaction(&connection, |connection| {
            Self::check_revision(connection, table, id, revision)?;
            let sql = format!("DELETE FROM {table} WHERE id = ?1");
            let deleted = connection.execute(&sql, params![id.0]).map_err(sqlite_error)?;
            if deleted == 0 {
                Err(LocalStoreError::RecordNotFound {
                    record_id: id.clone(),
                })
            } else {
                Ok(())
            }
        })
    }
}

/// Connection hygiene applied once per opened connection: WAL for concurrent
/// readers, a busy timeout so cross-process writers wait instead of failing
/// immediately, and durable-enough sync for a local store.
fn configure_connection(connection: &Connection) -> LocalStoreResult<()> {
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

fn poisoned_connection_error() -> LocalStoreError {
    LocalStoreError::BackendRejected {
        reason: "SQLite connection mutex poisoned".to_owned(),
    }
}

fn initialize_schema(connection: &Connection) -> LocalStoreResult<()> {
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS task_history (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS shared_memory (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS planning (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS deep_research (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, revision_id TEXT NOT NULL, media_type TEXT, payload BLOB NOT NULL, seq INTEGER);
            CREATE TABLE IF NOT EXISTS workspace_layouts (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS adapter_instances (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS agent_sessions (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS model_routes (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS event_journal (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS command_evidence (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS artifact_metadata (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            CREATE TABLE IF NOT EXISTS runtime_effects (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL,
                seq INTEGER
            );
            ",
        )
        .map_err(sqlite_error)?;
    migrate_missing_seq_columns(connection)
}

/// Add the `seq` insertion-order column to tables created before it existed
/// and backfill from rowid so historical order is preserved once.
fn migrate_missing_seq_columns(connection: &Connection) -> LocalStoreResult<()> {
    for table in ALL_TABLES {
        let has_seq = {
            let mut statement = connection
                .prepare(&format!("PRAGMA table_info({table})"))
                .map_err(sqlite_error)?;
            let mut has_seq = false;
            let mut rows = statement.query([]).map_err(sqlite_error)?;
            while let Some(row) = rows.next().map_err(sqlite_error)? {
                let name: String = row.get(1).map_err(sqlite_error)?;
                if name == "seq" {
                    has_seq = true;
                }
            }
            has_seq
        };
        if !has_seq {
            connection
                .execute_batch(&format!("ALTER TABLE {table} ADD COLUMN seq INTEGER"))
                .map_err(sqlite_error)?;
        }
        connection
            .execute(
                &format!("UPDATE {table} SET seq = rowid WHERE seq IS NULL"),
                [],
            )
            .map_err(sqlite_error)?;
    }
    Ok(())
}

const ALL_TABLES: &[&str] = &[
    "projects",
    "tasks",
    "task_history",
    "shared_memory",
    "planning",
    "deep_research",
    "workspace_layouts",
    "adapter_instances",
    "agent_sessions",
    "model_routes",
    "event_journal",
    "command_evidence",
    "artifact_metadata",
    "runtime_effects",
];

fn table_for_domain(domain: &PersistenceDomain) -> LocalStoreResult<&'static str> {
    match domain {
        PersistenceDomain::Projects => Ok("projects"),
        PersistenceDomain::Tasks => Ok("tasks"),
        PersistenceDomain::TaskHistory => Ok("task_history"),
        PersistenceDomain::SharedMemory => Ok("shared_memory"),
        PersistenceDomain::Planning => Ok("planning"),
        PersistenceDomain::DeepResearch => Ok("deep_research"),
        PersistenceDomain::Workspaces => Ok("workspace_layouts"),
        PersistenceDomain::AdapterRegistry => Ok("adapter_instances"),
        PersistenceDomain::AgentSessions => Ok("agent_sessions"),
        PersistenceDomain::ModelRoutes => Ok("model_routes"),
        PersistenceDomain::EventJournal => Ok("event_journal"),
        PersistenceDomain::CommandEvidence => Ok("command_evidence"),
        PersistenceDomain::ArtifactMetadata => Ok("artifact_metadata"),
        PersistenceDomain::RuntimeEffects => Ok("runtime_effects"),
        other => Err(LocalStoreError::UnsupportedDomain {
            domain: other.clone(),
        }),
    }
}

fn row_to_record(
    row: &rusqlite::Row<'_>,
    domain: &PersistenceDomain,
) -> rusqlite::Result<LocalStoreResult<LocalStoreRecord>> {
    let id: String = row.get(0)?;
    let kind: String = row.get(1)?;
    let revision_id: String = row.get(2)?;
    let media_type: Option<String> = row.get(3)?;
    let bytes: Vec<u8> = row.get(4)?;
    Ok(kind_from_text(&kind).map(|kind| LocalStoreRecord {
        id: PersistenceRecordId(id),
        domain: domain.clone(),
        kind,
        revision_id: RevisionId(revision_id),
        payload: LocalStoreRecordPayload { media_type, bytes },
    }))
}

fn sqlite_error(error: rusqlite::Error) -> LocalStoreError {
    if let rusqlite::Error::SqliteFailure(failure, _) = &error {
        if matches!(
            failure.code,
            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
        ) {
            return LocalStoreError::BackendBusy {
                reason: error.to_string(),
            };
        }
    }
    LocalStoreError::BackendRejected {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests;
