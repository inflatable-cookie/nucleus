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
            PersistenceDomain::TaskHistory,
            PersistenceRecordKind::TaskHistoryEntry,
            "task:history:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::PlanningSession,
            "planning:session:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::PlanningArtifact,
            "planning:artifact:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::TaskSeed,
            "planning:task-seed:1",
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
        let record = repository
            .get(&PersistenceRecordId(id.to_owned()))
            .expect("get after restart")
            .expect("record after restart");
        assert_eq!(record.id, PersistenceRecordId(id.to_owned()));
        assert_eq!(record.kind, kind);
        assert_eq!(record.revision_id, RevisionId("rev:1".to_owned()));
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
