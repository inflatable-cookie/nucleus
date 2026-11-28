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
    DependencyEdit, EngineSettings, EngineStorage, EventDraft, SettingsFile, StorageError, Store,
    StoreError, TaskRow,
};

use rusqlite::Connection;

#[path = "store/numbers.rs"]
mod numbers;
#[path = "store/planning.rs"]
mod planning;

fn fixture_storage(home: &Path) -> EngineStorage {
    let settings = SettingsFile::open(home).expect("open fixture settings");
    settings
        .save(&EngineSettings {
            enabled: true,
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

#[test]
fn issued_reply_handles_resolve_in_both_forms_until_they_expire() {
    use nucleus_core::QuestionDelivery;
    use nucleus_store::{TellDispatch, TellRows, TellSubmission};
    const WEEK_MS: i64 = 7 * 24 * 3_600_000;
    let home = tempfile::tempdir().unwrap();
    let mut store = Store::open(&fixture_storage(home.path())).unwrap();
    for (id, handle) in [
        ("message-short", "r6e39f1a"),
        ("message-long", "nreply_legacy"),
    ] {
        let submission = TellSubmission {
            key: id,
            sender: "sender",
            from_project: "origin",
            direct: None,
            text: "Hello",
            recorded_at: 100,
            no_live_planners: &[],
        };
        store
            .record_tell(&submission, &[(format!("target-{id}"), id.into())])
            .unwrap();
        store
            .settle_tells(
                TellRows::Receipt(id),
                TellDispatch::Send {
                    notice: QuestionDelivery {
                        thread: "recipient".into(),
                        command: id.into(),
                        payload: String::new(),
                        last_send_at_ms: None,
                    },
                    handle: handle.into(),
                },
                100,
            )
            .unwrap();
    }
    for handle in ["r6e39f1a", "nreply_legacy"] {
        assert!(store.tell_reply_handle_issued(handle).unwrap());
        assert_eq!(
            store
                .tell_reply_route(handle, "recipient", 101)
                .unwrap()
                .map(|(_, sender)| sender),
            Some("sender".into())
        );
        assert!(
            store
                .tell_reply_route(handle, "someone-else", 101)
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .tell_reply_route(handle, "recipient", 100 + WEEK_MS)
                .unwrap()
                .is_none()
        );
    }
    assert!(!store.tell_reply_handle_issued("r00000000").unwrap());
}

#[test]
fn project_tell_rate_limit_follows_the_recipient_across_projects() {
    use nucleus_core::QuestionDelivery;
    use nucleus_store::{TellDispatch, TellRows, TellSubmission};
    let home = tempfile::tempdir().unwrap();
    let mut store = Store::open(&fixture_storage(home.path())).unwrap();
    for index in 0..21 {
        let id = format!("message-{index}");
        let target = format!("project-{index}");
        let submission = TellSubmission {
            key: &id,
            sender: "sender",
            from_project: "origin",
            direct: None,
            text: "Hello",
            recorded_at: 100,
            no_live_planners: &[],
        };
        store
            .record_tell(&submission, &[(target, id.clone())])
            .unwrap();
        let send = || TellDispatch::Send {
            notice: QuestionDelivery {
                thread: "recipient".into(),
                command: id.clone(),
                payload: String::new(),
                last_send_at_ms: None,
            },
            handle: format!("nreply_{index}"),
        };
        let result = store.settle_tells(TellRows::Receipt(&id), send(), 100);
        if index < 20 {
            result.unwrap();
        } else {
            assert!(matches!(result, Err(StoreError::TellRateLimit(_))));
            assert!(
                store
                    .tell_reply_route("nreply_20", "recipient", 101)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(store.tell_batch(&id).unwrap()[0].retry_at, Some(3_600_100));
            store
                .settle_tells(TellRows::Receipt(&id), send(), 3_600_100)
                .unwrap();
        }
    }
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
fn board_activity_keeps_the_work_time_after_done_housekeeping() {
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    let mut store = Store::open(&storage).unwrap();
    store
        .create(&task("closed", "closed"), &event("admitted"))
        .unwrap();
    for (at, kind) in (2..).zip([
        "entered_done",
        "role_archive_progress",
        "role_threads_archived",
        "closed_checkout_removed",
        "worktree_pruned",
        "host_observation_incomplete",
        "run_routing_observed",
        "allowance_wait_cleared",
        "task_title_set",
        "row_snoozed",
        "telemetry_stage",
        "project_removed",
    ]) {
        store
            .record_task_effect("closed", &EventDraft { at, ..event(kind) })
            .unwrap();
    }
    assert_eq!(store.board_times("closed").unwrap().latest_event, Some(2));
}

#[test]
fn claiming_a_task_effect_twice_preserves_the_first_board_timestamp() {
    let home = tempfile::tempdir().expect("fixture volume");
    let storage = fixture_storage(home.path());
    let version = {
        let mut store = Store::open(&storage).expect("open before failure");
        let version = store
            .create(&task("fixture", "fixture"), &event("admitted"))
            .expect("admit");
        let mut receipt = event("native_turn_failed");
        receipt.at += 1;
        receipt.detail = serde_json::json!({
            "version":version,"session":"before-restart","command":"hold-3",
        })
        .to_string();
        let sequence = store
            .claim_task_effect("fixture", &receipt, true)
            .expect("claim")
            .expect("new event");
        assert_eq!(
            store.history("fixture", None, 1).unwrap()[0].sequence,
            sequence
        );
        let entered_at = u64::try_from(receipt.at).unwrap();
        let times = store.board_times("fixture").unwrap();
        assert_eq!(times.since, Some(entered_at));
        assert_eq!(times.admitted, Some(entered_at - 1));
        assert_eq!(times.latest_event, times.admitted);
        receipt.at += 1;
        assert_eq!(
            store
                .claim_task_effect("fixture", &receipt, true)
                .expect("duplicate"),
            None
        );
        assert_eq!(
            store.board_times("fixture").unwrap().since,
            Some(entered_at)
        );
        version
    };
    let store = Store::open(&storage).expect("reopen");
    assert_eq!(row(&store, "fixture").version, version);
}

#[test]
fn inbox_ui_messages_cannot_repeat_their_open_across_restarts() {
    let home = tempfile::tempdir().expect("fixture volume");
    let storage = fixture_storage(home.path());
    let mut store = Store::open(&storage).expect("before restart");
    assert!(
        store
            .claim_inbox_message("fixture-ui-1", 1)
            .expect("first message")
    );
    drop(store);
    let mut store = Store::open(&storage).expect("after restart");
    assert!(
        !store
            .claim_inbox_message("fixture-ui-1", 2)
            .expect("old message")
    );
    assert!(
        store
            .claim_inbox_message("fixture-ui-2", 3)
            .expect("new message")
    );
}

#[test]
fn provider_pauses_survive_reopen_and_expire_at_the_deadline() {
    let home = tempfile::tempdir().expect("fixture volume");
    let storage = fixture_storage(home.path());
    {
        let store = Store::open(&storage).expect("open before pause");
        store
            .record_provider_pause("shared", 5_000, 1_000)
            .expect("first limit");
        store
            .record_provider_pause("shared", 6_000, 2_000)
            .expect("later deadline");
        store
            .record_provider_pause("shared", 5_500, 3_000)
            .expect("shorter deadline");
        store
            .record_provider_pause("stale", 4_000, 4_000)
            .expect("expired input");
    }
    let store = Store::open(&storage).expect("reopen after limits");
    assert_eq!(
        store.active_provider_pauses(5_999).expect("still paused"),
        [("shared".into(), 6_000)].into()
    );
    assert!(
        store
            .active_provider_pauses(6_000)
            .expect("at deadline")
            .is_empty()
    );
    assert_eq!(
        store.provider_pause("shared", 6_000).expect("expired"),
        None
    );
}

#[test]
fn only_the_displayed_fallback_can_be_cleared_after_reopen() {
    use nucleus_store::SubscriptionPause;
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    let estimate = SubscriptionPause {
        until_ms: 80_000,
        fallback: true,
    };
    let store = Store::open(&storage).unwrap();
    assert!(store.set_subscription_pause("group", estimate, 5).unwrap());
    drop(store);
    let store = Store::open(&storage).unwrap();
    assert_eq!(
        store.subscription_pause("group", 5).unwrap(),
        Some(estimate)
    );
    assert_eq!(store.fallback_pause_groups(5).unwrap(), ["group"]);
    assert!(!store.clear_fallback_pause("group", 60_000).unwrap());
    store.record_provider_pause("group", 70_000, 6).unwrap();
    assert!(!store.set_subscription_pause("group", estimate, 7).unwrap());
    assert!(!store.clear_fallback_pause("group", 70_000).unwrap());
    assert!(store.fallback_pause_groups(7).unwrap().is_empty());
    assert!(
        store
            .set_subscription_pause("group", estimate, 70_000)
            .unwrap()
    );
    assert!(store.clear_fallback_pause("group", 80_000).unwrap());
    assert_eq!(store.provider_pause("group", 70_000).unwrap(), None);
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
    assert_eq!(second.get("1").expect("read"), Some(working.clone()));
    assert_eq!(second.get("2").expect("read absent"), None);
    let newest = second.history("1", None, 1).expect("latest event");
    assert_eq!(newest[0].content.kind, "phase_transition");
    assert_eq!(newest[0].content.at, event("working").at);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&newest[0].content.detail).unwrap(),
        serde_json::json!({"from":"queued", "to":"working"})
    );
    let older = first
        .history("1", Some(newest[0].sequence), 5)
        .expect("history before cursor");
    assert_eq!(older.len(), 2);
    assert_eq!(older[0].content.kind, "working");
    assert_eq!(older[1].content.kind, "accepted");
    drop(first);
    drop(second);
    let reopened = Store::open(&storage).expect("reopen older and new rows");
    assert_eq!(reopened.get("1").unwrap(), Some(working));
    assert_eq!(reopened.lifecycle_events("1").unwrap().len(), 1);
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
    let transitions = store.lifecycle_events("1").unwrap();
    let details: Vec<serde_json::Value> = transitions
        .iter()
        .map(|entry| serde_json::from_str(&entry.content.detail).unwrap())
        .collect();
    assert_eq!(
        details,
        [
            serde_json::json!({"from":"queued", "to":"working"}),
            serde_json::json!({"from":"working", "to":"queued"})
        ]
    );
}

#[test]
fn a_cancelled_task_stays_active_until_the_revoked_run_settles() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut task = task("1", "fixture#1");
    let scratch = root.path().join("r/abcdef001122");
    let observation = observation();
    task.reconcile(&observation);
    task.reserve_launch(
        &observation,
        LaunchInputs {
            scratch: Some(scratch.clone()),
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
    assert_eq!(
        before.task.run().unwrap().launch().scratch.as_deref(),
        Some(scratch.as_path())
    );
    assert_eq!(
        store.occupied_slots("other").expect("unsent run").total(),
        0
    );
    let instance = task.run().expect("prepared run").launch().instance.clone();
    task.record_send(&instance, 1).expect("record dispatch");
    store
        .save_row(&before, &task, &event("sent"))
        .expect("save send marker");
    assert_eq!(store.occupied_slots("other").expect("sent run").total(), 1);
    assert_eq!(
        store
            .occupied_slots("1")
            .expect("own slot excluded")
            .total(),
        0
    );
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
    assert_eq!(
        store.active_ids(None, 1).expect("first page"),
        [nucleus_store::TaskSeed {
            id: "1".into(),
            admission_order: None,
            closeout: true,
            queue_priority: nucleus_core::QueuePriority::Normal,
            weight: nucleus_core::profiles::TaskWeight::Normal,
        }]
    );
    assert!(
        store
            .active_ids(Some("1"), 1)
            .expect("after cursor")
            .is_empty()
    );
    assert_eq!(
        store
            .occupied_slots("other")
            .expect("revoked pending")
            .total(),
        1
    );
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
    assert_eq!(
        store.occupied_slots("other").expect("settled run").total(),
        0
    );
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
fn title_receipts_keep_the_same_request_across_restart_and_retry() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("open");
    store
        .create(&task("1", "fixture#1"), &event("admitted"))
        .expect("admit");
    assert!(
        store
            .desire_title("1", "thread", "Working")
            .expect("new title")
    );
    let first = store
        .pending_title("thread")
        .expect("pending")
        .expect("desired");
    assert!(store.defer_title(&first, 100).expect("begin send"));
    drop(store);

    let store = Store::open(&storage).expect("restart");
    let retry = store
        .pending_title("thread")
        .expect("pending")
        .expect("retry");
    assert_eq!(retry.generation, first.generation);
    assert_eq!(retry.retry_at, 5_100);
    assert!(store.defer_title(&retry, retry.retry_at).expect("retry"));
    assert_eq!(
        store
            .pending_title("thread")
            .expect("pending")
            .expect("backoff")
            .retry_at,
        15_100
    );
    assert!(
        store
            .desire_title("1", "thread", "Reviewing")
            .expect("phase changed")
    );
    store.confirm_title(&retry).expect("late receipt");
    let next = store
        .pending_title("thread")
        .expect("pending")
        .expect("new intent");
    assert_eq!(next.generation, first.generation + 1);
    assert_eq!(next.retry_at, 0);
    assert!(
        !store
            .desire_title("1", "thread", "Reviewing")
            .expect("same desired title")
    );
    store.confirm_title(&next).expect("settled title");
    assert!(store.pending_title("thread").expect("pending").is_none());

    store
        .desire_title("1", "thread", "Waiting for capacity")
        .expect("new wait");
    let uncertain = store
        .pending_title("thread")
        .expect("pending")
        .expect("wait intent");
    store.defer_title(&uncertain, 0).expect("attempted rename");
    store
        .desire_title("1", "thread", "Reviewing")
        .expect("wait cleared");
    let restored = store
        .pending_title("thread")
        .expect("pending")
        .expect("a possibly delivered rename needs correcting");
    assert_eq!(restored.generation, uncertain.generation + 1);
}

#[test]
fn title_redesire_keeps_command_id_and_preserves_newer_generations() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("open");
    store
        .create(&task("1", "fixture#1"), &event("admitted"))
        .expect("admit");
    assert!(
        store
            .desire_title("1", "thread", "Reviewing")
            .expect("initial title")
    );
    let first = store
        .pending_title("thread")
        .expect("pending")
        .expect("row");

    // Re-desiring while pending must not reset backoff or clear anything.
    assert!(!store.redesire_title(&first).expect("pending no-op"));
    store.confirm_title(&first).expect("confirm first");
    assert!(store.pending_title("thread").expect("pending").is_none());

    // A stale shell re-desires the confirmed receipt under the same command generation.
    assert!(store.redesire_title(&first).expect("re-desire confirmed"));
    let reopened = store
        .pending_title("thread")
        .expect("pending")
        .expect("reopened");
    assert_eq!(reopened.generation, first.generation);
    assert_eq!(reopened.retry_at, 0);
    assert_eq!(reopened.desired, "Reviewing");

    // Advancing to a newer generation preserves it against older confirm/defer/redesire receipts.
    assert!(
        store
            .desire_title("1", "thread", "Closing")
            .expect("newer desire")
    );
    let newer = store
        .pending_title("thread")
        .expect("pending")
        .expect("newer");
    assert_eq!(newer.generation, first.generation + 1);
    store
        .confirm_title(&reopened)
        .expect("stale confirm ignored");
    assert!(
        !store
            .defer_title(&reopened, 500)
            .expect("stale defer ignored")
    );
    assert!(
        !store
            .redesire_title(&reopened)
            .expect("stale redesire ignored")
    );
    let still_newer = store
        .pending_title("thread")
        .expect("pending")
        .expect("newer preserved");
    assert_eq!(still_newer.generation, newer.generation);
    assert_eq!(still_newer.retry_at, 0);
    assert_eq!(still_newer.desired, "Closing");

    // Confirming and re-desiring also preserve Inbox generations.
    store
        .desire_inbox_title("inbox", "All quiet")
        .expect("inbox title");
    let inbox_first = store
        .pending_inbox_title("inbox")
        .expect("pending inbox")
        .expect("inbox receipt");
    store.confirm_title(&inbox_first).expect("confirm inbox");
    assert!(store.redesire_title(&inbox_first).expect("redesire inbox"));
    let inbox_reopened = store
        .pending_inbox_title("inbox")
        .expect("pending inbox")
        .expect("reopened inbox");
    assert_eq!(inbox_reopened.generation, inbox_first.generation);
    store
        .desire_inbox_title("inbox", "1 task running")
        .expect("newer inbox title");
    assert!(
        !store
            .redesire_title(&inbox_reopened)
            .expect("stale inbox redesire")
    );
    assert_eq!(
        store
            .pending_inbox_title("inbox")
            .expect("pending inbox")
            .expect("newer inbox preserved")
            .generation,
        inbox_first.generation + 1
    );
}

#[test]
fn a_new_work_instruction_persists_across_reopen() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("fixture store");
    let mut task = task("merge-recovery", "fixture#1");
    store.create(&task, &event("admitted")).unwrap();
    let prior = row(&store, "merge-recovery");
    let instruction = "Rebase the existing branch";
    task.command(
        Command::MoveWork {
            instruction: instruction.into(),
        },
        &Authority::Operator {
            actor: "operator".into(),
        },
        &observation(),
    )
    .unwrap();
    store.save_row(&prior, &task, &event("owner_move")).unwrap();
    drop(store);
    let reopened = Store::open(&storage).expect("reopen the store");
    let current = row(&reopened, "merge-recovery");
    assert_eq!(current.version, prior.version + 1);
    assert_eq!(current.number, prior.number);
    assert_eq!(current.task.work_instruction(), Some(instruction));
}

#[test]
fn dependency_edges_survive_reopen() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("fixture store");
    let first = task("first", "fixture#first");
    assert_eq!(store.create(&first, &event("admitted")).unwrap(), 1);
    let second = task("second", "fixture#second");
    assert_eq!(
        store
            .create_with_facts(
                &second,
                &event("admitted"),
                nucleus_store::TaskAdmissionFacts {
                    prerequisites: &["first".into()],
                    ..Default::default()
                }
            )
            .unwrap(),
        2,
    );
    drop(store);

    let store = Store::open(&storage).expect("reopen dependency edges");
    assert_eq!(
        store.dependencies("second").unwrap().before_dispatch,
        ["first"]
    );
    assert_eq!(store.dependents("first").unwrap(), [("second".into(), 1)]);
    assert!(store.dependency_blocked("second").unwrap());
    assert_eq!(store.history("first", None, 1).unwrap().len(), 1);
}

#[test]
fn prerequisite_waits_cannot_close_a_cycle() {
    let home = tempfile::tempdir().unwrap();
    let mut store = Store::open(&fixture_storage(home.path())).unwrap();
    for id in ["first", "second", "third"] {
        store.create(&task(id, id), &event("admitted")).unwrap();
    }
    let second = ["second".to_owned()];
    let third = ["third".to_owned()];
    let first = ["first".to_owned()];
    let wait = |ids| DependencyEdit::Wait {
        ids,
        reason: "publish the prerequisite",
    };
    let audit = event("dependencies_changed");
    let mut edit =
        |id, version, edit| store.edit_dependencies(id, version, edit, &audit, &mut |_| false);
    edit("first", 1, wait(&second)).unwrap();
    let error = edit("second", 1, wait(&first)).unwrap_err();
    assert!(
        matches!(error, StoreError::DependencyCycle { path } if path == ["second", "first", "second"])
    );
    edit("second", 1, DependencyEdit::BeforeDispatch(&third))
        .expect("a refused wait leaves the version unchanged");
    let error = edit("third", 1, wait(&first)).unwrap_err();
    assert!(
        matches!(error, StoreError::DependencyCycle { path } if path == ["third", "first", "second", "third"])
    );
    edit("first", 2, wait(&[])).unwrap();
    edit("third", 1, wait(&first)).expect("clearing the first wait removes the cycle");
    assert!(store.dependencies("second").unwrap().wait.is_none());
    assert_eq!(
        store.dependencies("third").unwrap().wait.unwrap().ids,
        first
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
                .with_author_declaration(nucleus_core::AuthorDeclaration {
                    models: vec!["fixture/author-model".into()],
                    github_author: "fixture-author".into(),
                    authoring_system: "fixture".into(),
                    attested_by: "operator".into(),
                    provenance: "Fixture evidence.".into(),
                })
                .unwrap()
        }
    };
    let _ = task.reconcile(&observation);
    store.create(&task, &event("admitted")).expect("admit");
    let row = row(store, id);
    assert_eq!(row.task.review_author(), task.review_author());
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
            scratch: None,
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
    assert_eq!(
        store.profile_usage().expect("usage"),
        nucleus_store::ProfileUsage::default()
    );
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
    let usage = store.profile_usage().expect("usage");
    assert_eq!(usage.recent.sample, 50);
    assert_eq!(usage.worker.counts["greeting"], 50);
    assert_eq!(usage.reviewer.counts["greeting"], 2);
    assert_eq!(usage.totals["greeting"], 54);
    assert_eq!(usage.group_totals[group], 54);
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
fn restore_checks_the_digest_of_each_stored_brief() {
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    let mut store = Store::open(&storage).unwrap();
    let healthy = task("healthy", "fixture#1");
    store.create(&healthy, &event("admitted")).unwrap();
    store
        .create(&task("damaged", "fixture#2"), &event("admitted"))
        .unwrap();
    drop(store);
    let db = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
    db.execute(
        "UPDATE tasks SET brief=json_set(brief, '$.text', 'Different text') WHERE id='damaged'",
        [],
    )
    .unwrap();
    drop(db);
    let reopened = Store::open(&storage).unwrap();
    let listing = reopened.list().unwrap();
    assert_eq!(listing.readable[0].task, healthy);
    assert_eq!(listing.unreadable[0].identity.id, "damaged");
    assert_eq!(reopened.get("healthy").unwrap(), Some(healthy));
    let Err(StoreError::UnreadableTask(error)) = reopened.get("damaged") else {
        panic!("expected a brief integrity error");
    };
    assert!(
        error
            .cause
            .contains("stored brief digest does not match the text for task damaged")
    );
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
    assert!(matches!(store.get("1"), Err(StoreError::UnreadableTask(_))));
}

#[test]
fn configure_refuses_a_stale_revision_and_preserves_retention_on_retry() {
    let home = tempfile::tempdir().unwrap();
    let cli = SettingsFile::open(home.path()).unwrap();
    let stale = cli.read::<EngineSettings>().unwrap();
    let board = SettingsFile::open(home.path()).unwrap();
    board
        .edit::<EngineSettings>(&stale.revision, |settings| {
            settings.retention.keep_newest = 17;
            Ok(())
        })
        .unwrap();
    let enable = |settings: &mut EngineSettings| settings.enabled = true;
    assert!(matches!(
        cli.configure(&stale, enable),
        Err(StorageError::SettingsConflict)
    ));
    let current = cli.read::<EngineSettings>().unwrap();
    assert!(!current.value.enabled);
    cli.configure(&current, enable).unwrap();
    let saved = board.load().unwrap();
    assert!(saved.enabled);
    assert_eq!(saved.retention.keep_newest, 17);
}

#[test]
fn saving_settings_creates_no_storage_roots() {
    let root = tempfile::tempdir().expect("scratch directory");
    let home = root.path().canonicalize().expect("canonical home");
    let file = SettingsFile::open(&home).expect("open empty fixture home");
    assert_eq!(file.load().expect("defaults"), EngineSettings::default());
    assert!(matches!(file.storage(), Err(StorageError::Disabled)));
    let settings = EngineSettings {
        enabled: true,
        ..EngineSettings::default()
    };
    file.save(&settings).expect("publish versioned settings");
    assert_eq!(file.load().expect("read settings back"), settings);
    let storage = file.storage().expect("resolve roots");
    assert_eq!(storage.work().path(), home.join("work"));
    assert!(!storage.database().path().exists());
    assert!(!storage.scratch().path().exists());
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
            "provider": "codex", "model": "fixture-model", "effort": "high"
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
    let path = home.join("config/profiles.json");
    let document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).expect("published settings"))
            .expect("versioned JSON");
    assert_eq!(document["schemaVersion"], 2);
    let reopened = SettingsFile::open(&home).expect("reopen settings");
    let loaded = reopened.read::<Profiles>().expect("load profiles");
    assert_eq!(loaded.value, first.value);
    let (saved, changed) = reopened
        .edit::<Profiles>(&loaded.revision, |profiles| {
            profiles.profiles[0].name = "Renamed".into();
            Ok(())
        })
        .expect("rename profile");
    assert!(changed);
    assert_eq!(saved.value.profiles[0].selection.id, "stable-profile");
    let written: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        written["value"],
        serde_json::to_value(&saved.value).unwrap()
    );
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

/// Load the rows a schema 14 engine wrote.
fn schema_fourteen(storage: &EngineStorage) -> Connection {
    let db = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
    db.execute_batch(include_str!("fixtures/schema-14.sql"))
        .unwrap();
    db
}

fn stored_version(db: &Connection) -> i32 {
    db.pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn prompt(delivery: &nucleus_store::ParentDelivery) -> String {
    let wire: serde_json::Value = serde_json::from_str(&delivery.wire).unwrap();
    wire["payload"]["text"].as_str().unwrap().into()
}

#[test]
fn a_database_older_than_schema_fourteen_is_refused_by_name_and_left_untouched() {
    for version in [1, 13] {
        let home = tempfile::tempdir().unwrap();
        let storage = fixture_storage(home.path());
        let db = schema_fourteen(&storage);
        db.execute_batch("ALTER TABLE tasks DROP COLUMN merge_hold")
            .unwrap();
        db.pragma_update(None, "user_version", version).unwrap();
        drop(db);
        let path = storage.database().path().join("engine.sqlite");
        let before = std::fs::read(&path).unwrap();

        let error = Store::open(&storage).err().expect("refused");

        assert!(
            matches!(error, StoreError::SchemaTooOld { version: found } if found == version),
            "{error:?}"
        );
        assert_eq!(
            error.to_string(),
            format!(
                "the engine database is schema {version}. This engine opens schema 14 or later"
            )
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!storage.backup().path().exists());
    }
}

/// The row a manual refresh left behind. It stays stored and is never read.
fn stored_refresh(db: &Connection) -> (String, i64, String) {
    db.query_row(
        "SELECT command, due_ms, result FROM parent_refresh_deliveries WHERE task_id='live'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .unwrap()
}

#[test]
fn a_schema_fourteen_database_upgrades_with_its_rows() {
    use nucleus_store::ParentResult::{Accepted, Pending};

    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    drop(schema_fourteen(&storage));

    let mut store = Store::open(&storage).expect("upgrade");

    let db = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
    assert_eq!(stored_version(&db), 16);
    let live = row(&store, "live");
    assert_eq!((live.version, live.number), (1, Some(1)));
    assert_eq!(
        live.task.merge_hold().unwrap().reason,
        "Verify the candidate"
    );
    assert_eq!(
        store.completion_notices("done").unwrap(),
        [nucleus_store::CompletionNotice {
            watcher: None,
            retry: false,
        }]
    );
    assert!(store.watch_task("live", "watcher", 1).unwrap().unwrap().1);
    assert_eq!(
        store
            .lane("synthetic", "delivery")
            .unwrap()
            .unwrap()
            .version,
        1
    );

    let hold = store.current_parent_hold("live").unwrap().unwrap();
    assert_eq!(hold.command, "current-hold");
    assert_eq!((hold.due_ms, hold.result), (200, Pending));
    assert_eq!(prompt(&hold), "Starting reviewer");
    assert!(store.pending_parent_preparation("live", 1).unwrap());
    let refresh = ("current-refresh".to_owned(), 300, "accepted".to_owned());
    assert_eq!(stored_refresh(&db), refresh);

    let backup = std::fs::read_dir(storage.backup().path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("engine-before-v14-")
        })
        .expect("verified pre-upgrade backup");
    let copy =
        Connection::open_with_flags(backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(stored_version(&copy), 14);

    // Later hold writes leave the stored refresh alone.
    let replacement = nucleus_store::ParentDelivery {
        version: 1,
        command: "replacement".into(),
        wire: hold.wire.clone(),
        due_ms: 789,
        result: Pending,
    };
    assert!(!store.freeze_parent_delivery("live", &hold).unwrap());
    assert!(store.freeze_parent_delivery("live", &replacement).unwrap());
    assert!(!store.freeze_parent_delivery("live", &replacement).unwrap());
    assert!(matches!(
        store.finish_parent_delivery("live", 1, &hold, Accepted, 0),
        Err(StoreError::StaleTask)
    ));
    assert_eq!(stored_refresh(&db), refresh);
    assert!(
        db.execute(
            "INSERT INTO parent_deliveries SELECT * FROM parent_deliveries",
            []
        )
        .is_err()
    );
    drop(store);
    let reopened = Store::open(&storage).expect("reopen the upgraded store");
    assert_eq!(
        reopened
            .current_parent_hold("live")
            .unwrap()
            .unwrap()
            .command,
        "replacement"
    );
}

#[test]
fn a_schema_fifteen_database_keeps_its_notices_per_recipient() {
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    let db = schema_fourteen(&storage);
    db.execute_batch(
        "DROP TABLE completion_notices;
         CREATE TABLE completion_notices (
            task_id TEXT NOT NULL REFERENCES tasks(id),
            recipient TEXT NOT NULL,
            retry INTEGER CHECK (retry IN (0,1)),
            PRIMARY KEY (task_id, recipient)
         ) STRICT;
         INSERT INTO completion_notices VALUES ('done', '', 1), ('done', 'watcher', 0);
         PRAGMA user_version = 15;",
    )
    .unwrap();

    let store = Store::open(&storage).expect("upgrade");

    assert_eq!(stored_version(&db), 16);
    assert_eq!(
        store.completion_notices("done").unwrap(),
        [
            nucleus_store::CompletionNotice {
                watcher: None,
                retry: true,
            },
            nucleus_store::CompletionNotice {
                watcher: Some("watcher".into()),
                retry: false,
            },
        ]
    );
    assert_eq!(
        store.current_parent_hold("live").unwrap().unwrap().command,
        "current-hold"
    );
}

#[test]
fn a_stored_delivery_without_a_frozen_wire_is_never_read_and_gives_way() {
    use nucleus_store::{ParentDelivery, ParentResult};

    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    drop(schema_fourteen(&storage));
    let store = Store::open(&storage).expect("upgrade");
    let command = "thread:nucleus-synthetic-hold-acp-0:nucleus";
    assert!(store.current_parent_hold("unframed").unwrap().is_none());
    assert!(!store.pending_parent_preparation("unframed", 1).unwrap());

    // The same row as an earlier schema 16 engine carried it forward.
    let db = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
    db.execute_batch("DELETE FROM parent_deliveries WHERE task_id='unframed'")
        .unwrap();
    db.execute(
        "INSERT INTO parent_deliveries (task_id, version, command, legacy_prompt, due_ms, result)
         VALUES ('unframed', 1, ?1, 'Starting worker', 400, 'pending')",
        [command],
    )
    .unwrap();
    assert!(store.current_parent_hold("unframed").unwrap().is_none());
    assert!(!store.pending_parent_preparation("unframed", 1).unwrap());

    let wire = store.current_parent_hold("live").unwrap().unwrap().wire;
    let next = ParentDelivery {
        version: 1,
        command: command.into(),
        wire,
        due_ms: 500,
        result: ParentResult::Pending,
    };
    assert!(store.freeze_parent_delivery("unframed", &next).unwrap());
    let stored = store.current_parent_hold("unframed").unwrap().unwrap();
    assert_eq!((stored.wire, stored.due_ms), (next.wire, 500));
}

#[test]
fn retention_keeps_other_tasks_and_remembers_its_interval_and_archive_attempts() {
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    let mut store = Store::open(&storage).unwrap();
    for id in ["active", "finished"] {
        store.create(&task(id, id), &event("admitted")).unwrap();
    }
    let conn = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
    conn.execute_batch(r#"UPDATE tasks SET threads='{"worker":"shared","reviewer":"review"}',phase='done' WHERE id='finished';
    UPDATE tasks SET threads='{"worker":"shared"}',origin_thread='planner' WHERE id='active';"#).unwrap();
    store
        .desire_title("finished", "parent", "Finished")
        .unwrap();
    assert_eq!(
        store
            .prune_owners()
            .unwrap()
            .into_keys()
            .collect::<Vec<_>>(),
        ["parent", "review"]
    );
    assert!(
        store
            .start_housekeeping("archived_threads", 100, 12)
            .unwrap()
    );
    for _ in 0..4 {
        assert!(store.claim_thread_prune("parent", 71).unwrap());
    }
    store.finish_housekeeping("archived_threads").unwrap();
    drop(store);
    let reopened = Store::open(&storage).unwrap();
    assert!(
        !reopened
            .start_housekeeping("archived_threads", 111, 12)
            .unwrap()
    );
    assert!(
        reopened
            .start_housekeeping("archived_threads", 112, 12)
            .unwrap()
    );
    assert!(!reopened.claim_thread_prune("parent", 71).unwrap());
    assert!(reopened.claim_thread_prune("parent", 120).unwrap());
}

#[test]
fn retention_partial_batches_survive_restart_and_finish_inside_the_interval() {
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    let interval = 12 * 3_600_000;
    for now in [1000, 31_000, 61_000] {
        let store = Store::open(&storage).unwrap();
        assert!(
            store
                .start_housekeeping("archived_threads", now, interval)
                .unwrap()
        );
        assert!(
            !store
                .start_housekeeping("archived_threads", now + 29_999, interval)
                .unwrap()
        );
    }
    let store = Store::open(&storage).unwrap();
    store.finish_housekeeping("archived_threads").unwrap();
    assert!(
        !store
            .start_housekeeping("archived_threads", 91_000, interval)
            .unwrap()
    );
    assert!(
        store
            .start_housekeeping("archived_threads", 61_000 + interval, interval)
            .unwrap()
    );
}

#[test]
fn scheduled_backup_restores_the_live_rows_and_rotates_verified_utc_tiers() {
    use flate2::read::MultiGzDecoder;
    use std::{fs, io, os::unix::fs::MetadataExt};
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    let mut store = Store::open(&storage).unwrap();
    store
        .create(&task("kept", "project#1"), &event("created"))
        .unwrap();
    let archives = EngineStorage::scheduled_directory(home.path(), storage.backup()).unwrap();
    archives.ensure().unwrap();
    let root = archives.path();
    let list = || {
        fs::read_dir(root)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect::<Vec<_>>()
    };
    // Existing TS recovery points participate only in their exact owned filename tiers.
    for n in 1..=28 {
        for tier in ["hourly", "daily", "weekly"] {
            fs::write(root.join(format!("2026-09-{n:02}T00-00-00-000Z-00000000-0000-4000-8000-000000000000.{tier}.sqlite.gz")),b"legacy fixture").unwrap();
        }
    }
    let foreign = root.join("operator.hourly.sqlite.gz");
    fs::write(&foreign, b"keep").unwrap();
    let at = 1_795_612_000_000;
    let capture = |ms| Store::scheduled_backup(storage.database(), &archives, ms).unwrap();
    capture(at);
    let files = list();
    for (tier, keep) in [("hourly", 24), ("daily", 14), ("weekly", 8)] {
        assert_eq!(
            files
                .iter()
                .filter(|p| p != &&foreign
                    && p.to_string_lossy().ends_with(&format!(".{tier}.sqlite.gz")))
                .count(),
            keep
        );
    }
    let recent: Vec<_> = files
        .iter()
        .filter(|p| p.file_name().unwrap().to_string_lossy().contains("-rust-"))
        .collect();
    assert_eq!(recent.len(), 3);
    assert!(
        recent
            .iter()
            .all(|p| p.metadata().unwrap().ino() == recent[0].metadata().unwrap().ino())
    );
    let restored = tempfile::NamedTempFile::new_in(home.path()).unwrap();
    let mut decoder = MultiGzDecoder::new(fs::File::open(recent[0]).unwrap());
    io::copy(&mut decoder, &mut restored.reopen().unwrap()).unwrap();
    let copy =
        Connection::open_with_flags(restored.path(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    assert_eq!(
        copy.query_row("select id from tasks", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "kept"
    );
    assert_eq!(
        copy.pragma_query_value(None, "integrity_check", |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    capture(at + 6 * 3_600_000 - 1);
    assert_eq!(list().len(), files.len());
    capture(at + 6 * 3_600_000);
    assert_eq!(storage.scheduled_list().unwrap().verified.len(), 2);
    assert_eq!(fs::read(foreign).unwrap(), b"keep");
}
