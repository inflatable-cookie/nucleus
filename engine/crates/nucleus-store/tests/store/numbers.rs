use super::*;

fn task_in(id: &str, repository: &str) -> Task {
    let mut identity = task(id, id).identity().clone();
    identity.repository = repository.into();
    Task::new(identity, "Plain brief".into(), None)
}

#[test]
fn an_unnumbered_repository_fences_admission_without_changing_runs() {
    let root = tempfile::tempdir().expect("scratch");
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
    drop(store);

    let db = Connection::open(storage.database().path().join("engine.sqlite")).expect("fixture");
    db.execute_batch("DELETE FROM task_numbers; DELETE FROM task_number_counters;")
        .expect("remove the numbering");
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
    let mut store = Store::open(&storage).expect("reopen");
    let execution = row(&store, "active");
    assert_eq!(execution.number, None);
    let new = task("new", "new");
    assert!(matches!(
        store.create(&new, &event("admitted")),
        Err(StoreError::NumbersNeedSeed)
    ));
    assert_eq!(row(&store, "active"), execution);
    assert_eq!(snapshot(), before);
}

#[test]
fn imported_counter_values_and_failed_admissions_preserve_independent_numbering() {
    let root = tempfile::tempdir().expect("scratch");
    let storage = fixture_storage(root.path());
    let store = Store::open(&storage).expect("open");
    drop(store);
    let db = Connection::open(storage.database().path().join("engine.sqlite")).expect("fixture");
    db.execute(
        "INSERT INTO task_number_counters (repository, next_number, legacy_next)
         VALUES ('example/fixture', 81, 81), ('example/other', 100, 99)",
        [],
    )
    .expect("already-imported counters");
    drop(db);

    let mut store = Store::open(&storage).expect("open stored counters");
    assert_eq!(
        store
            .create(&task("one", "same"), &event("admitted"))
            .expect("imported repository"),
        81
    );
    assert!(
        store
            .create(&task("duplicate", "same"), &event("admitted"))
            .is_err()
    );
    assert_eq!(
        store
            .create(&task("two", "two"), &event("admitted"))
            .expect("next reserved number"),
        82
    );
    assert_eq!(
        store
            .create(&task_in("other", "example/other"), &event("admitted"))
            .expect("previously advanced repository"),
        100
    );
    assert_eq!(
        store
            .create(&task_in("fresh", "example/fresh"), &event("admitted"))
            .expect("new repository"),
        1
    );
    assert_eq!(row(&store, "other").reference(), "other#100");
}
