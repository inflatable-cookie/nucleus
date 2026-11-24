use std::path::Path;

use nucleus_core::{
    Action, Answer, Authority, CheckState, Command, Entry, Forge, Host, Identity, LaunchInputs,
    Observation, Observed, Phase, PullRequest, Role, RunState, Task, Workspace,
    profiles::{
        Candidate, Capability, LaunchPolicy, Profile, Provider, RotationCounts, UsageLevel, Weight,
        decide_profile_launch, decide_weighted_launch,
    },
};
use nucleus_store::{
    EngineSettings, EngineStorage, EventDraft, PinnedVolume, SettingsFile, StorageError, Store,
    StoreError, TaskRow,
};
use rusqlite::Connection;

fn fixture_storage(home: &Path) -> EngineStorage {
    let settings = SettingsFile::open(home).expect("open fixture settings");
    settings
        .save(&EngineSettings {
            enabled: true,
            work_volume: Some(PinnedVolume::detect(home).expect("fixture volume")),
            ..EngineSettings::default()
        })
        .expect("save fixture settings");
    let storage = settings.storage().expect("resolve fixture storage");
    storage
        .database()
        .ensure()
        .expect("prepare fixture database directory");
    storage
}

fn task(id: &str, reference: &str) -> Task {
    Task::new(
        Identity {
            id: id.into(),
            reference: reference.into(),
            repository: "example/fixture".into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
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

fn row(store: &Store, id: &str) -> TaskRow {
    store.row(id).expect("read row").expect("versioned row")
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
    let storage = fixture_storage(root.path());
    let mut first = Store::open(&storage).expect("open");
    let mut second = Store::open(&storage).expect("open another connection");
    let initial = task("1", "fixture#1");
    first.create(&initial, &event("accepted")).expect("admit");
    assert!(
        first
            .create(&task("2", "fixture#1"), &event("duplicate"))
            .is_err()
    );
    let prior = row(&second, "1");
    let mut working = initial.clone();
    assert_eq!(
        working.reconcile(&observation()),
        Action::Advance(Phase::Working)
    );
    first
        .save_row(&prior, &working, &event("working"))
        .expect("save");
    assert!(matches!(
        second.save_row(&prior, &initial, &event("stale")),
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
fn a_row_that_returns_to_the_same_task_still_invalidates_old_decisions() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("open store");
    let initial = task("1", "fixture#1");
    store.create(&initial, &event("admitted")).expect("admit");
    let stale = store.row("1").expect("row").expect("versioned row");
    let mut working = initial.clone();
    let _ = working.reconcile(&observation());
    let next = store
        .save_row(&stale, &working, &event("working"))
        .expect("advance");
    let current = store.row("1").expect("row").expect("advanced row");
    assert_eq!(current.version, next);
    store
        .save_row(&current, &initial, &event("moved back"))
        .expect("move back");
    assert!(matches!(
        store.save_row(&stale, &working, &event("stale")),
        Err(StoreError::StaleTask)
    ));
    assert_eq!(store.get("1").expect("read row"), Some(initial));
}

#[test]
fn a_cancelled_task_stays_active_until_the_revoked_run_settles() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
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
    let mut store = Store::open(&storage).expect("open");
    store.create(&task, &event("launched")).expect("admit");
    let before = row(&store, "1");
    assert_eq!(store.occupied_slots("other").expect("unsent run"), 0);
    let instance = task.run().expect("prepared run").launch().instance.clone();
    task.record_send(&instance, 1).expect("record dispatch");
    store
        .save_row(&before, &task, &event("sent"))
        .expect("save send marker");
    assert_eq!(store.occupied_slots("other").expect("sent run"), 1);
    assert_eq!(store.occupied_slots("1").expect("own slot excluded"), 0);
    let before = row(&store, "1");
    task.command(
        Command::Cancel,
        &Authority::Operator {
            actor: "fixture".into(),
        },
        &observation,
    )
    .expect("cancel");
    store
        .save_row(&before, &task, &event("cancelled"))
        .expect("save");
    drop(store);

    let mut store = Store::open(&storage).expect("reopen");
    assert_eq!(store.active().expect("active"), vec![task.clone()]);
    assert_eq!(store.active_ids(None, 1).expect("first page"), ["1"]);
    assert!(
        store
            .active_ids(Some("1"), 1)
            .expect("after cursor")
            .is_empty()
    );
    assert_eq!(store.occupied_slots("other").expect("revoked pending"), 1);
    let before = row(&store, "1");
    let settled = Observation {
        host: Observed::Known(Host::Current {
            instance: task.run().expect("revoked run").launch().instance.clone(),
            state: RunState::Ended,
        }),
        ..observation
    };
    assert_eq!(task.reconcile(&settled), Action::Advance(Phase::Cancelled));
    store
        .save_row(&before, &task, &event("stopped"))
        .expect("save");
    assert_eq!(store.get("1").expect("stored task"), Some(task));
    assert!(store.active().expect("active").is_empty());
    assert_eq!(store.occupied_slots("other").expect("settled run"), 0);
}

#[test]
fn an_unrelated_database_is_never_initialized_as_engine_state() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let db = storage.database().path().join("engine.sqlite");
    let other = Connection::open(&db).expect("open unrelated file");
    other
        .execute_batch("CREATE TABLE unrelated (value TEXT);")
        .expect("create unrelated table");
    assert!(matches!(
        Store::open(&storage),
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

#[test]
fn migrating_version_two_keeps_rows_and_adds_the_slot_index() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("open");
    let task = task("1", "fixture#1");
    store.create(&task, &event("admitted")).expect("admit");
    drop(store);
    let db = Connection::open(storage.database().path().join("engine.sqlite"))
        .expect("fixture connection");
    db.execute_batch(
        "DROP TABLE inbox_bindings; DROP TABLE profile_assignments; DROP TABLE profile_assignment_totals;
         DROP TABLE acp_sessions; DROP INDEX occupied_launch_slots; PRAGMA user_version = 2;",
    )
    .expect("restore version two schema");
    let store = Store::open(&storage).expect("migrate version two");
    assert_eq!(row(&store, "1"), TaskRow { task, version: 1 });
    assert_eq!(store.history("1", None, 1).expect("audit").len(), 1);
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type='index' AND name='occupied_launch_slots'",
            [],
            |row| row.get::<_, u32>(0)
        )
        .expect("slot index"),
        1
    );
}

fn profile_reservation(store: &mut Store, id: &str, role: Role) -> (TaskRow, Task) {
    let initial = task(id, id);
    let mut identity = initial.identity().clone();
    let head = "a".repeat(40).parse().expect("synthetic head");
    let pr = PullRequest {
        url: "https://github.com/example/fixture/pull/1".into(),
        head,
    };
    let mut observation = observation();
    observation.forge = Observed::Known(Forge::Absent);
    let mut task = match role {
        Role::Worker => initial,
        Role::Reviewer => {
            identity.entry = Entry::ReviewEntry;
            observation.forge = Observed::Known(Forge::Open {
                pr: pr.clone(),
                checks: CheckState::Ready,
            });
            observation.workspace = Observed::Known(Workspace::Clean(pr.head.clone()));
            Task::new(identity, "Review the greeting".into(), Some(pr))
        }
    };
    let _ = task.reconcile(&observation);
    store.create(&task, &event("admitted")).expect("admit");
    let row = row(store, id);
    let profile = Profile {
        id: "greeting".into(),
        capability: Capability::Worker,
        weight: Weight::More,
        provider: Provider::Codex,
        model: "different-model".into(),
        effort: None,
    };
    let counts = store
        .rotation_counts(role, &profile.id, "shared-subscription")
        .unwrap_or_default();
    let policy = LaunchPolicy {
        usage: UsageLevel::Normal,
        candidates: &[Candidate {
            profile: &profile,
            enabled: true,
            available: true,
            group_available: true,
            supported_efforts: &[],
            counts,
        }],
        planner_brief: true,
        author_models: &["fixture-author-model"],
    };
    let intent = if counts == RotationCounts::default() {
        decide_weighted_launch(&task, &observation, &policy, 42)
    } else {
        decide_profile_launch(&task, &observation, &policy)
    }
    .expect("eligible choice")
    .expect("launch decision");
    task.reserve_profile_launch(
        &observation,
        LaunchInputs {
            thread: format!("fixture-thread-{id}"),
            started_at: 42,
            input: "synthetic launch".into(),
        },
        &[1; 32],
        intent,
    )
    .expect("freeze profiled launch");
    (row, task)
}

#[test]
fn an_empty_usage_store_allows_a_profiled_launch() {
    let root = tempfile::tempdir().expect("scratch");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("open");
    let group = "shared-subscription";
    assert_eq!(
        store.rotation_counts(Role::Worker, "greeting", group),
        Some(RotationCounts::default())
    );
    let (prior, task) = profile_reservation(&mut store, "initial", Role::Worker);
    store
        .save_profile_launch(&prior, &task, &event("run_reserved"), group)
        .expect("launch from an empty history");
    let mut sent = row(&store, "initial");
    let instance = task.run().expect("run").launch().instance.clone();
    sent.task.record_send(&instance, 43).expect("record send");
    let prior = row(&store, "initial");
    store
        .save_row(&prior, &sent.task, &event("run_sent"))
        .expect("send marker does not charge again");
    assert_eq!(
        store.rotation_counts(Role::Worker, "greeting", group),
        Some(RotationCounts {
            profile_recent: 1,
            group_recent: 1,
            profile_lifetime: 1,
            group_lifetime: 1,
        })
    );
}

#[test]
fn reopening_keeps_the_role_window_and_lifetime_counts() {
    let root = tempfile::tempdir().expect("scratch");
    let storage = fixture_storage(root.path());
    let group = "shared-subscription";
    let mut store = Store::open(&storage).expect("open");
    for i in 0..54 {
        let role = if i < 52 { Role::Worker } else { Role::Reviewer };
        let (prior, task) = profile_reservation(&mut store, &i.to_string(), role);
        store
            .save_profile_launch(&prior, &task, &event("run_reserved"), group)
            .expect("charge frozen instance");
    }
    drop(store);
    let store = Store::open(&storage).expect("reopen");
    for (role, recent, lifetime) in [(Role::Worker, 50, 52), (Role::Reviewer, 2, 2)] {
        assert_eq!(
            store.rotation_counts(role, "greeting", group),
            Some(RotationCounts {
                profile_recent: recent,
                group_recent: 50,
                profile_lifetime: lifetime,
                group_lifetime: 54,
            })
        );
    }
    let db = Connection::open(storage.database().path().join("engine.sqlite")).expect("inspect");
    assert_eq!(
        db.query_row("SELECT count(*) FROM profile_assignments", [], |row| row
            .get::<_, u32>(0))
            .expect("bounded history"),
        52
    );
}

#[test]
fn history_failure_does_not_lose_the_launch_or_leave_a_partial_charge() {
    let root = tempfile::tempdir().expect("scratch");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("open");
    let db = Connection::open(storage.database().path().join("engine.sqlite")).expect("inspect");
    db.execute_batch(
        "CREATE TRIGGER fail_charge BEFORE INSERT ON profile_assignment_totals
         BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
    )
    .expect("fail the second usage write");
    let (prior, task) = profile_reservation(&mut store, "fallback", Role::Worker);
    store
        .save_profile_launch(&prior, &task, &event("run_reserved"), "shared-subscription")
        .expect("usage failure leaves task writes available");
    assert_eq!(row(&store, "fallback").task, task);
    assert_eq!(
        store.rotation_counts(Role::Worker, "greeting", "shared-subscription"),
        Some(RotationCounts::default())
    );
    db.execute("DROP TABLE profile_assignment_totals", [])
        .expect("make the rotation read unavailable");
    assert_eq!(
        store.rotation_counts(Role::Worker, "greeting", "shared-subscription"),
        None
    );
    let (prior, task) = profile_reservation(&mut store, "unreadable", Role::Worker);
    store
        .save_profile_launch(&prior, &task, &event("run_reserved"), "shared-subscription")
        .expect("unreadable rotation falls back to weights");
    assert_eq!(row(&store, "unreadable").task, task);
}

#[test]
fn an_audit_insert_failure_rolls_back_the_task_update() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("open");
    let initial = task("1", "fixture#1");
    store.create(&initial, &event("admitted")).expect("admit");
    let db = Connection::open(storage.database().path().join("engine.sqlite"))
        .expect("fixture connection");
    db.execute_batch("CREATE TRIGGER fail_audit BEFORE INSERT ON events WHEN NEW.kind = 'reject' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;").expect("install fixture trigger");
    let mut changed = initial.clone();
    changed.reconcile(&observation());
    let before = row(&store, "1");
    assert!(store.save_row(&before, &changed, &event("reject")).is_err());
    assert_eq!(row(&store, "1"), before);
    assert_eq!(
        store.get("1").expect("read rolled back task"),
        Some(initial)
    );
    assert_eq!(store.history("1", None, 10).expect("audit").len(), 1);
}

#[test]
fn restoring_a_review_entry_with_planner_acceptance_is_refused() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("open");
    let mut task = task("1", "fixture#1");
    task.reconcile(&observation());
    let head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        .parse()
        .expect("fixture head");
    let merged = Observation {
        forge: Observed::Known(Forge::Merged {
            pr: PullRequest {
                url: "https://github.com/example/fixture/pull/1".into(),
                head,
            },
            commit: "ffffffffffffffffffffffffffffffffffffffff"
                .parse()
                .expect("merge commit"),
        }),
        ..observation()
    };
    task.reconcile(&merged);
    let pr = task.pull_request().expect("merged PR");
    task.command(
        Command::Answer(Answer::Accept {
            head: pr.head.clone(),
            reason: "reviewed".into(),
        }),
        &Authority::Planner {
            actor: "planner".into(),
        },
        &merged,
    )
    .expect("accept a brief");
    store.create(&task, &event("admitted")).expect("admit");
    let db = Connection::open(storage.database().path().join("engine.sqlite"))
        .expect("fixture connection");
    db.execute("UPDATE tasks SET entry='review_entry'", [])
        .expect("inject invalid restored state");
    assert!(matches!(
        store.get("1"),
        Err(StoreError::Sqlite(
            rusqlite::Error::FromSqlConversionFailure(..)
        ))
    ));
}

#[test]
fn settings_do_not_create_storage_until_the_configured_volume_is_verified() {
    let root = tempfile::tempdir().expect("scratch directory");
    let file = SettingsFile::open(root.path()).expect("open empty fixture home");
    assert_eq!(file.load().expect("defaults"), EngineSettings::default());
    assert!(matches!(file.storage(), Err(StorageError::Disabled)));
    let matching = PinnedVolume::detect(root.path()).expect("mounted fixture volume");
    for volume in [
        PinnedVolume {
            mount: root.path().join("missing-mount"),
            volume_id: matching.volume_id.clone(),
        },
        PinnedVolume {
            mount: matching.mount.clone(),
            volume_id: "wrong-volume".into(),
        },
        PinnedVolume {
            mount: root.path().into(),
            volume_id: matching.volume_id.clone(),
        },
    ] {
        let settings = EngineSettings {
            enabled: true,
            work_volume: Some(volume),
            ..EngineSettings::default()
        };
        assert!(file.save(&settings).is_err());
        assert_eq!(
            std::fs::read_dir(root.path())
                .expect("inspect untouched home")
                .count(),
            0
        );
    }
    let settings = EngineSettings {
        enabled: true,
        work_volume: Some(matching),
        ..EngineSettings::default()
    };
    file.save(&settings).expect("publish versioned settings");
    assert_eq!(file.load().expect("read settings back"), settings);
    let storage = file.storage().expect("load verified roots");
    assert_eq!(storage.work().path(), root.path().join("work"));
    assert!(!storage.database().path().exists());
    assert!(!storage.scratch().path().exists());
}

#[test]
fn pinned_work_and_scratch_roots_cannot_resolve_to_another_volume() {
    let fixture = tempfile::tempdir().expect("fixture");
    let home = fixture.path().canonicalize().expect("canonical home");
    let file = SettingsFile::open(&home).expect("settings");
    let config = EngineSettings {
        enabled: true,
        work_volume: Some(PinnedVolume::detect(&home).expect("fixture volume")),
        ..EngineSettings::default()
    };
    for settings in [
        EngineSettings {
            work_root: Some("/dev/nucleus-outside".into()),
            ..config.clone()
        },
        EngineSettings {
            scratch_root: Some("/dev/nucleus-outside".into()),
            ..config
        },
    ] {
        assert!(matches!(
            file.save(&settings),
            Err(StorageError::OutsideVolume)
        ));
    }
    assert!(
        std::fs::read_dir(home)
            .expect("untouched home")
            .next()
            .is_none()
    );
}

#[test]
fn profile_domain_defaults_are_read_only_and_stable_ids_survive_name_edits() {
    use nucleus_store::Profiles;

    let home = tempfile::tempdir().expect("portable root");
    let home = home.path().canonicalize().expect("canonical fixture");
    fixture_storage(&home);
    let file = SettingsFile::open(&home).expect("fixture settings");
    let original = file.read::<Profiles>().expect("default profiles");
    assert_eq!(original.revision, "default");
    assert!(
        !home.join("config").exists(),
        "a read creates no config root"
    );

    let value: Profiles = serde_json::from_value(serde_json::json!({"profiles": [{
        "name": "Heavy",
        "selection": {
            "id": "stable-profile", "capability": "heavyweight", "weight": "fewer",
            "provider": "codex", "model": "fixture-model", "thinkingOptionId": "high"
        }
    }]}))
    .expect("canonical profile shape");
    let (first, changed) = file
        .edit::<Profiles>(&original.revision, |profiles| {
            *profiles = value;
            Ok(())
        })
        .expect("save profiles");
    assert!(changed);
    let document: serde_json::Value = serde_json::from_slice(
        &std::fs::read(home.join("config/profiles.json")).expect("published settings"),
    )
    .expect("versioned JSON");
    assert_eq!(document["schemaVersion"], 1);

    let reopened = SettingsFile::open(&home).expect("reopen settings");
    let (saved, changed) = reopened
        .edit::<Profiles>(&first.revision, |profiles| {
            profiles.profiles[0].name = "Renamed".into();
            Ok(())
        })
        .expect("rename profile");
    assert!(changed);
    assert_eq!(saved.value.profiles[0].selection.id, "stable-profile");
    let (same, changed) = reopened
        .edit::<Profiles>(&saved.revision, |_| Ok(()))
        .expect("no-op");
    assert!(!changed);
    assert_eq!(same.revision, saved.revision);
}

#[test]
fn storage_settings_reject_a_symlink_without_publishing() {
    let root = tempfile::tempdir().expect("portable root");
    let home = root.path().canonicalize().expect("canonical fixture");
    let storage = fixture_storage(&home);
    let file = SettingsFile::open(&home).expect("fixture settings");
    let original = file.read::<EngineSettings>().expect("active settings");
    let redirect = home.join("redirect");
    std::os::unix::fs::symlink(storage.database().path(), &redirect).expect("redirect fixture");
    assert!(
        file.edit::<EngineSettings>(&original.revision, |settings| {
            settings.scratch_root = Some(redirect);
            Ok(())
        })
        .is_err()
    );
    assert_eq!(
        file.read::<EngineSettings>().expect("settings").revision,
        original.revision
    );
    let backups = storage.backups().expect("verify absent backup root");
    assert!(backups.complete);
    assert!(backups.verified.is_empty());
}
