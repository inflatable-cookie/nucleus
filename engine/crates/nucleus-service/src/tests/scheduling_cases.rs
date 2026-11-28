use super::*;

#[tokio::test]
async fn full_checkout_budget_does_not_peek_at_t3() {
    let (_home, mut service) = fixture(GitHub::new("unused").unwrap());
    let (host, native) = native_fixture(|request| {
        panic!("queued checkout wait called T3: {}", request["tag"]);
    })
    .await;
    service.host = host;
    service.set_fixture_acp_provider("fixture-acp");
    service.state.lock().await.settings.dispatch = Some(nucleus_store::DispatchSettings {
        heavy_slots: 1,
        total_slots: 1,
        project_default_slots: 1,
        ..nucleus_store::DispatchSettings::default()
    });
    assert_eq!(checkouts(&service), 0, "the fresh profile has no checkouts");
    let head = &service.fixture().start;
    let checkout_repo = &service.fixture().checkout;
    let worktrees = service.worktrees();
    for id in ["first-owned", "second-owned"] {
        let (shape, _, observation) = reservation(id, Entry::Brief, head);
        let mut task = Task::new(shape.identity().clone(), "Fixture".into(), None);
        task.command(
            Command::Hold("Retain the checkout".into()),
            &Authority::Operator {
                actor: "fixture".into(),
            },
            &observation,
        )
        .unwrap();
        worktrees
            .checkout(checkout_repo, REPOSITORY, id)
            .unwrap()
            .allocate(head)
            .unwrap();
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        state.schedule.park(id);
    }
    let (shape, _, _) = reservation("queued", Entry::Brief, head);
    let queued = Task::new(shape.identity().clone(), "Fixture".into(), None);
    {
        let mut state = service.state.lock().await;
        assert_eq!(state.store.occupied_slots("").unwrap().total, 0);
        state
            .store
            .create_with_facts(
                &queued,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
    }
    for _ in 0..2 {
        let outcomes = service.pass().await.unwrap();
        assert!(matches!(
            outcomes.as_slice(),
            [PassOutcome {
                result: Ok(Action::Wait(WaitReason::Capacity)),
                ..
            }]
        ));
        let row = service.task("queued").await.unwrap();
        assert_eq!(row.task, queued);
        assert_eq!(row.version, 1);
        let mut state = service.state.lock().await;
        assert!(state.last_pass_calls.is_empty());
        state
            .schedule
            .wake("queued", Instant::now(), Priority::Wake);
    }
    assert!(service.host.host_calls().is_empty());
    native.abort();
}

#[tokio::test]
async fn paused_passes_leave_twenty_runless_rows_and_native_traffic_unchanged() {
    let (forge, forge_server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls"),
        get(|| async { Json(Vec::<Value>::new()) }),
    ))
    .await;
    let (_home, mut service) = fixture(forge);
    let (host, native_server) = native_fixture(|request| {
        panic!(
            "paused idle rows must make no native requests: {}",
            request["tag"]
        );
    })
    .await;
    service.host = host;
    let ids: Vec<_> = (0..20).map(|index| format!("paused-{index:02}")).collect();
    {
        let mut state = service.state.lock().await;
        state
            .settings
            .dispatch
            .get_or_insert_with(Default::default)
            .mode = DispatchMode::Paused;
        for id in &ids {
            let (mut task, _, mut observation) =
                reservation(id, Entry::Brief, &service.fixture().start);
            let instance = task.run().unwrap().launch().instance.clone();
            task.record_send(&instance, 2).unwrap();
            observation.host = Observed::Known(Host::Current {
                instance,
                state: nucleus_core::RunState::Gone,
            });
            assert_eq!(
                task.reconcile(&observation),
                Action::Relaunch(nucleus_core::Role::Worker)
            );
            assert!(task.run().is_none());
            assert!(task.threads().get(nucleus_core::Role::Worker).is_some());
            state
                .store
                .create_with_facts(
                    &task,
                    &event("fixture"),
                    nucleus_store::TaskAdmissionFacts::default(),
                )
                .unwrap();
        }
    }
    for _ in 0..2 {
        let mut count = 0;
        while count < ids.len() {
            let pass = service.pass().await.unwrap();
            count += pass.len();
            for outcome in pass {
                assert!(
                    matches!(outcome.result, Ok(Action::Wait(WaitReason::Capacity))),
                    "{}",
                    outcome.task
                );
            }
            assert!(service.state.lock().await.last_pass_calls.is_empty());
        }
        let mut state = service.state.lock().await;
        for id in &ids {
            assert_eq!(state.store.history(id, None, 10).unwrap().len(), 1);
            state.schedule.wake(id, Instant::now(), Priority::Wake);
        }
    }
    assert!(service.host.host_calls().is_empty());
    native_server.abort();
    forge_server.abort();
}

#[tokio::test]
async fn a_due_task_stays_queued_when_its_row_cannot_be_used() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let (task, _, _) = reservation("bad-scope", Entry::Brief, &service.fixture().start);
    let mut identity = task.identity().clone();
    identity.repository = "example/other".into();
    let task = Task::new(identity, "Fixture".into(), None);
    {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        state
            .schedule
            .wake("bad-scope", Instant::now(), Priority::Wake);
    }
    let outcomes = service.pass().await.unwrap();
    assert!(
        matches!(outcomes.as_slice(), [PassOutcome { task, result: Err(ServiceError::Project) }] if task == "bad-scope")
    );
    let mut state = service.state.lock().await;
    let due = state
        .schedule
        .due("bad-scope")
        .expect("failed task has a retry");
    assert!(due > Instant::now());
    assert_eq!(
        state
            .schedule
            .take_ready(due, &BTreeSet::new(), None)
            .unwrap()
            .id,
        "bad-scope"
    );
    assert_eq!(state.scheduler_error, None);
    assert!(state.last_pass_calls.is_empty());
}

#[tokio::test]
async fn recorded_role_send_time_does_not_extend_an_observation_outage() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let (mut task, _, _) = reservation("sent", Entry::Brief, &service.fixture().start);
    let instance = task.run().unwrap().launch().instance.clone();
    task.record_send(&instance, now_ms()).unwrap();
    let row = {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        service.lookup(&state, "sent").unwrap()
    };
    let deadline = Instant::now() + Duration::from_mins(2);
    for error in [
        HostError::Unavailable,
        HostError::Deferred { until: deadline },
        HostError::RoleReplyPending { until: deadline },
    ] {
        service
            .schedule_result(&row, &Err(ServiceError::Host(error)), Priority::Effect)
            .await
            .unwrap();
        let mut state = service.state.lock().await;
        let due = state.schedule.due("sent").unwrap();
        match error {
            HostError::Unavailable => assert!(due < deadline),
            _ => assert_eq!(due, deadline),
        }
        assert_eq!(
            state
                .schedule
                .take_ready(due, &BTreeSet::new(), None)
                .unwrap()
                .id,
            "sent"
        );
    }
}

#[tokio::test]
async fn done_archive_keeps_its_cause_and_respects_host_deferral() {
    let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
    service.set_fixture_acp_provider("fixture-acp");
    let (task, _, _) = reservation("archive", Entry::Brief, &service.fixture().start);
    let task = Task::new(task.identity().clone(), "Fixture".into(), None);
    let mut snapshot = serde_json::to_value(task).unwrap();
    snapshot["phase"] = json!("done");
    let task = serde_json::from_value(snapshot).unwrap();
    let row = {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        service.lookup(&state, "archive").unwrap()
    };
    let until = Instant::now() + Duration::from_mins(1);
    service
        .schedule_result(
            &row,
            &Err(ServiceError::Host(HostError::Deferred { until })),
            Priority::Effect,
        )
        .await
        .unwrap();
    let state = service.state.lock().await;
    assert_eq!(state.schedule.due("archive"), Some(until));
    assert!(
        matches!(state.wait_detail("archive"), Some(WaitDetail::Archive(cause)) if cause.contains("host deferred"))
    );
}

#[tokio::test]
async fn host_backoff_does_not_delay_a_local_task_decision() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let host = service.host.pass(service.storage.scratch().path());
    assert!(host.profile_catalog().await.is_err());
    assert!(service.host.request_retry_at().is_some());
    let (task, _, _) = reservation("local", Entry::Brief, &service.fixture().start);
    let task = Task::new(task.identity().clone(), "Fixture".into(), None);
    {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
    }
    service
        .command(
            "local",
            &Authority::Operator {
                actor: "fixture".into(),
            },
            Command::Cancel,
        )
        .await
        .unwrap();
    let outcomes = tokio::time::timeout(Duration::from_secs(2), service.pass())
        .await
        .expect("local work must not wait for T3")
        .unwrap();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].task, "local");
    assert_eq!(outcomes[0].result.as_ref().unwrap(), &Action::Nothing);
    assert!(service.state.lock().await.last_pass_calls.is_empty());
}
