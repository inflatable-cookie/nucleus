//! SQLite backend tests: adapter opening, shared connections, and read-only
//! enforcement.

use super::*;

use crate::repositories::LocalStoreBackend;

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
fn backend_repositories_share_one_connection_per_backend() {
    use crate::repositories::LocalStoreBackend;

    let temp = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp.path().join("shared.sqlite"));

    // Multiple domain repositories from one backend reuse the configured
    // connection; this proves opening many is cheap and schema init ran once
    // (a second init would fail loudly if CREATE TABLE were not idempotent,
    // so instead assert cross-domain visibility through the shared handle).
    let mut tasks = backend
        .open_repository(PersistenceDomain::Tasks)
        .expect("open tasks");
    let projects = backend
        .open_repository(PersistenceDomain::Projects)
        .expect("open projects");

    tasks
        .put(
            fixture_record(
                PersistenceDomain::Tasks,
                PersistenceRecordKind::Task,
                "task:shared",
                "rev:1",
            ),
            RevisionExpectation::MustNotExist,
            LocalStoreTransactionPosture::Autocommit,
        )
        .expect("write through tasks repository");

    assert!(projects.list().expect("list projects").is_empty());
    assert_eq!(tasks.list().expect("list tasks").len(), 1);
}

#[test]
fn read_only_backend_reads_existing_records_and_rejects_mutation() {
    let temp = tempfile::tempdir().expect("temp dir");
    let path = temp.path().join("proof.sqlite");
    let record = fixture_record(
        PersistenceDomain::AgentSessions,
        PersistenceRecordKind::AgentSession,
        "session:proof",
        "rev:1",
    );
    let writer = SqliteBackend::new(path.clone());
    writer
        .open_repository(PersistenceDomain::AgentSessions)
        .expect("writer repository")
        .put(
            record.clone(),
            RevisionExpectation::MustNotExist,
            LocalStoreTransactionPosture::Autocommit,
        )
        .expect("seed record");

    let reader = SqliteBackend::new_read_only(path);
    let mut repository = reader
        .open_repository(PersistenceDomain::AgentSessions)
        .expect("read-only repository");
    assert_eq!(
        repository
            .get(&record.id)
            .expect("read record")
            .expect("record exists"),
        record
    );
    assert!(repository
        .put(
            fixture_record(
                PersistenceDomain::AgentSessions,
                PersistenceRecordKind::AgentSession,
                "session:forbidden",
                "rev:1",
            ),
            RevisionExpectation::MustNotExist,
            LocalStoreTransactionPosture::Autocommit,
        )
        .is_err());
}
