use nucleus_core::{
    Action, Authority, Command, Entry, Host, Identity, LaunchInputs, Observation, Observed, Phase,
    RunState, Task, Workspace,
};
use nucleus_store::{EventDraft, Store, StoreError};
use rusqlite::Connection;

fn task(id: &str, reference: &str) -> Task {
    Task::new(
        Identity {
            id: id.into(),
            reference: reference.into(),
            repository: "example/fixture".into(),
            base: "main".into(),
            entry: Entry::Brief,
        },
        "Add a greeting".into(),
        None,
    )
}

fn event(kind: &str) -> EventDraft {
    EventDraft {
        at: 1,
        kind: kind.into(),
        detail: kind.into(),
    }
}

fn observation() -> Observation {
    Observation {
        host: Observed::Unknown,
        forge: Observed::Unknown,
        workspace: Observed::Known(Workspace::Absent),
    }
}

#[test]
fn a_stale_writer_cannot_change_state_or_append_history() {
    let root = tempfile::tempdir().expect("scratch directory");
    let mut first = Store::open(root.path()).expect("open");
    let mut second = Store::open(root.path()).expect("open another connection");
    let initial = task("1", "fixture#1");
    first.create(&initial, &event("accepted")).expect("admit");
    assert!(
        first
            .create(&task("2", "fixture#1"), &event("duplicate"))
            .is_err()
    );
    let mut working = initial.clone();
    assert_eq!(
        working.reconcile(&observation()),
        Action::Advance(Phase::Working)
    );
    first
        .save(&initial, &working, &event("working"))
        .expect("save");
    assert!(matches!(
        second.save(&initial, &initial, &event("stale")),
        Err(StoreError::StaleTask)
    ));
    assert_eq!(second.get("1").expect("read"), Some(working));
    assert_eq!(second.get("2").expect("read absent"), None);
    let newest = second.history("1", None, 1).expect("latest event");
    assert_eq!(newest[0].content.kind, "working");
    let older = first
        .history("1", Some(newest[0].sequence), 5)
        .expect("history before cursor");
    assert_eq!(older.len(), 1);
    assert_eq!(older[0].content.kind, "accepted");
}

#[test]
fn a_cancelled_task_stays_active_until_the_revoked_run_settles() {
    let root = tempfile::tempdir().expect("scratch directory");
    let mut task = task("1", "fixture#1");
    let observation = observation();
    task.reconcile(&observation);
    task.reserve_launch(
        &observation,
        LaunchInputs {
            thread: "worker".into(),
            started_at: 1,
            input: "first launch".into(),
        },
        &[7; 32],
    )
    .expect("reserve");
    let before = task.clone();
    let mut store = Store::open(root.path()).expect("open");
    store.create(&before, &event("launched")).expect("admit");
    task.command(
        Command::Cancel,
        &Authority::Operator {
            actor: "fixture".into(),
        },
        &observation,
    )
    .expect("cancel");
    store
        .save(&before, &task, &event("cancelled"))
        .expect("save");
    drop(store);

    let mut store = Store::open(root.path()).expect("reopen");
    assert_eq!(store.active().expect("active"), vec![task.clone()]);
    let before = task.clone();
    let settled = Observation {
        host: Observed::Known(Host::Current {
            instance: task.run().expect("revoked run").launch().instance.clone(),
            state: RunState::Ended,
        }),
        ..observation
    };
    assert_eq!(task.reconcile(&settled), Action::Advance(Phase::Cancelled));
    store.save(&before, &task, &event("stopped")).expect("save");
    assert_eq!(store.get("1").expect("stored task"), Some(task));
    assert!(store.active().expect("active").is_empty());
}

#[test]
fn an_unrelated_database_is_never_initialized_as_engine_state() {
    let root = tempfile::tempdir().expect("scratch directory");
    let db = root.path().join("engine.sqlite");
    let other = Connection::open(&db).expect("open unrelated file");
    other
        .execute_batch("CREATE TABLE unrelated (value TEXT);")
        .expect("create unrelated table");
    assert!(matches!(
        Store::open(root.path()),
        Err(StoreError::Incompatible {
            application: 0,
            version: 0
        })
    ));
    let count: i64 = other
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table'",
            [],
            |row| row.get(0),
        )
        .expect("inspect schema");
    assert_eq!(count, 1);
}
