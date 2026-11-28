use super::*;

#[tokio::test]
async fn an_equal_move_commits_a_revision_and_wakes_the_task() {
    let (_home, service) = registry_fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let (reserved, _, _) = reservation("worker", Entry::Brief, &service.fixture().start);
    let task = Task::new(reserved.identity().clone(), "Synthetic change".into(), None);
    seed_task(&service, &task).await;
    let mut changes = service.changes();
    assert!(service.state.lock().await.schedule.due("worker").is_none());
    let result = service
        .command(
            "worker",
            &Authority::Operator {
                actor: "operator".into(),
            },
            Command::Move(Phase::Queued),
        )
        .await
        .expect("equal move");
    assert_eq!(result.version, 2);
    assert_eq!(result.task, task);
    let change = changes.try_recv().expect("move invalidation");
    assert_eq!(change.version, 2);
    assert_eq!(change.task_id, "worker");
    let now = tokio::time::Instant::now();
    let mut state = service.state.lock().await;
    for id in ["refresh-a", "refresh-b"] {
        state.schedule.wake(
            id,
            now - std::time::Duration::from_secs(1),
            crate::schedule::Priority::Refresh,
        );
    }
    let next = state
        .schedule
        .take_ready(now, &std::collections::BTreeSet::new(), None)
        .expect("move wake");
    assert_eq!(next.id, "worker");
    assert_eq!(next.priority, crate::schedule::Priority::Wake);
}

#[tokio::test]
async fn done_permanently_revokes_the_writer_and_keeps_read_access() {
    let (_home, service) = registry_fixture(GitHub::new("fixture").expect("client"));
    let head = service.fixture().start.clone();
    seed_held_acceptance(&service, &head).await;
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
    );
    let binding = mint_binding(&api, "reviewer", &BOARD_KEY).await;
    let writer = binding.command_credential.expect("writer");
    let commands = "/v1/tasks/reviewer/commands";
    let task = service.task("reviewer").await.expect("reviewer");
    let forge = Observed::Known(Forge::Merged {
        pr: task.task.pull_request().expect("PR").clone(),
        commit: head.clone(),
    });
    service
        .observe_commands(&task, &forge)
        .await
        .expect("merge observation");
    assert_eq!(
        post_json(
            &api,
            commands,
            &BOARD_KEY,
            &json!({"answer":{"accept":{"head":head,"reason":"fixture acceptance"}}})
        )
        .await,
        StatusCode::OK
    );
    let task = service.task("reviewer").await.expect("accepted revision");
    service
        .observe_commands(&task, &forge)
        .await
        .expect("exact merge at accepted revision");
    assert_eq!(
        post_json(&api, commands, &BOARD_KEY, &json!({"move":"done"})).await,
        StatusCode::OK
    );
    assert_eq!(
        post_json(&api, commands, &writer, &json!("release")).await,
        StatusCode::UNAUTHORIZED
    );
    let detail = json_body(get_as(&api, "/v1/tasks/reviewer", &binding.credential).await).await;
    assert_eq!(detail["phase"], "done");
    assert_eq!(
        post_json(&api, commands, &BOARD_KEY, &json!({"move":"queued"})).await,
        StatusCode::OK
    );
    assert_eq!(
        post_json(&api, commands, &writer, &json!("release")).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn unlisted_done_threads_make_no_native_reads_after_restart() {
    let (_home, mut service) = registry_fixture(GitHub::new("fixture").expect("client"));
    let (host, native) = crate::tests::native_fixture(|_| {
        panic!("an archived task must not read T3 again");
    })
    .await;
    service.host = host;
    service.set_fixture_acp_provider(Some("fixture-acp"));
    let (mut row, _) = fixture_at_done(&service).await;
    assert_eq!(row.task.phase(), Phase::Done);
    service
        .host
        .fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1,"projects":[],"threads":[]
        }}));
    let service = Arc::new(service);
    let api = settings_api(&service);
    service
        .state
        .lock()
        .await
        .set_wait("reviewer", Some(WaitReason::Stopping));
    for path in ["/v1/tasks/reviewer", "/v1/tasks/reviewer/next"] {
        let view = json_body(get_as(&api, path, &BOARD_KEY).await).await;
        assert_eq!(view["phase"], "done");
        assert_eq!(view["wait"], Value::Null);
        assert_eq!(view["nextCheckAt"], Value::Null);
    }
    {
        let mut state = service.state.lock().await;
        assert_eq!(
            state
                .store
                .archive_due_ids(None, 8, true)
                .expect("pending archive"),
            ["reviewer"]
        );
        for kind in ["role_threads_archived", "display_note"] {
            row.version = crate::tests::save_row(&mut state.store, &row, &row.task, &event(kind))
                .expect("append history");
        }
        seed_cancelled_notice(&service, &mut state, &row.task);
    }
    // A cold held shell resolves the already archived or absent threads.
    let outcomes = service.pass().await.expect("queued pass");
    assert_eq!(outcomes.len(), 2);
    assert!(
        outcomes
            .iter()
            .all(|outcome| matches!(outcome.result, Ok(Action::Nothing)))
    );
    assert!(service.state.lock().await.last_pass_calls.is_empty());
    assert!(service.host.host_calls().is_empty());
    native.abort();
}

#[tokio::test]
async fn done_archive_wait_flows_into_the_shared_board_lifecycle() {
    let (_home, mut service) = registry_fixture(GitHub::new("fixture").unwrap());
    service.set_fixture_acp_provider(Some("fixture-acp"));
    let (done, _) = fixture_at_done(&service).await;
    let id = &done.task.identity().id;
    let cause = "The reviewer thread is still active in T3.";
    service
        .schedule_result(
            &done,
            &Err(ServiceError::ArchiveEvidence(cause.into())),
            crate::schedule::Priority::Effect,
        )
        .await
        .unwrap();
    let service = Arc::new(service);
    let api = settings_api(&service);
    let view = json_body(get_as(&api, &format!("/v1/tasks/{id}"), &BOARD_KEY).await).await;
    assert_eq!(view["phase"], "done");
    assert_eq!(view["stateLabel"], "Done");
    assert_eq!(view["wait"], "stopping");
    assert_eq!(view["waitDetail"], cause);
    assert_eq!(
        view["lifecycle"]["steps"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["note"],
        cause
    );
    let next = json_body(get_as(&api, &format!("/v1/tasks/{id}/next"), &BOARD_KEY).await).await;
    assert_eq!(next["waitDetail"], cause);
}
