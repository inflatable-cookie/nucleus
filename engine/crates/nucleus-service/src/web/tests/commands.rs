use super::*;

#[tokio::test]
async fn the_row_refresh_route_is_gone() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let (task, _, _) = reservation("worker", Entry::Brief, &service.fixture().start);
    seed_task(&service, &task).await;
    let api = router(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
    );
    let found = get_as(&api, "/v1/tasks/worker", &BOARD_KEY).await;
    assert_eq!(found.status(), StatusCode::OK);
    assert_eq!(
        post_json(&api, "/v1/tasks/worker/acp/refresh", &BOARD_KEY, &json!({})).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn only_a_shell_active_role_gets_the_legacy_hint_without_a_hold() {
    let (_home, service) = registry_fixture(GitHub::new("fixture").expect("client"));
    let (mut task, _, _) = crate::tests::reservation_at(
        "worker",
        Entry::Brief,
        &service.fixture().start,
        crate::now_ms(),
    );
    seed_task(&service, &task).await;
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
    let binding = mint_binding(&api, "worker", &BOARD_KEY).await;
    let detail = || get_as(&api, "/v1/tasks/worker", &binding.credential);
    let unsent = json_body(detail().await).await;
    assert!(unsent.get("parentHold").is_none());
    assert!(unsent.get("activeChild").is_none());

    let launch = task.run().unwrap().launch().clone();
    task.record_send(&launch.instance, 1).unwrap();
    {
        let mut state = service.state.lock().await;
        let row = service.lookup(&state, "worker").unwrap();
        crate::tests::save_row(&mut state.store, &row, &task, &event("sent")).unwrap();
    }
    let checkout = nucleus_work::checkout_path(
        service.storage.work().path(),
        &task.identity().repository,
        &task.identity().id,
    );
    service.host.fixture_project_shell(
        &json!({"projects":[],"threads":[{
            "id":launch.thread, "worktreePath":checkout,
            "status":"running","activeRunId":"native-worker", "pendingBackgroundTasks":[]
        }]}),
        "fixture-acp",
    );
    let active = json_body(detail().await).await;
    assert!(active.get("parentHold").is_none());
    assert_eq!(active["activeChild"], true);

    let write = T3::prepare_parent_hold(
        &Binding {
            project_id: "local-fixture".into(),
            worktree_path: checkout.to_str().unwrap().into(),
            branch: "fixture".into(),
        },
        "fixture-acp",
        "Fixture",
        "Starting worker",
        nucleus_hosts::ParentShell::Missing,
        None,
        nucleus_hosts::HoldCheckpoint {
            after_run: None,
            recorded_at_ms: crate::now_ms(),
            short_turns: 0,
            preparing_launch: false,
        },
    )
    .unwrap();
    let frozen = write.freeze();
    {
        let state = service.state.lock().await;
        let row = service.lookup(&state, "worker").unwrap();
        assert!(
            state
                .store
                .freeze_parent_delivery(
                    "worker",
                    &nucleus_store::ParentDelivery {
                        version: row.version,
                        command: write.command_id().unwrap().into(),
                        wire: serde_json::to_string(frozen).unwrap(),
                        due_ms: 0,
                        result: nucleus_store::ParentResult::Pending,
                    }
                )
                .unwrap()
        );
    }
    let held = json_body(detail().await).await;
    assert_eq!(held["parentHold"].as_str(), frozen.prompt());
    assert!(held.get("activeChild").is_none());

    service.state.lock().await.settings.dispatch = Some(nucleus_store::DispatchSettings {
        mode: nucleus_store::DispatchMode::Stopped,
        ..Default::default()
    });
    let stopped = json_body(detail().await).await;
    assert!(stopped.get("parentHold").is_none());
    assert!(stopped.get("activeChild").is_none());
}

#[tokio::test]
async fn shell_startup_does_not_invent_a_hold_for_a_bound_role() {
    let (_home, service) = registry_fixture(GitHub::new("fixture").expect("client"));
    let (mut task, _, _) = reservation("worker", Entry::Brief, &service.fixture().start);
    let instance = task.run().unwrap().launch().instance.clone();
    task.record_send(&instance, 1).unwrap();
    seed_task(&service, &task).await;
    let row = service.task("worker").await.unwrap();
    let mut state = service.state.lock().await;
    state.registry_mode = true;
    assert_eq!(service.acp_turn_view(&state, &row).unwrap(), (None, false));
    service
        .host
        .fixture_project_shell(&json!({"projects":[],"threads":[]}), "fixture-acp");
    assert_eq!(service.acp_turn_view(&state, &row).unwrap(), (None, false));
    assert!(service.host.host_calls().is_empty());
}

#[tokio::test]
async fn acp_credentials_are_scoped_and_rotation_closes_the_old_stream() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    for id in ["task-one", "task-two"] {
        let (task, _, _) = reservation(id, Entry::Brief, &service.fixture().start);
        seed_task(&service, &task).await;
    }
    let api = router(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
    );
    let path = "/v1/tasks/nucleus-fixture%231/acp";
    let mint = json_body(post_as(&api, path, &BOARD_KEY, &json!({})).await).await;
    assert!(mint["credential"].is_null());
    let file = std::path::Path::new(mint["bindingPath"].as_str().expect("binding path"));
    let binding: nucleus_core::acp::Binding =
        serde_json::from_slice(&std::fs::read(file).expect("pointer")).expect("binding");
    assert_eq!(
        binding.session_id,
        mint["sessionId"].as_str().expect("session ID")
    );
    assert_eq!(binding.task_id, "task-one");
    let key = &binding.credential;
    let writer = binding.command_credential.as_ref().expect("command key");
    for path in [
        "/v1/tasks/task-two",
        "/v1/tasks/nucleus-fixture%232",
        "/v1/events",
        "/v1/settings",
    ] {
        assert_eq!(
            get_as(&api, path, key).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        post_json(&api, path, key, &json!({})).await,
        StatusCode::UNAUTHORIZED
    );
    let read = json_body(get_as(&api, "/v1/tasks/task-one", key).await).await;
    assert_eq!(read["lifecycle"]["transcript"]["cards"], json!([]));
    assert_eq!(
        post_json(
            &api,
            "/v1/tasks/task-two/commands",
            writer,
            &json!("cancel")
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post_json(&api, "/v1/tasks/task-one/commands", key, &json!("cancel")).await,
        StatusCode::UNAUTHORIZED,
        "a read key cannot write"
    );
    let response = get_as(&api, "/v1/tasks/task-one/events", key).await;
    let mut events = response.into_body().into_data_stream();
    assert_event(&mut events, &["event: refresh"]).await;
    assert_eq!(
        post_json(
            &api,
            "/v1/tasks/task-two/commands",
            &BOARD_KEY,
            &json!("cancel")
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        post_json(
            &api,
            "/v1/tasks/nucleus-fixture%231/commands",
            writer,
            &json!("cancel")
        )
        .await,
        StatusCode::OK
    );
    assert_event(&mut events, &[r#""taskId":"task-one""#]).await;
    let rotated = json_body(post_as(&api, path, &BOARD_KEY, &json!({})).await).await;
    assert_eq!(rotated["sessionId"], mint["sessionId"]);
    assert_eq!(
        get_as(&api, "/v1/tasks/task-one", key).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), events.next())
            .await
            .expect("stream closes")
            .is_none()
    );
}

#[tokio::test]
async fn admission_commits_when_t3_is_unreachable() {
    let (_home, mut service, _planner_host) =
        enrolled_fixture(GitHub::new("unused-forge-fixture").expect("client")).await;
    let host = T3::new("http://127.0.0.1:9", "fixture").unwrap();
    host.fixture_project_shell(&json!({"projects":[{"id":"local-fixture", "workspaceRoot":service.fixture().checkout}], "threads":[]}), "fixture-acp");
    service.host = host;
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [planner_controller(PLANNER_KEY, "planner")],
    );
    let response = post_as(
        &api,
        "/v1/tasks",
        &PLANNER_KEY,
        &json!({
            "id":"fixture-admit", "reference":"fixture-admit", "brief":"---\nqueue:\n  complexity: low\n---\nImplement the brief"
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(json_body(response).await["phase"], "queued");
    let admitted = service.task("fixture-admit").await.expect("committed row");
    assert_eq!(admitted.version, 1);
    let mut pass = service.pass().await.expect("scheduled profile check");
    if pass
        .iter()
        .any(|outcome| matches!(outcome.result, Ok(Action::Advance(_))))
    {
        service.state.lock().await.schedule.wake(
            "fixture-admit",
            tokio::time::Instant::now(),
            crate::schedule::Priority::Wake,
        );
        pass = service.pass().await.expect("scheduled profile check");
    }
    assert!(
        matches!(
            pass.as_slice(),
            [crate::PassOutcome {
                result: Err(ServiceError::Host(nucleus_hosts::HostError::Unavailable)),
                ..
            }]
        ),
        "{:?}",
        pass.iter()
            .map(|outcome| (&outcome.task, &outcome.result))
            .collect::<Vec<_>>()
    );
    assert!(
        service
            .task("fixture-admit")
            .await
            .unwrap()
            .task
            .run()
            .is_none()
    );
}

#[tokio::test]
async fn activity_invalidates_only_on_a_change_and_cannot_cross_a_revision() {
    let (_home, service) = registry_fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let (task, _, _) = reservation("worker", Entry::Brief, &service.fixture().start);
    seed_task(&service, &task).await;
    let row = service.task("worker").await.expect("row");
    let authority = Authority::Operator {
        actor: "fixture".into(),
    };
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: authority.clone(),
        }],
    );
    let mut changes = service.changes();
    let activity = RunActivity {
        label: "Running Rust tests".into(),
        started_at: Some(1000),
    };
    service
        .observe_activity(&row, Some(activity.clone()))
        .await
        .expect("observe");
    let change = changes.try_recv().expect("invalidate");
    assert_eq!(change.version, row.version);
    assert!(change.detail_only);
    service
        .observe_activity(&row, Some(activity.clone()))
        .await
        .expect("repeat");
    assert!(matches!(
        changes.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    let running = Ok(Action::Wait(nucleus_core::WaitReason::Running));
    for _ in 0..3 {
        service
            .schedule_result(&row, &running, crate::schedule::Priority::Refresh)
            .await
            .unwrap();
    }
    let state_change = changes.try_recv().expect("first wait changes the card");
    assert!(!state_change.detail_only);
    assert!(
        changes.try_recv().is_err(),
        "repeating a pass with the same facts is quiet"
    );
    let path = "/v1/tasks/worker";
    let view = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(
        view["run"]["activity"],
        json!({"label":"Running Rust tests","startedAt":1000})
    );

    service
        .observe_activity(&row, None)
        .await
        .expect("unavailable activity");
    let change = changes.try_recv().expect("invalidate");
    assert_eq!(change.version, row.version);
    assert!(change.detail_only);
    let view = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert!(view["run"]["activity"].is_null());

    service
        .command("worker", &authority, Command::Cancel)
        .await
        .expect("cancel");
    assert!(matches!(
        service.observe_activity(&row, Some(activity)).await,
        Err(ServiceError::Store(nucleus_store::StoreError::StaleTask))
    ));
    let view = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(view["run"]["revoked"], true);
    assert!(view["run"]["activity"].is_null());
}

#[tokio::test]
async fn history_rebuilds_run_and_pr_presentation_without_replay_or_report_noise() {
    let (_home, service) = registry_fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let (task, key, mut observation) =
        reservation("worker", Entry::Brief, &service.fixture().start);
    let instance = task.run().expect("run").launch().instance.clone();
    seed_task(&service, &task).await;
    let mut row = service.task("worker").await.expect("row");
    let sent_at_ms = 1_790_000_000_000;
    let reported_at_ms = sent_at_ms + 831_000;
    let at = |kind, time| EventDraft {
        at: i64::try_from(time).unwrap(),
        ..event(kind)
    };
    for time in [sent_at_ms - 2_000, sent_at_ms] {
        let mut updated = row.task.clone();
        updated.record_send(&instance, time).expect("send marker");
        row = service
            .save(&row, updated, &at("host_send", time))
            .await
            .expect("persist send");
    }
    let pr = PullRequest {
        url: PR.into(),
        head: service.fixture().start.clone(),
    };
    let mut updated = row.task.clone();
    updated
        .record_report(
            &instance,
            key.as_bytes(),
            Report::Work(nucleus_core::WorkReport {
                pull_request: pr.clone(),
                summary: Some(
                    "Fixed the synthetic change.

"
                    .into(),
                ),
            }),
        )
        .expect("stage report");
    row = service
        .save(&row, updated.clone(), &at("reported", reported_at_ms))
        .await
        .expect("persist report");
    observation.host = Observed::Known(Host::Current {
        instance: instance.clone(),
        state: RunState::Ended,
    });
    observation.forge = Observed::Known(Forge::Open {
        pr,
        checks: CheckState::Ready,
    });
    assert_eq!(
        updated.reconcile(&observation),
        Action::Advance(Phase::Reviewing)
    );
    service
        .save(&row, updated, &event("phase_reconciled"))
        .await
        .expect("apply report");
    assert_working_transition(&service).await;
    service
        .state
        .lock()
        .await
        .set_wait("worker", Some(WaitReason::Capacity));
    let api = router(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
    );
    let history = json_body(get_as(&api, "/v1/tasks/worker/history", &BOARD_KEY).await).await;
    let thread = &task.run().unwrap().launch().thread;
    assert_worker_history(&history, &instance, thread, sent_at_ms);
    let detail = json_body(get_as(&api, "/v1/tasks/worker", &BOARD_KEY).await).await;
    let list = json_body(get_as(&api, "/v1/tasks", &BOARD_KEY).await).await;
    assert_worker_detail(&detail, &list, thread);
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one fixture trace covers a complete lifecycle"
)]
async fn reviewer_rounds_follow_applied_verdicts_across_launches() {
    let (_home, service) = registry_fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let head = service.fixture().start.clone();
    let (task, key, mut observation) = reservation("reviewer", Entry::ReviewEntry, &head);
    let first = task.run().expect("first review").launch().clone();
    seed_task(&service, &task).await;
    let mut row = service.task("reviewer").await.expect("row");
    for at in [1, 2] {
        let mut task = row.task.clone();
        task.record_send(&first.instance, at).expect("send marker");
        row = service
            .save(&row, task, &event("host_send"))
            .await
            .expect("persist send");
    }
    let mut task = row.task.clone();
    task.record_report(
        &first.instance,
        key.as_bytes(),
        Report::Review {
            head,
            decision: Review::Changes,
            summary: "Add a regression".into(),
            finding_titles: Vec::new(),
        },
    )
    .expect("stage verdict");
    row = service
        .save(&row, task.clone(), &event("reported"))
        .await
        .expect("persist report");
    observation.host = Observed::Known(Host::Current {
        instance: first.instance,
        state: RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    row = service
        .save(&row, task, &event("phase_reconciled"))
        .await
        .expect("apply verdict");

    let authority = Authority::Operator {
        actor: "fixture".into(),
    };
    let mut task = row.task.clone();
    task.command(Command::Move(Phase::Reviewing), &authority, &observation)
        .expect("reopen review");
    row = service
        .save(&row, task.clone(), &event("command"))
        .await
        .expect("persist move");
    observation.host = Observed::Known(Host::Retained {
        thread: first.thread.clone(),
        state: RetainedThread::Queueable,
    });
    task.reserve_grouped_launch(
        &observation,
        LaunchInputs {
            scratch: None,
            thread: first.thread.clone(),
            input: "fixture-only wire".into(),
            started_at: 3,
        },
        &[4; 32],
        None,
        "fixture-group".into(),
    )
    .expect("reserve second review");
    row = service
        .save(&row, task.clone(), &event("run_reserved"))
        .await
        .expect("persist reservation");
    let instance = task.run().expect("second review").launch().instance.clone();
    task.record_send(&instance, 4).expect("second send");
    service
        .save(&row, task, &event("host_send"))
        .await
        .expect("persist send");

    let api = router(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority,
        }],
    );
    let detail = json_body(get_as(&api, "/v1/tasks/reviewer", &BOARD_KEY).await).await;
    assert_eq!(detail["run"]["purpose"], "Checking round 2");
    assert_eq!(detail["lifecycle"]["reviewRound"], 2);
    assert_eq!(detail["lifecycle"]["reviewer"]["thread"], first.thread);
    assert_eq!(detail["lifecycle"]["steps"][2]["roundLabel"], "Round 2");
    assert_eq!(detail["lifecycle"]["steps"][2]["activeSinceMs"], 4);
    let history = json_body(get_as(&api, "/v1/tasks/reviewer/history", &BOARD_KEY).await).await;
    let history = without_transitions(&history);
    assert_eq!(history[0]["presentation"][0]["purpose"], "Checking round 2");
    assert_eq!(
        history[5]["presentation"],
        json!([]),
        "replaying adds no run"
    );
    assert_eq!(history[6]["presentation"][0]["purpose"], "Checking round 1");
}

#[tokio::test]
async fn http_reports_bind_the_task_instance_credential_and_role() {
    let (_home, service) = registry_fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let (worker, worker_key, _) = reservation("worker", Entry::Brief, &service.fixture().start);
    let (reviewer, reviewer_key, _) =
        reservation("reviewer", Entry::ReviewEntry, &service.fixture().start);
    for task in [&worker, &reviewer] {
        seed_task(&service, task).await;
    }
    service
        .state
        .lock()
        .await
        .set_wait("worker", Some(nucleus_core::WaitReason::HostUnknown));
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
    let worker_id = &worker.run().expect("worker run").launch().instance;
    let reviewer_id = &reviewer.run().expect("reviewer run").launch().instance;
    let work = json!({"work":{"url": PR, "head":service.fixture().start}});
    let review = json!({"review":{"head": service.fixture().start, "decision": "approve", "summary": "Tested"}});
    let worker_path = format!("/v1/runs/worker/{worker_id}/report");
    let reviewer_path = format!("/v1/runs/reviewer/{reviewer_id}/report");
    let stream = get_as(&api, "/v1/events", &BOARD_KEY).await;
    let mut events = stream.into_body().into_data_stream();
    assert_event(&mut events, &["event: refresh"]).await;

    reject_foreign_addresses(&api, &worker_path, worker_key.as_bytes(), &work).await;

    assert_eq!(
        post_json(&api, &worker_path, &BOARD_KEY, &work).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post_json(
            &api,
            &format!("/v1/runs/reviewer/{worker_id}/report"),
            worker_key.as_bytes(),
            &work
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post_json(&api, &worker_path, worker_key.as_bytes(), &review).await,
        StatusCode::CONFLICT
    );
    assert_eq!(
        post_json(&api, &reviewer_path, reviewer_key.as_bytes(), &work).await,
        StatusCode::CONFLICT
    );
    assert_eq!(
        post_json(&api, &worker_path, worker_key.as_bytes(), &work).await,
        StatusCode::NO_CONTENT
    );
    assert_event(
        &mut events,
        &["event: invalidate", r#"{"taskId":"worker","version":2}"#],
    )
    .await;
    let observed = service.task("worker").await.expect("accepted work report");
    assert_eq!(observed.task.attempts(), worker.attempts());
    let run = observed.task.run().expect("same run");
    assert_eq!(&run.launch().instance, worker_id);
    assert!(run.report().is_some());
    assert_eq!(
        post_json(&api, &worker_path, worker_key.as_bytes(), &work).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        post_json(&api, &reviewer_path, reviewer_key.as_bytes(), &review).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        post_json(
            &api,
            "/v1/tasks/worker/commands",
            &BOARD_KEY,
            &json!("cancel")
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        post_json(&api, &worker_path, worker_key.as_bytes(), &work).await,
        StatusCode::UNAUTHORIZED
    );
    let value = json_body(get_as(&api, "/v1/tasks/reviewer", &BOARD_KEY).await).await;
    assert_eq!(value["run"]["reported"], true);
    assert!(value["run"].get("credential").is_none());
    assert!(value["run"].get("input").is_none());
}

#[tokio::test]
async fn next_shows_the_settled_reviewers_provider_reset() {
    let (_home, service) = registry_fixture(GitHub::new("unused-fixture").unwrap());
    let (mut task, _, mut observation) =
        reservation("reviewer", Entry::ReviewEntry, &service.fixture().start);
    let cause =
        "Provider usage limit for subscription group shared. Reset at 2099-01-01 00:00 UTC.";
    observation.host = Observed::Known(Host::ProviderLimited {
        instance: task.run().unwrap().launch().instance.clone(),
        cause: cause.into(),
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Relaunch(nucleus_core::Role::Reviewer)
    );
    seed_task(&service, &task).await;
    let api = router(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "operator".into(),
            },
        }],
    );
    let next = json_body(get_as(&api, "/v1/tasks/reviewer/next", &BOARD_KEY).await).await;
    assert_eq!(next["lastProviderLimit"], cause);
}

#[tokio::test]
async fn next_and_owner_commands_agree_on_code_recovery() {
    let (_home, service) = registry_fixture(GitHub::new("unused-fixture").unwrap());
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "operator".into(),
            },
        }],
    );
    let head = &service.fixture().start;
    for (id, answer) in [("owner-move", false), ("legacy-answer", true)] {
        let (mut task, mut observation) = code_task_at_merge(id, head);
        observation.forge = Observed::Known(Forge::Open {
            pr: task.pull_request().unwrap().clone(),
            checks: CheckState::Blocked,
        });
        if answer {
            assert_eq!(
                task.reconcile(&observation),
                Action::Ask(nucleus_core::Question::Repair(
                    nucleus_core::Repair::MergeBlocked
                ))
            );
        }
        seed_task(&service, &task).await;
        let prior = service.task(id).await.unwrap();
        service
            .observe_commands(&prior, &observation.forge)
            .await
            .unwrap();
        let view = json_body(get_as(&api, &format!("/v1/tasks/{id}/next"), &BOARD_KEY).await).await;
        expect_command(&view, "move", Some("working"), "ready");
        let instruction = "Rebase the same PR branch";
        let command = if answer {
            expect_command(&view, "answer", None, "ready");
            assert_eq!(view["answerForm"], "work TEXT");
            let refused = post_as(
                &api,
                &format!("/v1/tasks/{id}/commands"),
                &BOARD_KEY,
                &json!({"answer": "retry"}),
            )
            .await;
            assert_eq!(refused.status(), StatusCode::CONFLICT);
            assert_eq!(
                json_body(refused).await["error"],
                "the answer does not match the current question. Use nucleus answer REF work TEXT"
            );
            json!({"answer":{"work":instruction}})
        } else {
            json!({"move_work":{"instruction":instruction}})
        };
        assert_eq!(
            post_json(
                &api,
                &format!("/v1/tasks/{id}/commands"),
                &BOARD_KEY,
                &command
            )
            .await,
            StatusCode::OK
        );
        let row = service.task(id).await.unwrap();
        assert_eq!(row.task.phase(), Phase::Working);
        assert_eq!(row.task.work_instruction(), Some(instruction));
        assert!(row.task.question().is_none());
        assert!(row.task.verdict().is_none());
    }
}

#[tokio::test]
async fn next_and_commands_share_acceptance_authority_and_forge_requirements() {
    let (_home, mut service, _planner_host) =
        enrolled_fixture(GitHub::new("unused-forge-fixture").expect("client")).await;
    let head = service.fixture().start.clone();
    seed_held_acceptance(&service, &head).await;
    let (forge, readable, _published, reads, server) = serve_merged_forge(&head).await;
    service.forge = forge;
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            },
            planner_controller(PLANNER_KEY, "planner"),
        ],
    );
    let next_path = "/v1/tasks/reviewer/next";
    let view = json_body(get_as(&api, next_path, &BOARD_KEY).await).await;
    assert_eq!(view["version"], 1);
    expect_command(&view, "answer", None, "pending");
    expect_command(&view, "move", Some("merging"), "pending");
    expect_command(&view, "move", Some("done"), "pending");
    let path = "/v1/tasks/reviewer/commands";
    let answer = json!({"answer":{"accept":{"head":head, "reason":"accepted exact merge"}}});
    let refused = post_as(&api, path, &BOARD_KEY, &answer).await;
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        json_body(refused).await["error"]
            .as_str()
            .unwrap()
            .contains("503")
    );
    assert_eq!(reads.load(Ordering::Relaxed), 1);
    for phase in ["merging", "done"] {
        let refused = post_as(&api, path, &BOARD_KEY, &json!({"move":phase})).await;
        assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            json_body(refused).await["error"]
                .as_str()
                .unwrap()
                .contains("deferred")
        );
    }
    assert_eq!(reads.load(Ordering::Relaxed), 1);
    assert_eq!(service.task("reviewer").await.unwrap().version, 1);
    readable.store(true, Ordering::Relaxed);
    service.forge_until.store(0, Ordering::Relaxed);
    let planner = json_body(get_as(&api, next_path, &PLANNER_KEY).await).await;
    expect_command(&planner, "answer", None, "unavailable");
    assert_eq!(
        post_json(&api, path, &PLANNER_KEY, &answer).await,
        StatusCode::CONFLICT
    );
    assert_eq!(
        post_json(&api, path, &BOARD_KEY, &answer).await,
        StatusCode::OK
    );
    let view = json_body(get_as(&api, next_path, &BOARD_KEY).await).await;
    assert_eq!(view["version"], 2);
    expect_command(&view, "move", Some("done"), "pending");
    assert_eq!(
        post_json(&api, path, &BOARD_KEY, &json!({"move":"done"})).await,
        StatusCode::OK
    );
    assert_eq!(
        service.task("reviewer").await.unwrap().task.phase(),
        Phase::Done
    );
    server.abort();
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "exercise the actual deadline, detail, and existing repair commands together"
)]
async fn persistent_workspace_error_parks_and_owner_recheck_observes_one_repair() {
    let (forge, server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls"),
        get(|| async { Json(Vec::<serde_json::Value>::new()) }),
    ))
    .await;
    let (_home, mut service) = fixture(forge);
    let root = service.fixture().checkout.clone();
    let runs = Arc::new(std::sync::Mutex::new(
        crate::profiles::tests::NativeRuns::default(),
    ));
    let (host, native) = crate::tests::native_fixture(move |request| {
        crate::profiles::tests::native_response(request, &root, &mut runs.lock().unwrap())
    })
    .await;
    service.host = host.with_quiet_fixture_processes();
    let head = &service.fixture().start;
    let worktrees = service.worktrees();
    let checkout = worktrees
        .checkout(&service.fixture().checkout, REPOSITORY, "unreadable")
        .unwrap();
    checkout.allocate(head).unwrap();
    let path = checkout.path().to_owned();
    let admin = std::path::PathBuf::from(crate::tests::git(
        &path,
        &["rev-parse", "--absolute-git-dir"],
    ));
    let index = admin.join("index");
    let valid_index = std::fs::read(&index).unwrap();
    std::fs::write(&index, b"invalid-index").unwrap();
    std::fs::write(path.join("keep.txt"), b"local work").unwrap();

    let (shape, _, observation) = reservation("unreadable", Entry::Brief, head);
    let mut task = Task::new(shape.identity().clone(), shape.brief().text.clone(), None);
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    seed_task(&service, &task).await;
    crate::profiles::tests::publish_parent_shell(&service).await;
    let service = Arc::new(service);
    let operator = Authority::Operator {
        actor: "operator".into(),
    };
    let api = router(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: operator.clone(),
        }],
    );
    let card = "/v1/tasks/unreadable";
    let first = service.pass().await.unwrap();
    assert!(matches!(
        &first[0].result,
        Err(ServiceError::Workspace(nucleus_work::WorkError::Git { .. }))
    ));
    let checking = json_body(get_as(&api, card, &BOARD_KEY).await).await;
    assert_eq!(checking["wait"], "workspace_unknown");
    assert!(checking["nextCheckAt"].is_u64());
    {
        let mut state = service.state.lock().await;
        let now = tokio::time::Instant::now();
        let due = state.schedule.due("unreadable").unwrap();
        state
            .schedule
            .wake("unreadable", now, crate::schedule::Priority::Wake);
        assert_eq!(state.schedule.due("unreadable"), Some(due));
    }
    let second = tokio::time::timeout(
        nucleus_hosts::T3_RETRY_DELAY + std::time::Duration::from_secs(8),
        service.pass(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(
        &second[0].result,
        Err(ServiceError::Workspace(nucleus_work::WorkError::Git { .. }))
    ));
    let blocked = json_body(get_as(&api, card, &BOARD_KEY).await).await;
    assert_eq!(blocked["wait"], "workspace_blocked");
    assert_eq!(blocked["attention"], "attention");
    assert!(blocked["nextCheckAt"].is_null());
    assert!(
        blocked["waitDetail"]
            .as_str()
            .unwrap()
            .contains("git status failed")
    );
    {
        let mut state = service.state.lock().await;
        state.schedule.wake(
            "unreadable",
            tokio::time::Instant::now(),
            crate::schedule::Priority::Effect,
        );
        assert!(state.schedule.due("unreadable").is_none());
    }
    assert_eq!(std::fs::read(&index).unwrap(), b"invalid-index");
    assert_eq!(std::fs::read(path.join("keep.txt")).unwrap(), b"local work");
    assert!(
        service
            .task("unreadable")
            .await
            .unwrap()
            .task
            .run()
            .is_none()
    );
    assert!(service.host.host_calls().is_empty());

    let request = json!({"recheck": blocked["version"]});
    let command_path = format!("{card}/commands");
    let recheck = || post_json(&api, &command_path, &BOARD_KEY, &request);
    assert_eq!(recheck().await, StatusCode::OK);
    assert_eq!(recheck().await, StatusCode::OK);
    assert!(service.pass().await.unwrap()[0].result.is_err());
    assert!(
        service
            .state
            .lock()
            .await
            .schedule
            .due("unreadable")
            .is_none()
    );

    std::fs::write(&index, valid_index).unwrap();
    assert_eq!(recheck().await, StatusCode::OK);
    let first = service.pass().await.unwrap();
    assert!(matches!(
        first[0].result,
        Ok(Action::Wait(WaitReason::Starting))
    ));
    crate::profiles::tests::publish_parent_shell(&service).await;
    service.state.lock().await.schedule.wake(
        "unreadable",
        tokio::time::Instant::now(),
        crate::schedule::Priority::Wake,
    );
    assert!(matches!(
        service.pass().await.unwrap()[0].result,
        Ok(Action::Launch { .. })
    ));
    assert_eq!(std::fs::read(path.join("keep.txt")).unwrap(), b"local work");
    service
        .command("unreadable", &operator, Command::Hold("Owner hold".into()))
        .await
        .unwrap();
    assert_eq!(recheck().await, StatusCode::CONFLICT);
    let after = json_body(get_as(&api, card, &BOARD_KEY).await).await;
    assert_eq!(after["hold"]["reason"], "Owner hold");
    native.abort();
    server.abort();
}

#[tokio::test]
async fn workspace_timeout_card_names_the_operation_without_raw_git_diagnostics() {
    use longhorn_git_workspace::{GitFailure, GitFailureCode};
    use nucleus_work::{GitOperation, WorkError};
    let (_home, service) = registry_fixture(GitHub::new("fixture").unwrap());
    let (shape, _, _) = reservation("timeout", Entry::Brief, &service.fixture().start);
    let task = Task::new(shape.identity().clone(), shape.brief().text.clone(), None);
    seed_task(&service, &task).await;
    let row = service.task("timeout").await.unwrap();
    let previous = crate::schedule::Priority::Decision;
    let error = Err(ServiceError::Workspace(WorkError::Git {
        operation: GitOperation::Add,
        command: "git worktree add synthetic-private-path".into(),
        directory: "synthetic-private-path".into(),
        repository: "synthetic-repository".into(),
        source: GitFailure::TimedOut {
            code: GitFailureCode::CommandUnavailable,
            after: std::time::Duration::from_mins(10),
        },
    }));
    let elapsed = tokio::time::Instant::now() - nucleus_hosts::T3_RETRY_DELAY;
    service
        .state
        .lock()
        .await
        .schedule
        .recover_workspace("timeout", elapsed, row.task.phase());
    service
        .schedule_result(&row, &error, previous)
        .await
        .unwrap();
    let api = router(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "operator".into(),
            },
        }],
    );
    let card = json_body(get_as(&api, "/v1/tasks/timeout", &BOARD_KEY).await).await;
    assert_eq!(card["wait"], "workspace_blocked");
    assert_eq!(
        card["waitDetail"],
        "git worktree add timed out. Check the checkout. Use Recheck after the repair."
    );
    assert!(card["nextCheckAt"].is_null());
}

#[tokio::test]
async fn queued_external_merge_acceptance_bypasses_saturation() {
    let (_home, mut service) = registry_fixture(GitHub::new("fixture").unwrap());
    let head = service.fixture().start.clone();
    let (forge, readable, published, reads, server) = serve_merged_forge(&head).await;
    readable.store(true, Ordering::Relaxed);
    service.forge = forge;
    let (mut holder, _, _) = reservation("holder", Entry::Brief, &head);
    let instance = holder.run().unwrap().launch().instance.clone();
    holder.record_send(&instance, 2).unwrap();
    seed_task(&service, &holder).await;
    service.state.lock().await.schedule.park("holder");
    let (shape, _, _) = reservation("reviewer", Entry::Brief, &head);
    let task = Task::new(
        shape.identity().clone(),
        "Fixture external merge".into(),
        Some(nucleus_core::PullRequest {
            url: PR.into(),
            head: head.clone(),
        }),
    );
    seed_task(&service, &task).await;
    let operator = Authority::Operator {
        actor: "fixture".into(),
    };
    assert!(matches!(
        service
            .command("reviewer", &operator, Command::Move(Phase::Done))
            .await,
        Err(ServiceError::Core(
            nucleus_core::CommandError::MergeAuthorityRequired
        ))
    ));
    service.pass().await.unwrap();
    let waiting = service.task("reviewer").await.unwrap();
    assert_eq!(waiting.task.phase(), Phase::Queued);
    assert!(matches!(
        waiting.task.question(),
        Some(Question::Accept { head: asked }) if asked == &head
    ));
    let answer = Command::Answer(nucleus_core::Answer::Accept {
        head,
        reason: "Reviewed the exact external merge".into(),
    });
    published.store(false, Ordering::Relaxed);
    assert!(matches!(
        service.command("reviewer", &operator, answer.clone()).await,
        Err(ServiceError::Forge(
            nucleus_forge::ForgeError::UnpublishedMerge
        ))
    ));
    assert!(
        service
            .task("reviewer")
            .await
            .unwrap()
            .task
            .verdict()
            .is_none()
    );
    published.store(true, Ordering::Relaxed);
    service
        .command("reviewer", &operator, answer)
        .await
        .unwrap();
    service
        .command("reviewer", &operator, Command::Move(Phase::Done))
        .await
        .unwrap();
    assert_eq!(
        service.task("reviewer").await.unwrap().task.phase(),
        Phase::Done
    );
    assert!(reads.load(Ordering::Relaxed) <= 5);
    assert_eq!(
        service
            .state
            .lock()
            .await
            .store
            .occupied_slots("")
            .unwrap()
            .total,
        1
    );
    server.abort();
}

#[tokio::test]
async fn a_head_bound_work_answer_and_amend_wait_for_the_exact_head() {
    let (_home, mut service, _planner_host) =
        enrolled_fixture(GitHub::new("fixture").unwrap()).await;
    let head = service.fixture().start.clone();
    let (forge, readable, server) = switchable_open_forge(&head).await;
    service.forge = forge;
    let (host, _, _, native) = planner_roster_fixture("planner", "spare-planner").await;
    service.host = host;
    let exact = seed_review_work_question(&service, &head).await;
    service
        .refresh_planner_authority("reviewer")
        .await
        .expect("planner roster");
    let prior = service.task("reviewer").await.expect("seeded question");
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [planner_controller(PLANNER_KEY, "planner")],
    );
    let next = "/v1/tasks/reviewer/next";
    let path = "/v1/tasks/reviewer/commands";
    let answer = json!({"answer":{"work":"Use the fixture greeting"}});
    let replacement = briefs::brief_with_bytes(crate::MAX_BRIEF_BYTES);
    let amend = json!({"amend":replacement});
    let changed_forge = changed_open_head(&head);
    service
        .observe_commands(&prior, &changed_forge)
        .await
        .expect("new head");
    let view = json_body(get_as(&api, next, &PLANNER_KEY).await).await;
    for (name, command) in [("answer", &answer), ("amend", &amend)] {
        expect_command(&view, name, None, "unavailable");
        assert_eq!(
            post_json(&api, path, &PLANNER_KEY, command).await,
            StatusCode::CONFLICT
        );
    }
    service
        .observe_commands(&prior, &exact)
        .await
        .expect("same head");
    let _ = service.pass().await.expect("forge outage through loopback");
    let view = json_body(get_as(&api, next, &PLANNER_KEY).await).await;
    for (name, command) in [("answer", &answer), ("amend", &amend)] {
        expect_command(&view, name, None, "pending");
        let response = post_as(&api, path, &PLANNER_KEY, command).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(json_body(response).await["error"].is_string());
    }
    let pending = service.task("reviewer").await.expect("pending question");
    assert_eq!(pending, prior);

    service
        .observe_commands(&prior, &exact)
        .await
        .expect("forge recovered");
    let view = json_body(get_as(&api, next, &PLANNER_KEY).await).await;
    expect_command(&view, "amend", None, "ready");
    assert_eq!(
        post_json(&api, path, &PLANNER_KEY, &amend).await,
        StatusCode::OK
    );
    let revised = service.task("reviewer").await.expect("brief revised");
    assert_eq!(revised.version, 2);
    expect_command(
        &json_body(get_as(&api, next, &PLANNER_KEY).await).await,
        "answer",
        None,
        "pending",
    );
    readable.store(true, Ordering::Relaxed);
    service.forge_until.store(0, Ordering::Relaxed);
    assert_eq!(
        post_json(&api, path, &PLANNER_KEY, &answer).await,
        StatusCode::OK
    );
    let answered = service.task("reviewer").await.expect("question answered");
    assert_eq!(answered.version, 3);
    assert!(answered.task.brief().text.len() > crate::MAX_BRIEF_BYTES);
    assert!(
        answered
            .task
            .brief()
            .text
            .ends_with("Use the fixture greeting")
    );
    assert!(answered.task.question().is_none());
    native.abort();
    server.abort();
}

#[tokio::test]
async fn a_replaced_head_refuses_the_answer_after_one_forge_read() {
    let (_home, mut service) = registry_fixture(GitHub::new("fixture").unwrap());
    let head = service.fixture().start.clone();
    let mut pull = forge_pull(&head);
    pull["state"] = json!("closed");
    pull["head"]["sha"] = json!("b".repeat(40));
    let reads = Arc::new(AtomicUsize::new(0));
    let calls = reads.clone();
    let (forge, server) = serve_forge(
        Router::new()
            .route(
                &format!("/repos/{REPOSITORY}/pulls/1"),
                get(move || async move { Json(pull) }),
            )
            .layer(axum::middleware::from_fn(
                move |request: Request<Body>, next: axum::middleware::Next| {
                    calls.fetch_add(1, Ordering::Relaxed);
                    async move { next.run(request).await }
                },
            )),
    )
    .await;
    service.forge = forge;
    seed_review_work_question(&service, &head).await;
    let prior = service.task("reviewer").await.unwrap();
    let result = service
        .command(
            "reviewer",
            &Authority::Operator {
                actor: "fixture".into(),
            },
            Command::Answer(Answer::Work("Continue on the recorded revision".into())),
        )
        .await;
    assert!(matches!(
        result,
        Err(ServiceError::Core(
            nucleus_core::CommandError::AnswerDoesNotMatch
        ))
    ));
    assert_eq!(reads.load(Ordering::Relaxed), 1);
    assert_eq!(service.task("reviewer").await.unwrap(), prior);
    server.abort();
}

#[tokio::test]
async fn an_unanswered_forge_read_refuses_the_command_at_its_deadline() {
    let (forge, server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls/1"),
        get(std::future::pending::<StatusCode>),
    ))
    .await;
    let (_home, service) = fixture(forge);
    let head = service.fixture().start.clone();
    seed_review_work_question(&service, &head).await;
    let prior = service.task("reviewer").await.unwrap();
    let result = service
        .command(
            "reviewer",
            &Authority::Operator {
                actor: "fixture".into(),
            },
            Command::Amend("Revised assignment".into()),
        )
        .await;
    assert!(matches!(result, Err(ServiceError::CommandForgeTimeout)));
    assert_eq!(service.task("reviewer").await.unwrap(), prior);
    server.abort();
}
