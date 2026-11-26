use nucleus_store::planning::{
    DecisionAnswerInput, DecisionInput, DecisionKind, DecisionOption, DecisionTarget, Horizon,
    ItemContent, ItemDisposition, ItemKind, ItemSource, ItemState, LaneDocument, Plan, PlanLane,
    RecordKind, WriteAt,
};

use super::*;

const STAMP: WriteAt<'_> = WriteAt {
    actor: "planner",
    at_ms: 10,
};

#[test]
fn plan_write_checks_completion_criteria_and_keeps_the_last_valid_order() {
    let scratch = tempfile::tempdir().expect("scratch");
    let mut store = Store::open(&fixture_storage(scratch.path())).expect("store");
    store
        .put_lane(
            "project",
            "delivery",
            0,
            LaneDocument {
                title: "Delivery".into(),
                aim: "Ship".into(),
                document: String::new(),
            },
            STAMP,
        )
        .expect("create lane");
    let mut plan = Plan {
        version: 0,
        lanes: vec![PlanLane {
            key: "delivery".into(),
            horizon: Horizon::Now,
            done_when: String::new(),
            status_note: "a long status note ".repeat(30),
        }],
    };
    plan = store
        .set_plan("project", plan, STAMP)
        .expect("empty criterion");
    plan.lanes[0].done_when = "📦".repeat(150);
    let saved = store
        .set_plan("project", plan, STAMP)
        .expect("exact boundary");
    for invalid in [
        format!("{}x", saved.lanes[0].done_when),
        "a\rb".into(),
        "a\nb".into(),
    ] {
        let mut changed = saved.clone();
        changed.lanes[0].done_when = invalid;
        assert!(matches!(
            store.set_plan("project", changed, STAMP),
            Err(StoreError::PlanningInput)
        ));
    }
    assert_eq!(store.plan("project").expect("read back"), saved);
}

#[test]
fn schema_seven_migrates_in_place() {
    let scratch = tempfile::tempdir().expect("scratch");
    let storage = fixture_storage(scratch.path());
    let mut store = Store::open(&storage).expect("store");
    let task = task("1", "fixture#1");
    store.create(&task, &event("admitted")).expect("admit");
    drop(store);

    let db = Connection::open(storage.database().path().join("engine.sqlite")).expect("fixture");
    db.execute_batch(
        "DROP TABLE task_numbers; DROP TABLE task_number_counters;
         DROP TABLE planning_record_clocks; DROP TABLE planning_task_sources; DROP TABLE planning_history; DROP TABLE planning_decisions;
         DROP TABLE planning_items; DROP TABLE planning_lanes; DROP TABLE planning_plans;
         DROP TABLE parent_deliveries; PRAGMA user_version = 7;",
    ).expect("restore version seven schema");
    let store = Store::open(&storage).expect("migrate version seven");
    assert_eq!(
        row(&store, "1"),
        TaskRow {
            task,
            version: 1,
            number: None
        }
    );
    assert_eq!(store.plan("example").expect("read new plan").version, 0);
}

#[test]
fn restored_pending_project_import_keeps_its_journal_and_fences_startup() {
    let scratch = tempfile::tempdir().expect("scratch");
    let storage = fixture_storage(scratch.path());
    let mut store = Store::open(&storage).expect("store");
    store
        .create(&task("1", "fixture#1"), &event("admitted"))
        .expect("admit");
    drop(store);

    let db = Connection::open(storage.database().path().join("engine.sqlite")).expect("fixture");
    let pending = r#"{"revision":"before-publication","registry":{"projects":{}}}"#;
    db.execute(
        "INSERT INTO legacy_project_import (singleton, pending) VALUES (1, ?1)",
        [pending],
    )
    .expect("interrupted publication");
    assert!(matches!(
        Store::open(&storage),
        Err(StoreError::ProjectImportPending)
    ));
    let saved: String = db
        .query_row("SELECT pending FROM legacy_project_import", [], |row| {
            row.get(0)
        })
        .expect("preserved journal");
    assert_eq!(saved, pending);

    db.execute("UPDATE legacy_project_import SET pending = NULL", [])
        .expect("fixture completed publication");
    let reopened = Store::open(&storage).expect("completed publication opens");
    assert_eq!(row(&reopened, "1").number, Some(1));
}

#[test]
fn promotion_rolls_back_on_task_conflict_and_retains_the_source() {
    let scratch = tempfile::tempdir().expect("scratch");
    let storage = fixture_storage(scratch.path());
    let mut store = Store::open(&storage).expect("store");
    let existing = task("1", "fixture#1");
    store
        .create(&existing, &event("admitted"))
        .expect("existing task");
    let lead = store
        .add_item(
            "project",
            "idea".into(),
            ItemKind::Lead,
            ItemContent {
                title: "A greeting".into(),
                body: existing.brief().text.clone(),
                lanes: vec![],
            },
            STAMP,
        )
        .expect("add lead");
    let source = ItemSource {
        project_id: "project".into(),
        item_id: lead.id,
    };
    let duplicate = task("2", "fixture#1");
    assert!(
        store
            .promote_item(&source, &duplicate, &event("admitted"), STAMP)
            .is_err()
    );
    assert!(store.get("2").expect("task read").is_none());
    assert_eq!(
        store
            .item("project", "idea")
            .expect("item read")
            .unwrap()
            .state,
        ItemState::Open
    );
    assert_eq!(
        store
            .planning_history("project", RecordKind::Item, "idea")
            .expect("item history")
            .len(),
        1
    );

    let admitted = task("3", "fixture#2");
    let (promoted, number) = store
        .promote_item(&source, &admitted, &event("admitted"), STAMP)
        .expect("promote");
    assert_eq!(number, 2);
    assert_eq!(
        promoted.state,
        ItemState::Promoted {
            task_id: "3".into()
        }
    );
    assert_eq!(store.task_source("3").expect("source read"), Some(source));
    assert_eq!(store.history("3", None, 5).expect("task history").len(), 1);
    assert_eq!(
        store
            .planning_history("project", RecordKind::Item, "idea")
            .expect("item history")
            .len(),
        2
    );
}

#[test]
fn legacy_duplicate_decision_labels_remain_answerable_by_id() {
    let scratch = tempfile::tempdir().expect("scratch");
    let storage = fixture_storage(scratch.path());
    let mut store = Store::open(&storage).expect("store");
    let input = DecisionInput {
        question: "Choose a route".into(),
        options: [
            ("first", "Same"),
            ("second", " Same "),
            ("third", "Third"),
            ("fourth", "Fourth"),
        ]
        .into_iter()
        .map(|(id, label)| DecisionOption {
            id: id.into(),
            label: label.into(),
        })
        .collect(),
    };
    assert!(matches!(
        store.add_decision("project", "new".into(), input.clone(), STAMP),
        Err(StoreError::DuplicateDecisionOptionLabel)
    ));
    assert!(store.decisions("project", false).unwrap().is_empty());
    drop(store);
    let snapshot = nucleus_store::planning::Decision {
        id: "legacy".into(),
        project_id: "project".into(),
        input: input.clone(),
        author: "planner".into(),
        created_at_ms: 10,
        answer: None,
        task: None,
        withdrawn: false,
    };
    let db = Connection::open(storage.database().path().join("engine.sqlite"))
        .expect("fixture database");
    db.execute(
        "INSERT INTO planning_decisions (project, id, snapshot) VALUES ('project', 'legacy', ?1)",
        [serde_json::to_string(&snapshot).unwrap()],
    )
    .unwrap();
    drop(db);
    let mut store = Store::open(&storage).expect("reopen legacy row");
    assert_eq!(store.decisions("project", true).unwrap(), [snapshot]);
    let answer = DecisionAnswerInput {
        option_id: "second".into(),
        note: None,
    };
    let result = store
        .answer_decision("project", "legacy", answer.clone(), STAMP)
        .unwrap();
    assert_eq!(result.input, input);
    assert_eq!(result.answer.unwrap().input, answer);
}

#[test]
fn task_decision_keeps_one_answer_and_hides_obsolete_questions() {
    let scratch = tempfile::tempdir().expect("scratch");
    let storage = fixture_storage(scratch.path());
    let mut store = Store::open(&storage).expect("store");
    let head = "a".repeat(40).parse().expect("head");
    let pr = PullRequest {
        url: "https://github.com/example/fixture/pull/1".into(),
        head,
    };
    let observed = Observation {
        forge: Observed::Known(Forge::Merged {
            pr: pr.clone(),
            commit: pr.head.clone(),
        }),
        ..observation()
    };
    let input = DecisionInput {
        question: "Accept the merge?".into(),
        options: [("accept", "Accept"), ("decline", "Decline")]
            .into_iter()
            .map(|(id, label)| DecisionOption {
                id: id.into(),
                label: label.into(),
            })
            .collect(),
    };
    for id in ["answered", "stale"] {
        let mut identity = task(id, id).identity().clone();
        identity.entry = Entry::ReviewEntry;
        let mut task = Task::new(identity, "Review entry.".into(), Some(pr.clone()));
        assert!(matches!(task.reconcile(&observed), Action::Ask(_)));
        store.create(&task, &event("admitted")).expect("task");
        let target = DecisionTarget {
            task_id: id.into(),
            task_version: 1,
            kind: DecisionKind::Question,
        };
        let decision = store
            .ensure_task_decision("project", target.clone(), input.clone(), STAMP)
            .expect("ensure");
        let repeated = store
            .ensure_task_decision("project", target.clone(), input.clone(), STAMP)
            .expect("ensure again");
        assert_eq!(decision, repeated);

        let answer = DecisionAnswerInput {
            option_id: "accept".into(),
            note: Some("Accepted.".into()),
        };
        if id == "answered" {
            let answered = store
                .answer_decision("project", &decision.id, answer.clone(), STAMP)
                .expect("answer");
            store
                .withdraw_task_decision("project", &target, STAMP)
                .expect("cleanup");
            assert_eq!(
                store.decision("project", &decision.id).expect("decision"),
                Some(answered)
            );
        } else {
            task.command(
                Command::Cancel,
                &Authority::Operator {
                    actor: "operator".into(),
                },
                &observed,
            )
            .expect("cancel");
            store
                .save_row(&row(&store, id), &task, &event("cancel"))
                .expect("cancel row");
        }
        assert!(matches!(
            store.answer_decision("project", &decision.id, answer, STAMP),
            Err(StoreError::PlanningConflict)
        ));
        assert!(
            store
                .decisions("project", true)
                .expect("pending")
                .is_empty()
        );
    }
}

#[test]
fn retained_history_preserves_item_times_and_edit_versions() {
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    let mut store = Store::open(&storage).unwrap();
    let body = |v: u32| ItemContent {
        title: format!("Item {v}"),
        body: "details".into(),
        lanes: vec![],
    };
    store
        .add_item("project", "i".into(), ItemKind::Papercut, body(0), STAMP)
        .unwrap();
    let mut last = 0;
    for v in 1..=25 {
        last = store
            .edit_item(
                "project",
                "i",
                body(v),
                None,
                WriteAt {
                    at_ms: 100 + u64::from(v),
                    ..STAMP
                },
            )
            .unwrap()
            .version;
    }
    // A byte-identical final write still advances the editor's optimistic revision.
    let saved = store
        .edit_item(
            "project",
            "i",
            body(25),
            Some(last),
            WriteAt {
                at_ms: 300,
                ..STAMP
            },
        )
        .unwrap();
    let now = 60 * 86_400_000;
    assert_eq!(
        Store::compact_planning_history(storage.database(), saved.version, now).unwrap(),
        7
    );
    assert_eq!(
        Store::compact_planning_history(storage.database(), saved.version, now).unwrap(),
        0
    );
    drop(store);
    let mut store = Store::open(&storage).unwrap();
    let current = store.items_with_times("project").unwrap().pop().unwrap();
    assert_eq!(
        (
            current.created_at_ms,
            current.updated_at_ms,
            current.version
        ),
        (Some(10), Some(300), saved.version)
    );
    assert!(matches!(
        store.edit_item("project", "i", body(26), Some(last), STAMP),
        Err(StoreError::PlanningConflict)
    ));
    let next = store
        .edit_item("project", "i", body(26), Some(saved.version), STAMP)
        .unwrap();
    assert!(next.version > saved.version);
}

#[test]
fn config_inventory_recognizes_only_real_schema_backup_files() {
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    storage.backup().ensure().unwrap();
    let root = storage.backup().path();
    let path = root.join("engine-before-v11-abc123.sqlite");
    let store = Store::open(&storage).unwrap();
    drop(store);
    std::fs::copy(storage.database().path().join("engine.sqlite"), &path).unwrap();
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "user_version", 11).unwrap();
    drop(db);
    assert_eq!(storage.backups().unwrap().issues, 0);
    std::fs::write(root.join("engine-before-v11-ABC123.sqlite"), b"unrelated").unwrap();
    assert_eq!(storage.backups().unwrap().issues, 1);
}

#[test]
fn compaction_uses_original_dates_and_the_verified_backup_boundary() {
    let home = tempfile::tempdir().unwrap();
    let storage = fixture_storage(home.path());
    let store = Store::open(&storage).unwrap();
    let db = Connection::open(storage.database().path().join("engine.sqlite")).unwrap();
    let now = 1_795_612_000_000_i64;
    for seq in 1..=25 {
        // First is a recent native edit, second is an old imported version
        // recorded today. The final two simulate writes after capture.
        let action = if seq == 2 { "legacy_version" } else { "put" };
        let snapshot = serde_json::json!({"version":seq,"createdAt":"2020-01-01T00:00:00Z"});
        let at_ms = if seq < 3 { now } else { 10 };
        db.execute(
            "INSERT INTO planning_history VALUES (?1,'project','lane','key','planner',?2,?3,?4)",
            rusqlite::params![seq, at_ms, action, snapshot.to_string()],
        )
        .unwrap();
    }
    assert_eq!(
        Store::compact_planning_history(storage.database(), 23, now.cast_unsigned()).unwrap(),
        2
    );
    let saved: Vec<_> = store
        .planning_history("project", RecordKind::Lane, "key")
        .unwrap()
        .into_iter()
        .map(|v| v.sequence)
        .collect();
    assert_eq!(saved, [vec![1], (4..=25).collect()].concat());
}

#[test]
fn reopen_retains_history_and_fences_stale_versions() {
    let scratch = tempfile::tempdir().expect("scratch");
    let mut store = Store::open(&fixture_storage(scratch.path())).expect("store");
    for (id, state) in [
        (
            "parked",
            ItemState::Parked {
                reason: "Later".into(),
                revisit_at: Some("2026-01-01".into()),
            },
        ),
        (
            "dropped",
            ItemState::Dropped {
                disposition: ItemDisposition::Completed,
                reason: Some("Done".into()),
            },
        ),
    ] {
        store
            .add_item(
                "project",
                id.into(),
                ItemKind::Papercut,
                ItemContent {
                    title: id.into(),
                    body: "Body".into(),
                    lanes: vec![],
                },
                STAMP,
            )
            .unwrap();
        let stale = store
            .items_with_times("project")
            .unwrap()
            .into_iter()
            .find(|i| i.item.id == id)
            .unwrap()
            .version;
        store.set_item_state("project", id, state, STAMP).unwrap();
        assert!(matches!(
            store.reopen_item("project", id, Some(stale), Some("Again"), STAMP),
            Err(StoreError::PlanningConflict)
        ));
        let version = store
            .items_with_times("project")
            .unwrap()
            .into_iter()
            .find(|i| i.item.id == id)
            .unwrap()
            .version;
        assert_eq!(
            store
                .reopen_item("project", id, Some(version), Some("Again"), STAMP)
                .unwrap()
                .state,
            ItemState::Open
        );
        let history = store
            .planning_history("project", RecordKind::Item, id)
            .unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(history[2].action, "reopen");
        assert_eq!(history[2].snapshot["note"], "Again");
        if id == "dropped" {
            assert_eq!(history[1].snapshot["disposition"], "completed");
        }
    }
}
