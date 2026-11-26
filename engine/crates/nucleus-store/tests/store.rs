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
fn a_parent_retry_keeps_the_first_recorded_prompt() {
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    let mut store = Store::open(&storage).unwrap();
    store
        .create(&task("fixture", "fixture"), &event("admitted"))
        .unwrap();
    let mut append = |kind, command, prompt: Option<&str>| {
        let mut entry = event(kind);
        let mut detail = serde_json::json!({"command":command,"version":1,"session":"host"});
        if let Some(prompt) = prompt {
            detail["prompt"] = prompt.into();
        }
        entry.detail = detail.to_string();
        store.claim_task_effect("fixture", &entry, false).unwrap();
    };
    append("native_turn_intent", "legacy-hold", None);
    append("native_turn_replay", "legacy-hold", Some("Starting worker"));
    append(
        "native_turn_intent",
        "new-hold",
        Some("Starting reviewer round 2"),
    );
    append(
        "native_turn_replay",
        "new-hold",
        Some("Starting reviewer round 3"),
    );
    drop(store);

    revert_parent_schema(&storage);
    let store = Store::open(&storage).unwrap();
    let records = store.parent_deliveries("fixture", 1, None).unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].command, "new-hold");
    assert_eq!(
        records[0].legacy_prompt.as_deref(),
        Some("Starting reviewer round 2")
    );
    assert_eq!(records[1].command, "legacy-hold");
    assert_eq!(records[1].legacy_prompt, None);
}

#[test]
fn delivery_fences_follow_pending_attempts_across_reopen() {
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    let mut store = Store::open(&storage).unwrap();
    let mut versions = Vec::new();
    for id in [
        "completed",
        "first",
        "ambiguous",
        "later_send",
        "new_ambiguity",
        "legacy_without_claim",
        "legacy_unresolved",
        "legacy_refused",
        "failed",
        "no_attempt",
        "refused",
        "replacement_observed",
        "refused_replay",
        "refresh_pending",
    ] {
        store.create(&task(id, id), &event("admitted")).unwrap();
        let version = row(&store, id).version;
        versions.push((id, version));
        seed_delivery_fence(&mut store, id, version);
    }
    drop(store);
    revert_parent_schema(&storage);
    let store = Store::open(&storage).unwrap();
    for (id, version) in versions {
        use nucleus_store::ParentResult::{Held, Pending};
        let records = store.parent_deliveries(id, version, None).unwrap();
        let unsettled: Vec<_> = records
            .iter()
            .filter(|record| matches!(record.result, Pending | Held))
            .map(|record| (record.command.as_str(), record.result))
            .collect();
        let expected = match id {
            "ambiguous" | "legacy_unresolved" | "replacement_observed" | "refused_replay" => {
                vec![("thread-hold-1", Pending)]
            }
            "refresh_pending" => vec![("thread-refresh-1", Pending)],
            "later_send" => vec![("thread-hold-3", Pending)],
            "new_ambiguity" => vec![("", Held)],
            _ => vec![],
        };
        assert_eq!(unsettled, expected, "{id}");
        assert_eq!(
            store.pending_parent_preparation(id, version).unwrap(),
            !expected.is_empty() && id != "refresh_pending",
            "{id}"
        );
        assert!(!store.pending_parent_preparation(id, version + 1).unwrap());
        if id == "failed" {
            assert_eq!(records[0].result, nucleus_store::ParentResult::Failed);
        }
    }
}

fn seed_delivery_fence(store: &mut Store, id: &str, version: i64) {
    let mut append = |kind: &str, detail: serde_json::Value| {
        let mut entry = event(kind);
        entry.detail = detail.to_string();
        store.claim_task_effect(id, &entry, false).unwrap().unwrap()
    };
    let attempt = matches!(
        id,
        "completed"
            | "ambiguous"
            | "refused"
            | "legacy_unresolved"
            | "legacy_refused"
            | "replacement_observed"
            | "refused_replay"
            | "failed"
    )
    .then(|| {
        append(
            "native_turn_intent",
            serde_json::json!({
                "version":version, "session":"runtime", "command":"thread-hold-1",
            }),
        )
    });
    if !matches!(
        id,
        "legacy_without_claim" | "legacy_unresolved" | "legacy_refused" | "no_attempt"
    ) {
        append(
            "native_turn_not_sent",
            serde_json::json!({
                "version":version,
                "attempt": if id == "refused" { attempt } else { None },
                "session": if id == "refused" { "runtime" } else { "preflight" },
                "command": if matches!(id, "ambiguous" | "refused") { "thread-hold-1" } else { "thread-hold-2" },
            }),
        );
    }
    if id == "legacy_refused" {
        append(
            "native_turn_not_sent",
            serde_json::json!({"version":version,"session":"runtime","command":"thread-hold-1"}),
        );
    }
    if id == "later_send" {
        append(
            "native_turn_intent",
            serde_json::json!({
                "version":version, "session":"runtime", "command":"thread-hold-3",
            }),
        );
    }
    let mut blocked = serde_json::json!({"version":version,"session":"runtime/previous-engine"});
    if !id.starts_with("legacy_") {
        blocked["deliveryPending"] = serde_json::json!(id == "new_ambiguity");
    }
    append("host_observation_blocked", blocked);
    if id == "new_ambiguity" {
        append(
            "host_observation_blocked",
            serde_json::json!({
                "version":version, "session":"runtime/previous-engine", "deliveryPending":false,
            }),
        );
    }
    seed_delivery_outcomes(id, version, append);
}

fn seed_delivery_outcomes(
    id: &str,
    version: i64,
    mut append: impl FnMut(&str, serde_json::Value) -> i64,
) {
    if id == "completed" {
        append(
            "native_turn_observed",
            serde_json::json!({
                "version":version, "session":"runtime", "command":"thread-hold-1",
            }),
        );
        append(
            "native_turn_replay",
            serde_json::json!({
                "version":version, "session":"runtime", "command":"thread-hold-1",
            }),
        );
    }
    if id == "refresh_pending" {
        append(
            "acp_row_refresh_intent",
            serde_json::json!({"version":version,"session":"runtime","command":"thread-refresh-1"}),
        );
    }
    if id == "refused_replay" {
        let replay = append(
            "native_turn_replay",
            serde_json::json!({"version":version,"session":"runtime/later","command":"thread-hold-1"}),
        );
        append(
            "native_turn_not_sent",
            serde_json::json!({"version":version,"session":"runtime/later","command":"thread-hold-1","attempt":replay}),
        );
    }
    if id == "replacement_observed" {
        append(
            "native_turn_observed",
            serde_json::json!({"version":version,"session":"replacement","command":"thread-hold-1"}),
        );
        append(
            "native_turn_failed",
            serde_json::json!({"version":version,"session":"replacement/scope","command":"thread-hold-1"}),
        );
    }
    if id == "failed" {
        append(
            "native_turn_replay",
            serde_json::json!({"version":version,"session":"runtime/previous-engine","command":"thread-hold-1"}),
        );
        append(
            "native_turn_failed",
            serde_json::json!({"version":version,"session":"runtime/current-engine","command":"thread-hold-1"}),
        );
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
    assert_eq!(
        store.active_ids(None, 1).expect("first page"),
        [nucleus_store::TaskSeed {
            id: "1".into(),
            admission_order: None,
            closeout: true,
            queue_priority: nucleus_core::QueuePriority::Normal,
        }]
    );
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
        "DROP TABLE task_numbers; DROP TABLE task_number_counters;
         DROP TABLE planning_task_sources; DROP TABLE planning_history; DROP TABLE planning_decisions;
         DROP TABLE planning_items; DROP TABLE planning_lanes; DROP TABLE planning_plans;
         DROP TABLE task_titles; DROP TABLE inbox_bindings; DROP TABLE profile_assignments; DROP TABLE profile_assignment_totals;
         DROP TABLE acp_sessions; DROP INDEX occupied_launch_slots; DROP TABLE parent_deliveries; PRAGMA user_version = 2;",
    )
    .expect("restore version two schema");
    let store = Store::open(&storage).expect("migrate version two");
    assert_eq!(
        row(&store, "1"),
        TaskRow {
            task,
            version: 1,
            number: None
        }
    );
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

#[test]
fn migrating_version_nine_preserves_assigned_numbers_and_the_allocator() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("fixture store");
    let first = task("first", "fixture#first");
    assert_eq!(store.create(&first, &event("admitted")).expect("admit"), 1);
    drop(store);

    let db = Connection::open(storage.database().path().join("engine.sqlite"))
        .expect("fixture connection");
    db.execute_batch(
        "ALTER TABLE tasks DROP COLUMN report_task;
         ALTER TABLE tasks DROP COLUMN work_continuation;
         DROP TABLE inbox_titles;
         DROP TABLE parent_deliveries; PRAGMA user_version = 9;",
    )
    .expect("restore version nine schema with the allocator in place");
    drop(db);

    let mut store = Store::open(&storage).expect("migrate version nine");
    let restored = row(&store, "first");
    assert_eq!(restored.task, first);
    assert_eq!(restored.version, 1);
    assert_eq!(restored.number, Some(1));
    assert_eq!(store.history("first", None, 1).expect("history").len(), 1);
    let second = task("second", "fixture#second");
    assert_eq!(store.create(&second, &event("admitted")).expect("admit"), 2);
}

#[test]
fn migrating_version_ten_keeps_the_task_and_persists_a_new_work_instruction() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("fixture store");
    let mut task = task("merge-recovery", "fixture#1");
    store.create(&task, &event("admitted")).unwrap();
    drop(store);
    let db = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
    db.execute_batch("ALTER TABLE tasks DROP COLUMN queue_priority; ALTER TABLE tasks DROP COLUMN work_continuation; DROP TABLE parent_deliveries; PRAGMA user_version = 10;")
        .unwrap();
    drop(db);

    let mut store = Store::open(&storage).expect("migrate published schema");
    let backup = std::fs::read_dir(storage.backup().path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("engine-before-v10-")
        })
        .expect("verified pre-upgrade backup");
    let copy =
        Connection::open_with_flags(backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        copy.pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))
            .unwrap(),
        10
    );
    assert_eq!(
        copy.query_row("SELECT id FROM tasks", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "merge-recovery"
    );
    let prior = row(&store, "merge-recovery");
    assert_eq!(prior.task, task);
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
    let reopened = Store::open(&storage).expect("reopen migrated store");
    let current = row(&reopened, "merge-recovery");
    assert_eq!(current.version, prior.version + 1);
    assert_eq!(current.number, prior.number);
    assert_eq!(current.task.work_instruction(), Some(instruction));
}

#[test]
fn dependency_tables_open_from_the_previous_live_schema() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("fixture store");
    let first = task("first", "fixture#first");
    assert_eq!(store.create(&first, &event("admitted")).unwrap(), 1);
    drop(store);
    let db = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
    db.execute_batch(
        "DROP TABLE task_dependencies; DROP TABLE task_prerequisite_waits;
         DROP TABLE task_prerequisite_notices;
         DROP TABLE project_tell_deliveries; DROP TABLE project_tell_requests;
         DROP INDEX planning_usage_permission;
         ALTER TABLE tasks DROP COLUMN report_task; DROP TABLE inbox_titles;
         DROP TABLE parent_deliveries; PRAGMA user_version = 9;",
    )
    .unwrap();
    let version: i32 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 9);
    drop(db);

    let mut store = Store::open(&storage).expect("open previous schema directly");
    assert_eq!(row(&store, "first").number, Some(1));
    assert_eq!(
        store.dependencies("first").unwrap(),
        nucleus_store::Dependencies::default()
    );
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

#[test]
fn version_eleven_decodes_delivery_history_once() {
    let root = tempfile::tempdir().unwrap();
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).unwrap();
    for (id, result) in [
        ("unknown", "held"),
        ("live", "pending"),
        ("sent", "accepted"),
        ("preflight", "none"),
    ] {
        store.create(&task(id, id), &event("admitted")).unwrap();
        let version = row(&store, id).version;
        let mut append = |kind, detail: serde_json::Value| {
            let mut entry = event(kind);
            entry.detail = detail.to_string();
            store.claim_task_effect(id, &entry, false).unwrap();
        };
        if matches!(result, "pending" | "accepted") {
            append(
                "native_turn_intent",
                serde_json::json!({
                    "version":version,"session":"runtime","command":"legacy","prompt":"original"
                }),
            );
        }
        if result == "accepted" {
            append(
                "native_turn_observed",
                serde_json::json!({
                    "version":version,"session":"runtime","command":"legacy"
                }),
            );
        }
        append(
            "host_observation_blocked",
            serde_json::json!({
                "version":version,"session":"runtime/epoch","deliveryPending":result == "held"
            }),
        );
    }
    drop(store);
    revert_parent_schema(&storage);

    let store = Store::open(&storage).unwrap();
    for (id, result) in [
        ("unknown", Some(nucleus_store::ParentResult::Held)),
        ("live", Some(nucleus_store::ParentResult::Pending)),
        ("sent", Some(nucleus_store::ParentResult::Accepted)),
        ("preflight", None),
    ] {
        let version = row(&store, id).version;
        let deliveries = store.parent_deliveries(id, version, None).unwrap();
        assert_eq!(deliveries.first().map(|delivery| delivery.result), result);
        if let Some(first) = deliveries
            .first()
            .filter(|delivery| !delivery.command.is_empty())
        {
            assert_eq!(first.legacy_prompt.as_deref(), Some("original"));
        }
    }
    drop(store);
    let reopened = Store::open(&storage).unwrap();
    assert_eq!(
        reopened
            .parent_deliveries("live", row(&reopened, "live").version, None)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn schema_twelve_preserves_existing_snooze_ownership() {
    use nucleus_store::{RowSnooze, SnoozeOutcome};
    let root = tempfile::tempdir().unwrap();
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).unwrap();
    store
        .create(&task("row", "row"), &event("admitted"))
        .unwrap();
    let receipt = RowSnooze {
        episode: 1_000,
        until_ms: 900_000,
        previous_until_ms: None,
        outcome: SnoozeOutcome::Observed,
        clear_attempted_for: None,
        ended: false,
    };
    store.save_row_snooze("row", "parent", &receipt).unwrap();
    drop(store);
    revert_parent_schema(&storage);
    let migrated = Store::open(&storage).unwrap();
    assert_eq!(migrated.row_snooze("row", "parent").unwrap(), Some(receipt));
}

fn revert_parent_schema(storage: &EngineStorage) {
    let db = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
    db.execute_batch("ALTER TABLE tasks DROP COLUMN queue_priority; DROP TABLE parent_deliveries; PRAGMA user_version=11;")
        .unwrap();
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

#[test]
fn migrating_version_twelve_defaults_queue_priority_without_rewriting_rows() {
    let root = tempfile::tempdir().expect("scratch directory");
    let storage = fixture_storage(root.path());
    let mut store = Store::open(&storage).expect("fixture store");
    let legacy = task("legacy", "fixture#1");
    let promoted = Task::new(
        Identity {
            id: "promoted".into(),
            reference: "fixture#2".into(),
            repository: legacy.identity().repository.clone(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        "---\nqueue:\n  complexity: low\n  priority: promoted\n---\nPromoted brief".into(),
        None,
    );
    assert_eq!(
        promoted.queue_priority(),
        nucleus_core::QueuePriority::Promoted
    );
    store.create(&legacy, &event("admitted")).unwrap();
    store.create(&promoted, &event("admitted")).unwrap();
    let expected_rowid = store.admission_order("legacy").unwrap();
    drop(store);

    let db = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
    db.execute_batch("ALTER TABLE tasks DROP COLUMN queue_priority; PRAGMA user_version = 12;")
        .unwrap();
    drop(db);

    let store = Store::open(&storage).expect("migrate v12 to v13");
    let restored = row(&store, "legacy");
    assert_eq!(restored.task, legacy);
    assert_eq!(restored.version, 1);
    assert_eq!(store.admission_order("legacy").unwrap(), expected_rowid);
    assert_eq!(
        restored.task.queue_priority(),
        nucleus_core::QueuePriority::Normal
    );
    assert_eq!(
        store.active_ids(None, 10).unwrap(),
        [
            nucleus_store::TaskSeed {
                id: "legacy".into(),
                admission_order: Some(expected_rowid),
                closeout: false,
                queue_priority: nucleus_core::QueuePriority::Normal,
            },
            nucleus_store::TaskSeed {
                id: "promoted".into(),
                admission_order: Some(expected_rowid + 1),
                closeout: false,
                queue_priority: nucleus_core::QueuePriority::Normal,
            },
        ]
    );
}
