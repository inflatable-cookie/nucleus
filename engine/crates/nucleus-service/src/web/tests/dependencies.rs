use nucleus_store::TaskRow;

use super::*;

const ADMIT: &str = "---\nqueue:\n  complexity: medium\n---\n\n# Fixture";

fn operator() -> Authority {
    Authority::Operator {
        actor: "fixture".into(),
    }
}

fn controller(service: Arc<Service>) -> Router {
    router(
        service,
        [
            Controller {
                credential: BOARD_KEY,
                authority: operator(),
            },
            planner_controller(PLANNER_KEY, "unrelated-planner"),
        ],
    )
}

async fn add(service: &Service, id: &str, brief: &str) -> TaskRow {
    service
        .admit(id.into(), id.into(), brief.into(), &operator())
        .await
        .unwrap()
}

#[tokio::test]
async fn an_unreadable_task_has_a_scoped_error_card_and_does_not_block_its_siblings() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let service = Arc::new(service);
    let api = controller(Arc::clone(&service));
    add(&service, "damaged", ADMIT).await;
    add(&service, "healthy", ADMIT).await;
    add(&service, "dependent", "---\nqueue:\n  complexity: medium\n  dependsOn: [inflatable-cookie/nucleus-fixture#1]\n---\n\n# Dependent").await;
    add(&service, "foreign", ADMIT).await;
    let db = rusqlite::Connection::open(service.storage.database().path().join("engine.sqlite"))
        .unwrap();
    db.execute(
        "UPDATE tasks SET brief=json_set(brief, '$.text', 'Changed') WHERE id='damaged'",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE tasks SET repository='example/foreign', brief=json_set(brief, '$.text', 'Changed') WHERE id='foreign'",
        [],
    ).unwrap();
    let cards = json_body(get_as(&api, "/v1/tasks", &BOARD_KEY).await).await;
    assert!(
        cards
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["identity"]["id"] != "foreign")
    );
    let card = |id: &str| {
        cards
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["identity"]["id"] == id)
            .unwrap()
    };
    assert_eq!(card("damaged")["phase"], "error");
    assert_eq!(card("damaged")["attention"], "attention");
    assert_eq!(card("damaged")["reference"], "nucleus-fixture#1");
    assert_eq!(card("healthy")["title"], "Fixture");
    assert_eq!(
        card("dependent")["dependencyStatus"]["dependencies"][0]["phase"],
        "error"
    );
    let host = service.host.pass(service.storage.scratch().path());
    let outcome = service
        .run_due_task("damaged", crate::schedule::Priority::Decision, &host)
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        Some(Err(ServiceError::Store(
            nucleus_store::StoreError::UnreadableTask(_)
        )))
    ));
    let next = service
        .run_due_task("dependent", crate::schedule::Priority::Decision, &host)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(next, Action::Wait(WaitReason::Prerequisite));
    assert!(service.task("healthy").await.is_ok());
}

#[tokio::test]
async fn dependencies_admit_resolve_and_edit_without_host_reads() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let service = Arc::new(service);
    let api = controller(Arc::clone(&service));
    let first = add(&service, "first", ADMIT).await;
    let brief = "---\nqueue:\n  complexity: medium\n  dependsOn: [inflatable-cookie/nucleus-fixture#001]\n---\n\n# Dependent";
    let dependent = add(&service, "dependent", brief).await;
    let detail = json_body(get_as(&api, "/v1/tasks/dependent", &BOARD_KEY).await).await;
    assert_eq!(detail["brief"]["text"], brief);
    assert_eq!(detail["wait"], "prerequisite");
    assert_eq!(detail["stateLabel"], "Queued · waiting for prerequisite");
    assert!(detail["stateSinceMs"].is_u64());
    assert_eq!(
        detail["dependencyStatus"]["dependencies"][0],
        json!({
            "taskId": "first", "reference": "nucleus-fixture#1", "title": "Fixture",
            "phase": "queued", "status": "pending",
        })
    );
    let view = json_body(get_as(&api, "/v1/tasks/dependent/next", &BOARD_KEY).await).await;
    assert_eq!(
        view["dependencyEdits"],
        json!({
            "setDependencies": true, "setPrerequisiteWait": false,
        })
    );
    expect_command(&view, "set_dependencies", None, "ready");
    let cards = json_body(get_as(&api, "/v1/tasks", &BOARD_KEY).await).await;
    assert_eq!(cards[0]["dependencyStatus"], detail["dependencyStatus"]);

    let host = service.host.pass(service.storage.scratch().path());
    assert_eq!(
        Box::pin(service.advance_due_task(&dependent, &host.for_task(&dependent.task, None)))
            .await
            .unwrap(),
        Action::Wait(WaitReason::Prerequisite),
    );
    let first_path = "/v1/tasks/first/commands";
    let cycle = json!({"set_dependencies":{"version":first.version,"depends_on":["#2"]}});
    assert_eq!(
        post_json(&api, first_path, &BOARD_KEY, &cycle).await,
        StatusCode::CONFLICT
    );
    assert_eq!(service.task("first").await.unwrap().version, first.version);

    let dependent_path = "/v1/tasks/dependent/commands";
    let clear = json!({"set_dependencies":{"version":dependent.version,"depends_on":[]}});
    assert_eq!(
        post_json(&api, dependent_path, &PLANNER_KEY, &clear).await,
        StatusCode::FORBIDDEN,
    );
    let same = json!({"set_dependencies":{"version":dependent.version,"depends_on":["#1"]}});
    assert_eq!(
        json_body(post_as(&api, dependent_path, &BOARD_KEY, &same).await).await["version"],
        dependent.version,
    );
    let mut changes = service.changes();
    service
        .command("first", &operator(), Command::Cancel)
        .await
        .unwrap();
    assert_eq!(changes.try_recv().unwrap().task_id, "dependent");
    let detail = json_body(get_as(&api, "/v1/tasks/dependent", &BOARD_KEY).await).await;
    assert_eq!(
        detail["dependencyStatus"]["dependencies"][0]["status"],
        "cancelled"
    );
    assert_eq!(detail["dependencyStatus"]["blocking"], true);
    assert_eq!(
        post_json(&api, dependent_path, &BOARD_KEY, &clear).await,
        StatusCode::OK
    );
    assert_eq!(
        post_json(&api, dependent_path, &BOARD_KEY, &clear).await,
        StatusCode::CONFLICT
    );
    let detail = json_body(get_as(&api, "/v1/tasks/dependent", &BOARD_KEY).await).await;
    assert_eq!(detail["dependencyStatus"]["blocking"], false);
    assert_eq!(detail["stateLabel"], "Queued");
    assert!(detail["stateSinceMs"].is_u64());
    assert_eq!(detail["brief"]["text"], brief);
}

#[tokio::test]
async fn prerequisite_wait_releases_once_and_preserves_reserved_run() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let service = Arc::new(service);
    let api = controller(Arc::clone(&service));
    let (running, _, _) = reservation("worker", Entry::Brief, &service.fixture().start);
    seed_task(&service, &running).await;
    add(&service, "prerequisite", ADMIT).await;
    let path = "/v1/tasks/worker/commands";
    assert_eq!(
        post_json(
            &api,
            path,
            &BOARD_KEY,
            &json!({
                "set_dependencies": {"version": 1, "depends_on": ["#2"]}
            })
        )
        .await,
        StatusCode::CONFLICT
    );
    let wait = json!({"set_prerequisite_wait":{
        "version":1, "waits_for":["nucleus-fixture#2"], "reason":"  publish the prerequisite  "
    }});
    assert_eq!(
        post_json(&api, path, &BOARD_KEY, &wait).await,
        StatusCode::OK
    );
    let parked = service.task("worker").await.unwrap();
    assert_eq!(parked.task.run(), running.run());
    assert!(!service.reconcile_prerequisites(&parked).await.unwrap());
    assert!(service.dependencies_blocked(&parked).await.unwrap());

    // This fixture changes the prerequisite's persisted phase under the same
    // service commit path used after a verified merge. The run under test is untouched.
    let completed = {
        let mut state = service.state.lock().await;
        let prior = state.store.row("prerequisite").unwrap().unwrap();
        let mut stored = serde_json::to_value(&prior.task).unwrap();
        stored["phase"] = json!("done");
        let done: Task = serde_json::from_value(stored).unwrap();
        service
            .commit(&mut state, &prior, &done, &event("fixture_done"), None)
            .unwrap()
    };
    assert_eq!(completed, 2);
    assert!(service.reconcile_prerequisites(&parked).await.unwrap());
    let released = service.task("worker").await.unwrap();
    assert_eq!(released.version, parked.version + 1);
    assert_eq!(released.task.run(), running.run());
    assert!(!service.reconcile_prerequisites(&released).await.unwrap());
    let detail = json_body(get_as(&api, "/v1/tasks/worker", &BOARD_KEY).await).await;
    assert_eq!(detail["dependencyStatus"]["blocking"], false);
    let wait = &detail["dependencyStatus"]["prerequisiteWait"];
    assert_eq!(wait["reason"], "publish the prerequisite");
    assert!(wait["releasedAtMs"].is_i64());
    assert_eq!(wait["prerequisites"][0]["status"], "satisfied");
    {
        let mut state = service.state.lock().await;
        let (version, notice) = state
            .store
            .pending_prerequisite_notice("worker")
            .unwrap()
            .unwrap();
        assert_eq!(notice.prerequisites, ["prerequisite"]);
        assert_eq!(notice.reason, "publish the prerequisite");
        let intent = event("prerequisite_notice_intent");
        assert!(
            state
                .store
                .claim_prerequisite_notice("worker", version, &intent)
                .unwrap()
        );
        assert!(
            !state
                .store
                .claim_prerequisite_notice("worker", version, &intent)
                .unwrap()
        );
        assert!(
            state
                .store
                .pending_prerequisite_notice("worker")
                .unwrap()
                .is_none()
        );
    }
    let history = service.history("worker", None, 20).await.unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|event| event.content.kind == "prerequisite_wait_released")
            .count(),
        1
    );
}

#[tokio::test]
async fn refreshed_finished_cards_follow_current_dependencies_and_same_version_board_events() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let service = Arc::new(service);
    let api = controller(Arc::clone(&service));
    add(&service, "first", ADMIT).await;
    add(
        &service,
        "dependent",
        "---\nqueue:\n  complexity: medium\n  dependsOn: ['#1']\n---\n# Follow",
    )
    .await;
    service
        .command("dependent", &operator(), Command::Cancel)
        .await
        .unwrap();
    let cards = async || json_body(get_as(&api, "/v1/tasks", &BOARD_KEY).await).await;
    let cold = cards().await;
    assert_eq!(cold[0]["identity"]["id"], "dependent");
    assert_eq!(
        cold[0]["dependencyStatus"]["dependencies"][0]["status"],
        "pending"
    );
    assert_eq!(cards().await, cold);

    service
        .command("first", &operator(), Command::Cancel)
        .await
        .unwrap();
    let changed = cards().await;
    assert_eq!(changed[0]["version"], cold[0]["version"]);
    assert_eq!(
        changed[0]["dependencyStatus"]["dependencies"][0]["status"],
        "cancelled"
    );
    let mut event = event("command");
    event.at = 123_456;
    {
        let mut state = service.state.lock().await;
        state.store.record_task_effect("dependent", &event).unwrap();
        state
            .store
            .record_board_entry("dependent", event.at)
            .unwrap();
    }
    let edited = cards().await;
    assert_eq!(edited[0]["version"], cold[0]["version"]);
    assert_eq!(edited[0]["latestEventAtMs"], event.at);
    assert_eq!(edited[0]["stateSinceMs"], event.at);
}
