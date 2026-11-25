use nucleus_store::{TaskNumberSeed, planning::legacy::read_task_number_seed};

use super::*;

fn legacy_copy(root: &Path) -> std::path::PathBuf {
    let path = root.join("legacy-copy.sqlite");
    let source = Connection::open(&path).expect("create synthetic legacy copy");
    source.execute_batch(
        "CREATE TABLE task_number_counters (repository TEXT PRIMARY KEY, next_number INTEGER NOT NULL);
         CREATE TABLE task_numbers (task_id TEXT PRIMARY KEY, repository TEXT NOT NULL, number INTEGER NOT NULL);
         INSERT INTO task_number_counters VALUES ('EXAMPLE/FIXTURE', 65), ('example/other', 99), ('example/a-first', 5);
         INSERT INTO task_numbers VALUES ('legacy-high', 'example/fixture', 80), ('other-high', 'example/other', 20);",
    ).expect("legacy snapshot");
    path
}

fn seed(root: &Path, copy: &Path, repository: &str) -> TaskNumberSeed {
    read_task_number_seed(root, copy, Some(repository)).expect("read legacy high-water mark")
}

fn task_in(id: &str, repository: &str) -> Task {
    let mut identity = task(id, id).identity().clone();
    identity.repository = repository.into();
    Task::new(identity, "Plain brief".into(), None)
}

#[test]
fn task_number_seed_backfills_three_tasks_in_order_and_preserves_run_wires_on_replay() {
    let root = tempfile::tempdir().expect("scratch");
    let copy = legacy_copy(root.path());
    let original_copy = std::fs::read(&copy).expect("legacy file");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("open");
    let (prior, running) = profile_reservation(&mut store, "active", Role::Worker);
    store
        .save_profile_launch(
            &prior,
            &running,
            &event("run_reserved"),
            "shared-subscription",
        )
        .expect("persist the frozen run");
    for id in ["pilot-z", "pilot-a"] {
        store
            .create(&task(id, id), &event("admitted"))
            .expect("preexisting task");
    }
    let rust_only = task_in("rust-only", "example/rust-only");
    store
        .create(&rust_only, &event("admitted"))
        .expect("Rust-only task");
    drop(store);

    let db = Connection::open(storage.database().path().join("engine.sqlite")).expect("fixture");
    db.execute_batch(
        "DROP TABLE task_numbers; DROP TABLE task_number_counters; DROP TABLE parent_deliveries; PRAGMA user_version = 8;",
    )
    .expect("recreate version eight");
    let snapshot = || {
        db.query_row(
            "SELECT reference, run, threads, version FROM tasks WHERE id = 'active'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .expect("read frozen task bytes")
    };
    let before = snapshot();
    let mut store = Store::open(&storage).expect("migrate");
    let execution = row(&store, "active");
    assert_eq!(execution.number, None);
    let new = task("new", "new");
    assert!(matches!(
        store.create(&new, &event("admitted")),
        Err(StoreError::NumbersNeedSeed)
    ));
    let seed = seed(root.path(), &copy, "example/fixture");
    for _ in 0..2 {
        store.seed_task_numbers(&seed).expect("seed or replay");
        for (id, number) in [("active", 81), ("pilot-z", 82), ("pilot-a", 83)] {
            let row = row(&store, id);
            assert_eq!(row.number, Some(number));
            assert_eq!(row.reference(), format!("fixture#{number}"));
        }
        assert_eq!(row(&store, "active"), execution);
        assert_eq!(snapshot(), before);
    }
    assert_eq!(
        store.create(&new, &event("admitted")).expect("new task"),
        84
    );
    assert_eq!(row(&store, "rust-only").number, None);
    let all = read_task_number_seed(root.path(), &copy, None).expect("global snapshot");
    store
        .seed_task_numbers(&all)
        .expect("seed every repository");
    assert_eq!(row(&store, "rust-only").reference(), "rust-only#1");
    let other = task_in("new-other", "example/other");
    assert_eq!(
        store
            .create(&other, &event("admitted"))
            .expect("first Rust task for legacy repo"),
        99
    );
    assert_eq!(std::fs::read(&copy).expect("legacy file"), original_copy);
}

#[test]
fn counters_are_independent_and_conflicting_seeds_or_admissions_roll_back() {
    let root = tempfile::tempdir().expect("scratch");
    let copy = legacy_copy(root.path());
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("open");
    let fixture = task("one", "same");
    let other = task_in("other", "example/other");
    let fresh = task_in("fresh", "example/fresh");
    assert_eq!(
        store.create(&fixture, &event("admitted")).expect("fixture"),
        1
    );
    assert_eq!(store.create(&fresh, &event("admitted")).expect("fresh"), 1);
    assert!(matches!(
        store.seed_task_numbers(&seed(root.path(), &copy, "example/fixture")),
        Err(StoreError::NumberOverlap)
    ));
    let all = read_task_number_seed(root.path(), &copy, None).expect("global snapshot");
    assert!(matches!(
        store.seed_task_numbers(&all),
        Err(StoreError::NumberOverlap)
    ));
    let first = task_in("first", "example/a-first");
    assert_eq!(
        store
            .create(&first, &event("admitted"))
            .expect("rolled-back repo seed"),
        1
    );
    assert!(
        store
            .create(&task("duplicate", "same"), &event("admitted"))
            .is_err()
    );
    assert_eq!(
        store
            .create(&task("two", "two"), &event("admitted"))
            .expect("next fixture"),
        2
    );
    store
        .seed_task_numbers(&seed(root.path(), &copy, "example/other"))
        .expect("seed another repo");
    assert_eq!(
        store
            .create(&other, &event("admitted"))
            .expect("start at stored next"),
        99
    );
    assert_eq!(row(&store, "other").reference(), "other#99");
}
