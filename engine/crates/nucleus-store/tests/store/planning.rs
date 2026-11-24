use nucleus_store::planning::{
    DecisionAnswerInput, DecisionInput, DecisionOption, DecisionTarget, ItemContent, ItemKind,
    ItemSource, ItemState, RecordKind, WriteAt,
};

use super::*;

const STAMP: WriteAt<'_> = WriteAt {
    actor: "planner",
    at_ms: 10,
};

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
         DROP TABLE planning_task_sources; DROP TABLE planning_history; DROP TABLE planning_decisions;
         DROP TABLE planning_items; DROP TABLE planning_lanes; DROP TABLE planning_plans;
         PRAGMA user_version = 7;",
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
            kind: Default::default(),
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
