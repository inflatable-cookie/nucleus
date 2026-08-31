//! SQLite repository for one first-slice domain.
//!
//! Split from the sqlite god file; behavior unchanged.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use nucleus_core::{PersistenceDomain, PersistenceRecordId, RevisionId};
use rusqlite::{params, Connection, OptionalExtension};

use super::backend::SqliteConnectionHandle;
use super::connection::{configure_connection, poisoned_connection_error};
use super::kinds::kind_to_text;
use super::schema::initialize_schema;
use super::table::{row_to_record, sqlite_error, table_for_domain};
use crate::errors::{LocalStoreError, LocalStoreResult};
use crate::repositories::{LocalStoreRecord, LocalStoreRepository, LocalStoreRepositoryDescriptor};
use crate::revisions::{RevisionConflict, RevisionExpectation};
use crate::transactions::LocalStoreTransactionPosture;

/// SQLite repository for one first-slice domain.
///
/// This implements generic record persistence for first-slice durable domains.
/// It does not implement backend transactions, projection import/export,
/// migrations beyond the initial schema, or domain object serialization.
#[derive(Debug)]
pub struct SqliteRepository {
    pub(super) domain: PersistenceDomain,
    pub(super) table: &'static str,
    pub(super) connection: SqliteConnectionHandle,
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
            let deleted = connection
                .execute(&sql, params![id.0])
                .map_err(sqlite_error)?;
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
