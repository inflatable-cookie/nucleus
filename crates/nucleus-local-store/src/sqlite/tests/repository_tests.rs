//! SQLite repository semantics tests: revision expectations, conflicts,
//! deletion, insertion order, concurrency, and shared memory records.

use super::*;

use crate::repositories::LocalStoreRepository;

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
fn insertion_order_listing_ignores_lexicographic_id_order() {
    let mut repository =
        SqliteRepository::open_in_memory(PersistenceDomain::Tasks).expect("open sqlite");
    for id in ["task:zulu", "task:alpha", "task:mike"] {
        repository
            .put(
                fixture_record(
                    PersistenceDomain::Tasks,
                    PersistenceRecordKind::Task,
                    id,
                    "rev:1",
                ),
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
