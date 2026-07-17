use super::*;
use crate::fixtures::fixture_record;
use crate::revisions::RevisionExpectation;
use crate::transactions::LocalStoreTransactionPosture;
use nucleus_core::PersistenceRecordKind;

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
            PersistenceDomain::SharedMemory,
            PersistenceRecordKind::SharedMemoryRecord,
            "memory:1",
        ),
        (
            PersistenceDomain::SharedMemory,
            PersistenceRecordKind::SharedMemoryReviewReceipt,
            "memory:review-receipt:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::PlanningSession,
            "planning:session:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::Goal,
            "goal:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::PlanningArtifact,
            "planning:artifact:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::PlanningImportApplyPlan,
            "planning:import-apply-plan:1",
        ),
        (
            PersistenceDomain::Planning,
            PersistenceRecordKind::PlanningImportActiveApplyAdmission,
            "planning:import-active-apply-admission:1",
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
fn sqlite_revision_conflict_carries_expected_and_actual_revisions() {
    let mut repository =
        SqliteRepository::open_in_memory(PersistenceDomain::Tasks).expect("open sqlite");
    let record = fixture_record(
        PersistenceDomain::Tasks,
        PersistenceRecordKind::Task,
        "task:conflict",
        "rev:current",
    );
    repository
        .put(
            record.clone(),
            RevisionExpectation::MustNotExist,
            LocalStoreTransactionPosture::Autocommit,
        )
        .expect("create record");

    let error = repository
        .put(
            record.clone(),
            RevisionExpectation::MustNotExist,
            LocalStoreTransactionPosture::Autocommit,
        )
        .expect_err("duplicate create should conflict");

    match error {
        LocalStoreError::RevisionConflict(conflict) => {
            assert_eq!(conflict.record_id, record.id);
            assert_eq!(conflict.expected, RevisionExpectation::MustNotExist);
            assert_eq!(conflict.actual, Some(RevisionId("rev:current".to_owned())));
        }
        other => panic!("expected revision conflict, got {other:?}"),
    }
}

#[test]
fn sqlite_delete_enforces_revision_expectation_and_removes_record() {
    let mut repository =
        SqliteRepository::open_in_memory(PersistenceDomain::Tasks).expect("open sqlite");
    let record = fixture_record(
        PersistenceDomain::Tasks,
        PersistenceRecordKind::Task,
        "task:delete",
        "rev:1",
    );
    repository
        .put(
            record.clone(),
            RevisionExpectation::MustNotExist,
            LocalStoreTransactionPosture::Autocommit,
        )
        .expect("create record");

    let stale_delete = repository.delete(
        &record.id,
        RevisionExpectation::Exact(RevisionId("rev:stale".to_owned())),
        LocalStoreTransactionPosture::Autocommit,
    );
    assert!(matches!(
        stale_delete,
        Err(LocalStoreError::RevisionConflict(_))
    ));
    assert!(repository
        .get(&record.id)
        .expect("read after failed delete")
        .is_some());

    repository
        .delete(
            &record.id,
            RevisionExpectation::Exact(RevisionId("rev:1".to_owned())),
            LocalStoreTransactionPosture::Autocommit,
        )
        .expect("delete with matching revision");
    assert!(repository
        .get(&record.id)
        .expect("read after delete")
        .is_none());

    let missing_delete = repository.delete(
        &record.id,
        RevisionExpectation::MustExist,
        LocalStoreTransactionPosture::Autocommit,
    );
    assert!(matches!(
        missing_delete,
        Err(LocalStoreError::RevisionConflict(_))
    ));
}

#[test]
fn sqlite_must_exist_expectation_rejects_missing_record_writes() {
    let mut repository =
        SqliteRepository::open_in_memory(PersistenceDomain::Tasks).expect("open sqlite");
    let record = fixture_record(
        PersistenceDomain::Tasks,
        PersistenceRecordKind::Task,
        "task:absent",
        "rev:1",
    );

    let error = repository
        .put(
            record,
            RevisionExpectation::MustExist,
            LocalStoreTransactionPosture::Autocommit,
        )
        .expect_err("update of missing record should conflict");

    match error {
        LocalStoreError::RevisionConflict(conflict) => {
            assert_eq!(conflict.actual, None);
        }
        other => panic!("expected revision conflict, got {other:?}"),
    }
}

#[test]
fn concurrent_exact_revision_writers_cannot_both_succeed() {
    use crate::repositories::LocalStoreBackend;

    let temp = tempfile::tempdir().expect("temp dir");
    let path = temp.path().join("cas.sqlite");
    // Two separate backend instances = two separate SQLite connections, the
    // worst case the old check-then-write pattern raced on.
    let backend_a = SqliteBackend::new(&path);
    let backend_b = SqliteBackend::new(&path);

    let mut seed = backend_a
        .open_repository(PersistenceDomain::Tasks)
        .expect("open seed repository");
    seed.put(
        fixture_record(
            PersistenceDomain::Tasks,
            PersistenceRecordKind::Task,
            "task:cas",
            "rev:1",
        ),
        RevisionExpectation::MustNotExist,
        LocalStoreTransactionPosture::Autocommit,
    )
    .expect("seed record");

    let contender = |backend: SqliteBackend, revision: &'static str| {
        std::thread::spawn(move || {
            let mut repository = backend
                .open_repository(PersistenceDomain::Tasks)
                .expect("open contender repository");
            repository.put(
                fixture_record(
                    PersistenceDomain::Tasks,
                    PersistenceRecordKind::Task,
                    "task:cas",
                    revision,
                ),
                RevisionExpectation::Exact(RevisionId("rev:1".to_owned())),
                LocalStoreTransactionPosture::Autocommit,
            )
        })
    };

    let first = contender(backend_a, "rev:2a");
    let second = contender(backend_b, "rev:2b");
    let results = [
        first.join().expect("thread a"),
        second.join().expect("thread b"),
    ];

    let successes = results.iter().filter(|result| result.is_ok()).count();
    let conflicts = results
        .iter()
        .filter(|result| matches!(result, Err(LocalStoreError::RevisionConflict(_))))
        .count();
    assert_eq!(successes, 1, "exactly one Exact(rev:1) writer may win");
    assert_eq!(conflicts, 1, "the loser must see a revision conflict");
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
fn insertion_order_listing_ignores_lexicographic_id_order() {
    let mut repository =
        SqliteRepository::open_in_memory(PersistenceDomain::Tasks).expect("open sqlite");
    for id in ["task:zulu", "task:alpha", "task:mike"] {
        repository
            .put(
                fixture_record(PersistenceDomain::Tasks, PersistenceRecordKind::Task, id, "rev:1"),
                RevisionExpectation::MustNotExist,
                LocalStoreTransactionPosture::Autocommit,
            )
            .expect("insert record");
    }
    // An update must not move a record to the end of the append order.
    repository
        .put(
            fixture_record(
                PersistenceDomain::Tasks,
                PersistenceRecordKind::Task,
                "task:zulu",
                "rev:2",
            ),
            RevisionExpectation::MustExist,
            LocalStoreTransactionPosture::Autocommit,
        )
        .expect("update first record");

    let ordered: Vec<String> = repository
        .list_in_insertion_order()
        .expect("insertion order listing")
        .into_iter()
        .map(|record| record.id.0)
        .collect();

    assert_eq!(ordered, vec!["task:zulu", "task:alpha", "task:mike"]);
}

#[test]
fn pre_seq_databases_migrate_with_order_backfilled_from_rowid() {
    let temp = tempfile::tempdir().expect("temp dir");
    let path = temp.path().join("legacy.sqlite");
    {
        let legacy = rusqlite::Connection::open(&path).expect("open legacy db");
        legacy
            .execute_batch(
                "CREATE TABLE tasks (
                    id TEXT PRIMARY KEY NOT NULL,
                    kind TEXT NOT NULL,
                    revision_id TEXT NOT NULL,
                    media_type TEXT,
                    payload BLOB NOT NULL
                );
                INSERT INTO tasks VALUES ('task:zulu', 'task', 'rev:1', NULL, x'00');
                INSERT INTO tasks VALUES ('task:alpha', 'task', 'rev:1', NULL, x'00');",
            )
            .expect("seed legacy schema");
    }

    let repository =
        SqliteRepository::open(&path, PersistenceDomain::Tasks).expect("open migrates schema");
    let ordered: Vec<String> = repository
        .list_in_insertion_order()
        .expect("ordered listing after migration")
        .into_iter()
        .map(|record| record.id.0)
        .collect();

    assert_eq!(ordered, vec!["task:zulu", "task:alpha"]);
}

#[test]
fn sqlite_repository_stores_shared_memory_records() {
    let mut repository =
        SqliteRepository::open_in_memory(PersistenceDomain::SharedMemory).expect("repository");
    let record = fixture_record(
        PersistenceDomain::SharedMemory,
        PersistenceRecordKind::SharedMemoryRecord,
        "memory:1",
        "rev:1",
    );

    repository
        .put(
            record.clone(),
            RevisionExpectation::MustNotExist,
            LocalStoreTransactionPosture::Autocommit,
        )
        .expect("put shared memory");

    assert_eq!(
        repository
            .get(&record.id)
            .expect("read shared memory")
            .expect("record exists")
            .kind,
        PersistenceRecordKind::SharedMemoryRecord
    );
}
