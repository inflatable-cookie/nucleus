//! SQLite backend for first server-local storage domains.

use std::path::{Path, PathBuf};

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
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

/// SQLite backend adapter.
///
/// This is the single-player local backend path. Team-server backends such as
/// PostgreSQL should implement `LocalStoreBackend` separately.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqliteBackend {
    path: PathBuf,
}

impl SqliteBackend {
    /// Create a SQLite backend adapter for a database path.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
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
        SqliteRepository::open(&self.path, domain)
            .map(|repository| Box::new(repository) as Box<dyn LocalStoreRepository>)
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
    connection: Connection,
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
        initialize_schema(&connection)?;
        Ok(Self {
            domain,
            table,
            connection,
        })
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

    fn current_revision(&self, id: &PersistenceRecordId) -> LocalStoreResult<Option<RevisionId>> {
        let sql = format!("SELECT revision_id FROM {} WHERE id = ?1", self.table);
        self.connection
            .query_row(&sql, params![id.0], |row| {
                let revision: String = row.get(0)?;
                Ok(RevisionId(revision))
            })
            .optional()
            .map_err(sqlite_error)
    }

    fn check_revision(
        &self,
        id: &PersistenceRecordId,
        expectation: RevisionExpectation,
    ) -> LocalStoreResult<()> {
        let actual = self.current_revision(id)?;
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
}

impl LocalStoreRepository for SqliteRepository {
    fn descriptor(&self) -> LocalStoreRepositoryDescriptor {
        LocalStoreRepositoryDescriptor {
            domain: self.domain.clone(),
            supports_transactions: false,
        }
    }

    fn get(&self, id: &PersistenceRecordId) -> LocalStoreResult<Option<LocalStoreRecord>> {
        let sql = format!(
            "SELECT id, kind, revision_id, media_type, payload FROM {} WHERE id = ?1",
            self.table
        );
        self.connection
            .query_row(&sql, params![id.0], |row| row_to_record(row, &self.domain))
            .optional()
            .map_err(sqlite_error)
            .and_then(|record| record.transpose())
    }

    fn list(&self) -> LocalStoreResult<Vec<LocalStoreRecord>> {
        let sql = format!(
            "SELECT id, kind, revision_id, media_type, payload FROM {} ORDER BY id",
            self.table
        );
        let mut statement = self.connection.prepare(&sql).map_err(sqlite_error)?;
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
        self.check_revision(&record.id, revision)?;
        let kind = kind_to_text(&record.kind).expect("kind already checked before SQLite write");
        let sql = format!(
            "INSERT INTO {} (id, kind, revision_id, media_type, payload)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               revision_id = excluded.revision_id,
               media_type = excluded.media_type,
               payload = excluded.payload",
            self.table
        );
        self.connection
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
        Ok(record)
    }

    fn delete(
        &mut self,
        id: &PersistenceRecordId,
        revision: RevisionExpectation,
        transaction: LocalStoreTransactionPosture,
    ) -> LocalStoreResult<()> {
        Self::check_transaction(transaction)?;
        self.check_revision(id, revision)?;
        let sql = format!("DELETE FROM {} WHERE id = ?1", self.table);
        let deleted = self
            .connection
            .execute(&sql, params![id.0])
            .map_err(sqlite_error)?;
        if deleted == 0 {
            Err(LocalStoreError::RecordNotFound {
                record_id: id.clone(),
            })
        } else {
            Ok(())
        }
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
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workspace_layouts (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS adapter_instances (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_sessions (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS model_routes (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS event_journal (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS command_evidence (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS artifact_metadata (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runtime_effects (
                id TEXT PRIMARY KEY NOT NULL,
                kind TEXT NOT NULL,
                revision_id TEXT NOT NULL,
                media_type TEXT,
                payload BLOB NOT NULL
            );
            ",
        )
        .map_err(sqlite_error)
}

fn table_for_domain(domain: &PersistenceDomain) -> LocalStoreResult<&'static str> {
    match domain {
        PersistenceDomain::Projects => Ok("projects"),
        PersistenceDomain::Tasks => Ok("tasks"),
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

fn kind_to_text(kind: &PersistenceRecordKind) -> Option<&'static str> {
    match kind {
        PersistenceRecordKind::Project => Some("project"),
        PersistenceRecordKind::RepoMembership => Some("repo_membership"),
        PersistenceRecordKind::Task => Some("task"),
        PersistenceRecordKind::TaskHistoryEntry => Some("task_history_entry"),
        PersistenceRecordKind::WorkspaceLayout => Some("workspace_layout"),
        PersistenceRecordKind::AdapterInstance => Some("adapter_instance"),
        PersistenceRecordKind::AgentSession => Some("agent_session"),
        PersistenceRecordKind::ModelRoute => Some("model_route"),
        PersistenceRecordKind::Event => Some("event"),
        PersistenceRecordKind::CommandEvidence => Some("command_evidence"),
        PersistenceRecordKind::ArtifactMetadata => Some("artifact_metadata"),
        PersistenceRecordKind::RuntimeEffect => Some("runtime_effect"),
        _ => None,
    }
}

fn kind_from_text(value: &str) -> LocalStoreResult<PersistenceRecordKind> {
    match value {
        "project" => Ok(PersistenceRecordKind::Project),
        "repo_membership" => Ok(PersistenceRecordKind::RepoMembership),
        "task" => Ok(PersistenceRecordKind::Task),
        "task_history_entry" => Ok(PersistenceRecordKind::TaskHistoryEntry),
        "workspace_layout" => Ok(PersistenceRecordKind::WorkspaceLayout),
        "adapter_instance" => Ok(PersistenceRecordKind::AdapterInstance),
        "agent_session" => Ok(PersistenceRecordKind::AgentSession),
        "model_route" => Ok(PersistenceRecordKind::ModelRoute),
        "event" => Ok(PersistenceRecordKind::Event),
        "command_evidence" => Ok(PersistenceRecordKind::CommandEvidence),
        "artifact_metadata" => Ok(PersistenceRecordKind::ArtifactMetadata),
        "runtime_effect" => Ok(PersistenceRecordKind::RuntimeEffect),
        other => Err(LocalStoreError::UnsupportedRecordKind {
            reason: format!("unsupported SQLite record kind in row: {other}"),
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
    LocalStoreError::BackendRejected {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::fixture_record;
    use crate::revisions::RevisionExpectation;
    use crate::transactions::LocalStoreTransactionPosture;

    fn sqlite_supported_domains() -> Vec<(PersistenceDomain, PersistenceRecordKind, &'static str)> {
        vec![
            (
                PersistenceDomain::Projects,
                PersistenceRecordKind::Project,
                "project:1",
            ),
            (
                PersistenceDomain::Tasks,
                PersistenceRecordKind::Task,
                "task:1",
            ),
            (
                PersistenceDomain::Workspaces,
                PersistenceRecordKind::WorkspaceLayout,
                "workspace:1",
            ),
            (
                PersistenceDomain::AdapterRegistry,
                PersistenceRecordKind::AdapterInstance,
                "adapter:1",
            ),
            (
                PersistenceDomain::AgentSessions,
                PersistenceRecordKind::AgentSession,
                "session:1",
            ),
            (
                PersistenceDomain::ModelRoutes,
                PersistenceRecordKind::ModelRoute,
                "route:1",
            ),
            (
                PersistenceDomain::EventJournal,
                PersistenceRecordKind::Event,
                "event:1",
            ),
            (
                PersistenceDomain::CommandEvidence,
                PersistenceRecordKind::CommandEvidence,
                "command:evidence:1",
            ),
            (
                PersistenceDomain::ArtifactMetadata,
                PersistenceRecordKind::ArtifactMetadata,
                "artifact:metadata:1",
            ),
            (
                PersistenceDomain::RuntimeEffects,
                PersistenceRecordKind::RuntimeEffect,
                "runtime:effect:1",
            ),
        ]
    }

    fn assert_sqlite_repository_recovers_after_reopen(
        domain: PersistenceDomain,
        kind: PersistenceRecordKind,
        id: &str,
    ) {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let database_path = tempdir.path().join("nucleus.sqlite3");

        {
            let mut repository =
                SqliteRepository::open(&database_path, domain.clone()).expect("open sqlite");
            let record = fixture_record(domain.clone(), kind.clone(), id, "rev:1");
            repository
                .put(
                    record,
                    RevisionExpectation::MustNotExist,
                    LocalStoreTransactionPosture::Autocommit,
                )
                .expect("write record");
        }

        let repository = SqliteRepository::open(&database_path, domain).expect("reopen sqlite");
        let records = repository.list().expect("list after reopen");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, PersistenceRecordId(id.to_owned()));
        assert_eq!(records[0].kind, kind);
        assert_eq!(records[0].revision_id, RevisionId("rev:1".to_owned()));
    }

    #[test]
    fn sqlite_first_slice_domain_records_survive_reopen() {
        for (domain, kind, id) in sqlite_supported_domains() {
            assert_sqlite_repository_recovers_after_reopen(domain, kind, id);
        }
    }

    #[test]
    fn sqlite_single_database_recovers_all_first_domains() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let database_path = tempdir.path().join("nucleus.sqlite3");

        {
            let backend = SqliteBackend::new(database_path.clone());
            for (domain, kind, id) in sqlite_supported_domains() {
                let mut repository = backend
                    .open_repository(domain.clone())
                    .expect("open repository for write");
                let record = fixture_record(domain, kind, id, "rev:1");
                repository
                    .put(
                        record,
                        RevisionExpectation::MustNotExist,
                        LocalStoreTransactionPosture::Autocommit,
                    )
                    .expect("write record");
            }
        }

        let backend = SqliteBackend::new(database_path);
        for (domain, kind, id) in sqlite_supported_domains() {
            let repository = backend
                .open_repository(domain)
                .expect("open repository after restart");
            let records = repository.list().expect("list after restart");
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].id, PersistenceRecordId(id.to_owned()));
            assert_eq!(records[0].kind, kind);
            assert_eq!(records[0].revision_id, RevisionId("rev:1".to_owned()));
        }
    }

    #[test]
    fn sqlite_recovery_uses_refs_without_secret_or_artifact_payload_material() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let database_path = tempdir.path().join("nucleus.sqlite3");
        let backend = SqliteBackend::new(database_path.clone());

        {
            let records = [
                fixture_record(
                    PersistenceDomain::ModelRoutes,
                    PersistenceRecordKind::ModelRoute,
                    "route:credential-ref-only",
                    "rev:1",
                ),
                fixture_record(
                    PersistenceDomain::CommandEvidence,
                    PersistenceRecordKind::CommandEvidence,
                    "command:evidence-ref-only",
                    "rev:1",
                ),
                fixture_record(
                    PersistenceDomain::ArtifactMetadata,
                    PersistenceRecordKind::ArtifactMetadata,
                    "artifact:metadata-ref-only",
                    "rev:1",
                ),
                fixture_record(
                    PersistenceDomain::RuntimeEffects,
                    PersistenceRecordKind::RuntimeEffect,
                    "runtime:effect-ref-only",
                    "rev:1",
                ),
            ];

            for record in records {
                let mut repository = backend
                    .open_repository(record.domain.clone())
                    .expect("open repository");
                repository
                    .put(
                        record,
                        RevisionExpectation::MustNotExist,
                        LocalStoreTransactionPosture::Autocommit,
                    )
                    .expect("write ref-only metadata");
            }
        }

        let backend = SqliteBackend::new(database_path);
        for domain in [
            PersistenceDomain::ModelRoutes,
            PersistenceDomain::CommandEvidence,
            PersistenceDomain::ArtifactMetadata,
            PersistenceDomain::RuntimeEffects,
        ] {
            let repository = backend
                .open_repository(domain)
                .expect("open repository after restart without external material");
            assert_eq!(repository.list().expect("list ref-only metadata").len(), 1);
        }
    }

    #[test]
    fn sqlite_recovery_does_not_import_projection_files_as_active_state() {
        use std::fs;

        let tempdir = tempfile::tempdir().expect("tempdir");
        let projection_dir = tempdir.path().join("nucleus").join("tasks");
        fs::create_dir_all(&projection_dir).expect("create projection dir");
        fs::write(
            projection_dir.join("task-from-projection.toml"),
            "id = \"task-from-projection\"\n",
        )
        .expect("write projection file");

        let database_path = tempdir.path().join("nucleus.sqlite3");
        let repository =
            SqliteRepository::open(&database_path, PersistenceDomain::Tasks).expect("open sqlite");

        assert_eq!(repository.list().expect("list active tasks"), Vec::new());
    }

    #[test]
    fn sqlite_backend_adapter_opens_domain_repository() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let database_path = tempdir.path().join("nucleus.sqlite3");
        let backend = SqliteBackend::new(database_path);

        assert_eq!(
            backend.backend_descriptor().role,
            LocalStoreDeploymentRole::SinglePlayerLocal
        );

        let mut repository = backend
            .open_repository(PersistenceDomain::Projects)
            .expect("open project repository");
        let record = fixture_record(
            PersistenceDomain::Projects,
            PersistenceRecordKind::Project,
            "project:1",
            "rev:1",
        );
        repository
            .put(
                record,
                RevisionExpectation::MustNotExist,
                LocalStoreTransactionPosture::Autocommit,
            )
            .expect("write through backend-opened repository");
    }

    #[test]
    fn sqlite_repository_enforces_revision_expectations() {
        let mut repository =
            SqliteRepository::open_in_memory(PersistenceDomain::Tasks).expect("open sqlite");
        let record = fixture_record(
            PersistenceDomain::Tasks,
            PersistenceRecordKind::Task,
            "task:1",
            "rev:1",
        );
        repository
            .put(
                record.clone(),
                RevisionExpectation::MustNotExist,
                LocalStoreTransactionPosture::Autocommit,
            )
            .expect("create record");

        let stale = fixture_record(
            PersistenceDomain::Tasks,
            PersistenceRecordKind::Task,
            "task:1",
            "rev:2",
        );
        let error = repository
            .put(
                stale,
                RevisionExpectation::Exact(RevisionId("stale".to_owned())),
                LocalStoreTransactionPosture::Autocommit,
            )
            .expect_err("stale update should fail");

        assert!(matches!(error, LocalStoreError::RevisionConflict(_)));
        assert_eq!(
            repository
                .get(&record.id)
                .expect("read record")
                .expect("record exists")
                .revision_id,
            RevisionId("rev:1".to_owned())
        );
    }

    #[test]
    fn sqlite_repository_rejects_unsupported_domains() {
        let error = match SqliteRepository::open_in_memory(PersistenceDomain::SharedMemory) {
            Ok(_) => panic!("shared memory is outside this SQLite slice"),
            Err(error) => error,
        };

        assert_eq!(
            error,
            LocalStoreError::UnsupportedDomain {
                domain: PersistenceDomain::SharedMemory,
            }
        );
    }
}
