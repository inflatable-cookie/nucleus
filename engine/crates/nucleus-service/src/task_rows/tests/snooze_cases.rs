use super::*;

#[tokio::test]
async fn failed_snooze_waits_for_later_shell_evidence() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    {
        let mut state = fixture.service.state.lock().await;
        state
            .store
            .create_with_facts(
                &pending,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        fixture.service.desire_title(&mut state, &pending, None);
    }
    fixture.native.lock().unwrap().next_reply = NextReply::Lost;
    fixture.sync().await;
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    assert!(
        !fixture
            .service
            .host
            .host_calls()
            .contains_key("orchestration.subscribeThread")
    );
    let receipt = fixture
        .service
        .state
        .lock()
        .await
        .store
        .row_snooze(ID, &fixture.thread)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.outcome, SnoozeOutcome::Unknown);
    {
        let mut native = fixture.native.lock().unwrap();
        assert!(native.until.is_null());
        native.until = native.commands[0]["snoozedUntil"].clone();
    }
    fixture.sync().await;
    assert_eq!(fixture.observed_snooze().await.until_ms, receipt.until_ms);
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    assert!(
        !fixture
            .service
            .host
            .host_calls()
            .contains_key("orchestration.subscribeThread")
    );
}

#[tokio::test]
async fn a_delivered_parent_message_supersedes_an_unconfirmed_snooze_once() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    let service = &fixture.service;
    service
        .visibility_time
        .store(1_893_456_000_000, std::sync::atomic::Ordering::Relaxed);
    {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &pending,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        service.desire_title(&mut state, &pending, None);
    }
    fixture.sync().await;
    // Dispatch clears the snooze before the shell publishes its horizon.
    {
        let mut native = fixture.native.lock().unwrap();
        native.until = Value::Null;
        native.message_at = json!("2030-01-01T00:00:01Z");
    }
    fixture.elapse_visibility_ms(2_000);
    fixture.sync().await;
    fixture.sync().await;
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.snooze"]);
    {
        let native = fixture.native.lock().unwrap();
        assert_ne!(
            native.commands[0]["commandId"],
            native.commands[1]["commandId"]
        );
    }
    fixture.observed_snooze().await;
    assert!(fixture.sync().await.is_empty());
}

#[tokio::test]
async fn board_and_native_row_distinguish_a_recheck_from_an_owner_action() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let (mut task, _, _) = reservation(ID, Entry::Brief, &service.fixture().start);
    let run = task.run().unwrap().launch().clone();
    task.record_send(&run.instance, 1).unwrap();
    let row = {
        let mut state = service.state.lock().await;
        state.role_observations.insert(
            ID.into(),
            (run.instance.clone(), RunState::IdleWithoutTerminalRun),
        );
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        service.desire_title(&mut state, &task, None);
        service.lookup(&state, ID).unwrap()
    };
    let unknown = Ok(Action::Wait(WaitReason::HostUnknown));
    service
        .schedule_result(&row, &unknown, Priority::Effect)
        .await
        .unwrap();
    let checking = fixture.board_task().await;
    assert_eq!(checking["attention"], "waiting");
    assert_eq!(checking["wait"], "host_unknown");
    assert_eq!(checking["waitDetail"], "Waiting for delivery confirmation.");
    assert!(checking["nextCheckAt"].as_u64().unwrap() > now_ms());

    fixture.child(&run.thread, true);
    fixture.sync().await;
    assert!(fixture.commands().is_empty());
    fixture.child(&run.thread, false);
    fixture.sync().await;
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    fixture.observed_snooze().await;

    service
        .schedule_result(
            &row,
            &Ok(Action::Wait(WaitReason::HostObservationBlocked)),
            Priority::Effect,
        )
        .await
        .unwrap();
    let blocked = fixture.board_task().await;
    assert_eq!(blocked["version"], checking["version"]);
    assert_eq!(blocked["attention"], "attention");
    assert_eq!(blocked["wait"], "host_observation_blocked");
    assert_eq!(
        blocked["waitDetail"],
        "The T3 task turn failed. Open the task thread to check, then update the task to retry."
    );
    assert!(blocked["nextCheckAt"].is_null());
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
}

#[tokio::test]
async fn a_hold_restores_an_operator_snooze_applied_after_preparation() {
    let task = pending_task();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
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
        service.lookup(&state, ID).unwrap()
    };
    fixture.publish_shell();
    let write = fixture.prepare_hold("Preparing the task thread.", None);
    let command = write.command_id().unwrap().to_owned();
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.publish_shell();

    assert!(service.deliver_parent(&row, write, None).await.unwrap());

    let pending = pending_delivery_snooze(service).await;
    assert_eq!(pending.command, command);
    assert_eq!(fixture.commands(), ["message.dispatch"]);
    fixture.publish_shell();
    let (restored, calls) =
        nucleus_hosts::T3::count_pass_calls(Box::pin(service.reconcile_delivery_snoozes())).await;
    restored.unwrap();
    assert_eq!(calls.get("orchestration.dispatchCommand"), Some(&1));
    assert!(!calls.contains_key("orchestration.subscribeThread"));
    observe_restored_delivery_snooze(&fixture).await;
    let stored = fixture.parent_record(&row).await;
    assert_eq!(stored.command, command);
    assert_eq!(stored.result, nucleus_store::ParentResult::Accepted);
    let wire: Value = serde_json::from_str(&stored.wire).unwrap();
    let native = fixture.native.lock().unwrap();
    let [hold, restore] = &native.commands[..] else {
        panic!("expected a hold followed by one snooze restoration");
    };
    assert_eq!(hold, &wire["payload"]);
    assert_eq!(hold["type"], "message.dispatch");
    assert_eq!(restore["type"], "thread.snooze");
    assert_eq!(restore["threadId"], fixture.thread);
    assert_eq!(restore["snoozedUntil"], OPERATOR_SNOOZE);
    assert_eq!(native.until, OPERATOR_SNOOZE);
}

#[tokio::test]
async fn a_snoozed_parent_reenters_without_waiting_for_its_horizon() {
    let (fixture, row) = instant_parent_fixture().await;
    let service = &fixture.service;
    service.reconcile_live_parent(&row).await.unwrap();
    {
        let mut native = fixture.native.lock().unwrap();
        let now = now_ms();
        let run = native.parent_runs.last_mut().unwrap();
        run["startedAt"] = json!(native_timestamp(now.saturating_sub(4_000)));
        run["completedAt"] = json!(native_timestamp(now));
        native.until = json!(OPERATOR_SNOOZE);
    }
    fixture.publish_shell();

    service.reconcile_live_parent(&row).await.unwrap();
    assert_eq!(fixture.commands(), ["message.dispatch"; 2]);
    fixture.publish_shell();
    fixture.restore_operator_horizons(&[&fixture.thread]).await;
}

#[tokio::test]
async fn a_planner_notice_restores_the_operator_horizon_on_its_destination() {
    let task = pending_task();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    let planner = "thread:planner";
    fixture.snoozed_peer(planner, "fixture-planner-provider", None);
    let mut delivery =
        nucleus_hosts::T3::prepare_notice(planner.into(), "fixture-notice".into(), "Please decide")
            .unwrap();
    let authorization = service
        .host
        .authorize_notice(&delivery)
        .await
        .unwrap()
        .unwrap();
    fixture.native.lock().unwrap().peer.as_mut().unwrap()["snoozedAt"] =
        json!("2026-01-02T00:00:00Z");
    fixture.publish_shell();
    let dispatch = authorization.record(&mut delivery).unwrap();

    let result = service
        .send_notice_preserving_snooze(None, dispatch)
        .await
        .unwrap();
    assert_eq!(result, nucleus_hosts::NoticeOutcome::Accepted);
    assert_eq!(fixture.commands(), ["message.dispatch"]);
    fixture.publish_shell();
    fixture.restore_operator_horizons(&[planner]).await;
}

#[tokio::test]
async fn expired_operator_horizons_do_not_get_restored() {
    let task = pending_task();
    let fixture = Fixture::new(&task).await;
    let row = send_snoozed_hold(&fixture, &task).await;
    let service = &fixture.service;
    let pending = pending_delivery_snooze(service).await;
    // Advance the recorded horizon past expiry independently of the real-time clock.
    let db = rusqlite::Connection::open(service.storage.database().path().join("engine.sqlite"))
        .unwrap();
    db.execute(
        "UPDATE delivery_snoozes SET until_ms=1 WHERE command=?1",
        [&pending.command],
    )
    .unwrap();
    fixture.publish_shell();

    let (result, calls) =
        nucleus_hosts::T3::count_pass_calls(Box::pin(service.reconcile_delivery_snoozes())).await;
    result.unwrap();
    assert!(calls.is_empty());
    assert_eq!(fixture.commands(), ["message.dispatch"]);
    assert!(
        service
            .state
            .lock()
            .await
            .store
            .next_delivery_snooze()
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fixture.parent_record(&row).await.result,
        nucleus_store::ParentResult::Accepted
    );
}

#[tokio::test]
async fn retained_role_continues_while_both_rows_are_snoozed() {
    let mut fixture = Fixture::new(&pending_task()).await;
    let head = fixture.service.fixture().start.clone();
    let (forge, _, forge_server) =
        crate::tests::forge_fixture_for_branch(&head, &fixture.binding.branch).await;
    Arc::get_mut(&mut fixture.service).unwrap().forge = forge;
    let role = "thread:retained-reviewer";
    let provider = "fixture-role-provider";
    let (task, _, _) = crate::tests::reserved_reviewer_with(ID, &head, |task| {
        nucleus_hosts::RunRequest {
            binding: fixture.binding.clone(),
            parent: Some(fixture.thread.clone()),
            dispatch: nucleus_hosts::Dispatch::Continue {
                profile: nucleus_hosts::RoleProfile {
                    instance_id: provider.into(),
                    model: "fixture-model".into(),
                    runtime_mode: "full-access".into(),
                    options: Vec::new(),
                },
            },
            text: "Review the current head.".into(),
        }
        .inputs(&task.next_launch_instance().unwrap(), role.into(), now_ms())
        .unwrap()
    });
    let service = &fixture.service;
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
        service.lookup(&state, ID).unwrap()
    };
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.snoozed_peer(role, provider, Some(&fixture.thread));

    let result = service
        .advance_due_task(&row, &service.host.fixture_pass())
        .await;
    assert!(
        matches!(
            result,
            Ok(Action::Launch {
                role: Role::Reviewer,
                ..
            })
        ),
        "{result:?}"
    );
    assert_eq!(fixture.commands(), ["message.dispatch"; 2]);
    {
        let native = fixture.native.lock().unwrap();
        assert_eq!(native.commands[0]["threadId"], fixture.thread);
        assert_eq!(native.commands[1]["threadId"], role);
    }
    fixture.publish_shell();
    fixture
        .restore_operator_horizons(&[&fixture.thread, role])
        .await;
    assert_eq!(fixture.native.lock().unwrap().until, OPERATOR_SNOOZE);
    forge_server.abort();
    assert!(forge_server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn an_accepted_send_that_leaves_the_snooze_needs_no_restore() {
    let task = pending_task();
    let fixture = Fixture::new(&task).await;
    send_snoozed_hold(&fixture, &task).await;
    let service = &fixture.service;

    // An older shell row cannot settle the intent.
    assert!(
        service
            .reconcile_delivery_snoozes()
            .await
            .unwrap()
            .is_some()
    );
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.publish_shell();
    allow_delivery_snooze_retry(service).await;

    let (result, calls) =
        nucleus_hosts::T3::count_pass_calls(Box::pin(service.reconcile_delivery_snoozes())).await;
    assert!(result.unwrap().is_none());
    assert!(calls.is_empty());
    assert_eq!(fixture.commands(), ["message.dispatch"]);
}

#[tokio::test]
async fn delivery_snooze_survives_a_delayed_shell_and_engine_restart() {
    let task = pending_task();
    let mut fixture = Fixture::new(&task).await;
    let row = send_snoozed_hold(&fixture, &task).await;
    let recorded = pending_delivery_snooze(&fixture.service).await;
    let intent: Value = serde_json::from_str(&recorded.intent).unwrap();
    assert_eq!(intent["until"], OPERATOR_SNOOZE);
    assert!(intent["accepted_sequence"].is_number());
    assert_eq!(
        fixture.parent_record(&row).await.result,
        nucleus_store::ParentResult::Accepted
    );

    fixture.restart();
    fixture.service.reconcile_delivery_snoozes().await.unwrap();
    assert_eq!(fixture.commands(), ["message.dispatch"]);
    fixture.publish_shell();
    allow_delivery_snooze_retry(&fixture.service).await;
    fixture.service.reconcile_delivery_snoozes().await.unwrap();
    assert_eq!(fixture.commands(), ["message.dispatch", "thread.snooze"]);
    assert_eq!(fixture.native.lock().unwrap().until, OPERATOR_SNOOZE);
    observe_restored_delivery_snooze(&fixture).await;
}

#[tokio::test]
async fn delivery_snooze_replays_a_lost_reply_and_rotates_a_rejected_id() {
    let task = pending_task();
    let fixture = Fixture::new(&task).await;
    let row = send_snoozed_hold(&fixture, &task).await;
    fixture.publish_shell();
    let service = &fixture.service;
    for (reply, expected_attempt) in [(NextReply::Lost, 0), (NextReply::Rejected, 1)] {
        allow_delivery_snooze_retry(service).await;
        fixture.native.lock().unwrap().next_reply = reply;
        service.reconcile_delivery_snoozes().await.unwrap();
        assert_eq!(
            pending_delivery_snooze(service).await.attempt,
            expected_attempt
        );
        assert_eq!(
            fixture.parent_record(&row).await.result,
            nucleus_store::ParentResult::Accepted
        );
    }
    allow_delivery_snooze_retry(service).await;
    service.reconcile_delivery_snoozes().await.unwrap();
    observe_restored_delivery_snooze(&fixture).await;
    let native = fixture.native.lock().unwrap();
    let [_, first, replay, fresh] = &native.commands[..] else {
        panic!("expected the hold and three restoration requests");
    };
    assert_eq!(first, replay);
    assert_ne!(replay["commandId"], fresh["commandId"]);
    assert_eq!(fresh["type"], "thread.snooze");
    assert_eq!(fresh["threadId"], fixture.thread);
    assert_eq!(fresh["snoozedUntil"], OPERATOR_SNOOZE);
    assert_eq!(native.until, OPERATOR_SNOOZE);
}

#[tokio::test]
async fn lost_pinned_parent_reply_reopens_the_original_intent_and_wire() {
    let mut fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let row = {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &pending_task(),
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        service.lookup(&state, ID).unwrap()
    };
    fixture.publish_shell();
    let write = fixture.prepare_hold("Original task prompt", None);
    let command = write.command_id().unwrap().to_owned();
    fixture.native.lock().unwrap().next_reply = NextReply::Lost;
    let error = service.deliver_parent(&row, write, None).await.unwrap_err();
    assert!(matches!(error, ServiceError::ParentRetry { .. }));
    service
        .schedule_result(&row, &Err(error), Priority::Effect)
        .await
        .unwrap();
    let board = fixture.board_task().await;
    assert_eq!(board["attention"], "waiting");
    assert_eq!(board["waitDetail"], "The T3 task turn will retry.");
    assert!(board["nextCheckAt"].as_u64().unwrap() > now_ms());
    fixture.restart();
    let service = &fixture.service;
    fixture.publish_shell();
    let reopened = nucleus_store::Store::open(&service.storage).unwrap();
    let waiting = fixture.parent_record(&row).await;
    assert!(matches!(
        crate::acp::parent_due(&waiting),
        Err(ServiceError::ParentRetry { until, .. }) if until > tokio::time::Instant::now()
    ));
    let original = due_frozen_delivery(&reopened, &row);
    assert_eq!(original.command, command);
    let retry = || {
        fixture.prepare_hold(
            "A later render must not change the frozen prompt",
            Some(&command),
        )
    };
    let refused = retry();
    service
        .host
        .fixture_project_shell(&json!({"projects":[],"threads":[]}), PROVIDER);
    assert!(matches!(
        service.deliver_parent(&row, refused, Some(original)).await,
        Err(ServiceError::ParentRetry { .. })
    ));
    assert_eq!(fixture.commands().len(), 1);
    let original = due_frozen_delivery(&reopened, &row);
    fixture.publish_shell();
    let write = retry();
    assert!(
        service
            .deliver_parent(&row, write, Some(original))
            .await
            .unwrap()
    );
    {
        let native = fixture.native.lock().unwrap();
        assert_eq!(native.commands.len(), 2);
        assert_eq!(native.commands[0], native.commands[1]);
        assert_eq!(native.delivered_messages.len(), 1);
    }
    assert_eq!(
        fixture.parent_record(&row).await.result,
        nucleus_store::ParentResult::Accepted
    );
    assert!(
        service
            .history(ID, None, 100)
            .await
            .unwrap()
            .iter()
            .all(|entry| !entry.content.kind.starts_with("parent_recovery_notice"))
    );
}

#[tokio::test]
async fn a_rejected_hold_persists_its_replacement_before_retrying() {
    let task = pending_task();
    let mut fixture = Fixture::new(&task).await;
    let row = {
        let mut state = fixture.service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        fixture.service.lookup(&state, ID).unwrap()
    };
    fixture.publish_shell();
    let write = fixture.prepare_hold("Original hold", None);
    let command = write.command_id().unwrap().to_owned();
    fixture.native.lock().unwrap().next_reply = NextReply::Rejected;
    let error = fixture
        .service
        .deliver_parent(&row, write, None)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        ServiceError::ParentRetry {
            source: nucleus_hosts::HostError::ParentHoldRejected,
            ..
        }
    ));
    fixture
        .service
        .schedule_result(&row, &Err(error), Priority::Effect)
        .await
        .unwrap();
    assert_eq!(fixture.attention().await, TaskAttention::Waiting);
    assert_eq!(fixture.commands(), ["message.dispatch"]);
    fixture.restart();
    fixture.publish_shell();

    let service = &fixture.service;
    let store = nucleus_store::Store::open(&service.storage).unwrap();
    let replacement = due_frozen_delivery(&store, &row);
    assert_ne!(replacement.command, command);
    let fresh = fixture.prepare_hold("Later role label", Some(&replacement.command));
    assert_eq!(fresh.command_id(), Some(replacement.command.as_str()));
    assert!(
        service
            .deliver_parent(&row, fresh, Some(replacement))
            .await
            .unwrap()
    );
    let accepted = fixture.parent_record(&row).await;
    assert_eq!(accepted.result, nucleus_store::ParentResult::Accepted);
    let native = fixture.native.lock().unwrap();
    let [first, second] = &native.commands[..] else {
        panic!("expected the rejected command and one fresh send");
    };
    assert_eq!(first["commandId"], command);
    assert_eq!(second["commandId"], accepted.command);
    assert_ne!(first["messageId"], second["messageId"]);
    assert_ne!(first["text"], second["text"]);
    assert!(
        second["text"]
            .as_str()
            .unwrap()
            .starts_with("Original hold [")
    );
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "exercise ACP, the native queue and reviewer send together"
)]
async fn a_successor_prompt_releases_the_previous_acp_turn_and_anchors_the_reserved_reviewer() {
    let mut fixture = Fixture::new(&pending_task()).await;
    fixture.native.lock().unwrap().live_holds = true;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let head = fixture.service.fixture().start.clone();
    let (forge, _, forge_server) =
        crate::tests::forge_fixture_for_branch(&head, &fixture.binding.branch).await;
    let service = Arc::get_mut(&mut fixture.service).unwrap();
    service.callback = listener.local_addr().unwrap();
    service.forge = forge;
    let (task, _, _) = crate::tests::reserved_reviewer_with(ID, &head, |task| {
        let instance = task.next_launch_instance().unwrap();
        nucleus_core::LaunchInputs {
            thread: format!("thread:delegated-task:{instance}"),
            started_at: crate::now_ms(),
            input: json!({
                "binding":fixture.binding, "parent":fixture.thread, "method":"delegate",
                "payload":{"type":"delegated_task.request","commandId":instance,
                    "parentThreadId":fixture.thread,"parentRunId":"parent-run-1","parentNodeId":"root-1",
                    "completionWake":"settled_only",
                    "task":"Review the fixture.","modelSelection":{"instanceId":"provider","model":"fixture"}}
            })
            .to_string(),
            scratch: None,
        }
    });
    let service = &fixture.service;
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
        service.lookup(&state, ID).unwrap()
    };
    let deadline = crate::acp::run_hold_deadline(&row).unwrap();
    let app = router(
        Arc::clone(service),
        [crate::Controller {
            credential: [2; 32],
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
    );
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::post(format!("/v1/tasks/{ID}/acp?readOnly=true"))
                .header("host", service.callback.to_string())
                .header("authorization", format!("Bearer {}", hex::encode([2; 32])))
                .header("content-type", "application/json")
                .body(axum::body::Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    let mint: Value = serde_json::from_slice(&body).unwrap();
    let binding_path = std::path::PathBuf::from(mint["bindingPath"].as_str().unwrap());
    let binding = || -> nucleus_core::acp::Binding {
        serde_json::from_slice(&std::fs::read(&binding_path).unwrap()).unwrap()
    };
    let callback = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    fixture.publish_shell();
    let label = "Starting reviewer round 1";
    let old = fixture.prepare_hold(label, None);
    let old_prompt = old.freeze().prompt().unwrap().to_owned();
    assert!(service.deliver_parent(&row, old, None).await.unwrap());

    let (output, mut frames) = tokio::sync::mpsc::unbounded_channel();
    let cwd = PathBuf::from(&fixture.binding.worktree_path);
    let old_binding = binding();
    let old_cwd = cwd.clone();
    let held_prompt = old_prompt.clone();
    let turn = tokio::spawn(async move {
        nucleus_acp::fixture_task_prompt(old_binding, &old_cwd, &held_prompt, &output).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), frames.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        !turn.is_finished(),
        "the old ACP client is holding its turn"
    );
    fixture.native.lock().unwrap().finish_live_hold();
    fixture.publish_shell();
    fixture.native.lock().unwrap().next_reply = NextReply::Lost;
    assert!(matches!(
        service.reconcile_live_parent(&row).await,
        Err(ServiceError::ParentRetry { .. })
    ));
    let record = fixture.parent_record(&row).await;
    let new_prompt = crate::acp::frozen_parent(&record)
        .unwrap()
        .prompt()
        .unwrap()
        .to_owned();
    assert_ne!(old_prompt, new_prompt);
    fixture.publish_shell();
    {
        let native = fixture.native.lock().unwrap();
        assert_eq!(native.parent_runs[0]["status"], "completed");
        assert_eq!(native.parent_runs[1]["status"], "running");
    }
    let before_release = service.host.host_calls();
    tokio::time::timeout(std::time::Duration::from_secs(5), turn)
        .await
        .expect("the newer hold releases ACP before its deadline")
        .unwrap()
        .unwrap();
    assert_eq!(service.host.host_calls(), before_release);
    let row = {
        let mut state = service.state.lock().await;
        let version = service
            .commit(&mut state, &row, &task, &event("fixture_version"), None)
            .unwrap();
        assert!(version > row.version);
        let reserved = service.lookup(&state, ID).unwrap();
        assert_eq!(
            service.acp_turn_view(&state, &reserved).unwrap(),
            (Some(new_prompt.clone()), false)
        );
        reserved
    };
    let (output, mut frames) = tokio::sync::mpsc::unbounded_channel();
    let new_binding = binding();
    let successor = tokio::spawn(async move {
        nucleus_acp::fixture_task_prompt(new_binding, &cwd, &new_prompt, &output).await
    });
    let before_attach = service.host.host_calls();
    tokio::time::timeout(std::time::Duration::from_secs(5), frames.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        !successor.is_finished(),
        "the new parent prompt owns the turn"
    );
    assert_eq!(service.host.host_calls(), before_attach);
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.publish_shell();
    let (result, calls) = nucleus_hosts::T3::count_pass_calls(Box::pin(
        service.advance_due_task(&row, &service.host.fixture_pass()),
    ))
    .await;
    assert!(
        matches!(
            result,
            Ok(Action::Launch {
                role: nucleus_core::Role::Reviewer,
                ..
            })
        ),
        "{result:?}"
    );
    assert_eq!(calls.get("orchestration.dispatchCommand"), Some(&1));
    eprintln!("reserved reviewer send T3 calls: {calls:?}");
    assert!(crate::now_ms() < deadline);
    assert_eq!(fixture.native.lock().unwrap().until, OPERATOR_SNOOZE);
    assert_eq!(
        fixture.commands(),
        [
            "message.dispatch",
            "message.dispatch",
            "delegated_task.request"
        ]
    );
    assert!(
        fixture
            .native
            .lock()
            .unwrap()
            .parent_runs
            .iter()
            .all(|run| run["status"] != "queued")
    );
    successor.abort();
    callback.abort();
    forge_server.abort();
    assert!(successor.await.unwrap_err().is_cancelled());
    assert!(callback.await.unwrap_err().is_cancelled());
    assert!(forge_server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn a_reserved_role_waiting_to_send_keeps_the_parent_snoozed() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let (mut worker, _, _) = reservation(ID, Entry::Brief, &service.fixture().start);
    let launch = worker.run().unwrap().launch().clone();
    fixture.child(&launch.thread, false);
    let row = {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &worker,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        state.set_wait(ID, Some(WaitReason::HostUnknown));
        service.desire_title(&mut state, &worker, None);
        service.lookup(&state, ID).unwrap()
    };
    let board = fixture.board_task().await;
    assert_eq!(board["stateLabel"], "Starting");
    assert!(board["waitDetail"].is_null());
    assert!(
        board["lifecycle"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| step["note"] == "Starting")
    );
    let ready = Observed::Known(Host::Current {
        instance: launch.instance.clone(),
        state: RunState::ReadyToSend,
    });
    service.observe_role_state(&row, &ready).await.unwrap();
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);

    worker.record_send(&launch.instance, now_ms()).unwrap();
    let sent = service
        .save(&row, worker, &event("host_send"))
        .await
        .unwrap();
    assert_eq!(
        crate::titles::task_state_label(&sent.task, Some(WaitReason::Starting), None),
        "Working"
    );
    service.observe_role_state(&sent, &ready).await.unwrap();
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
}

#[tokio::test]
async fn restart_preserves_a_prerequisite_snooze_before_the_first_dispatch_decision() {
    let mut fixture = Fixture::new(&pending_task()).await;
    let (worker, _, _) = reservation(ID, Entry::Brief, &fixture.service.fixture().start);
    fixture.seed_prerequisite(&worker).await;
    let row = fixture.service.task(ID).await.unwrap();
    let wait = Ok(Action::Wait(WaitReason::Prerequisite));
    fixture
        .service
        .schedule_result(&row, &wait, Priority::Decision)
        .await
        .unwrap();
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    fixture.sync().await;
    let receipt = fixture.observed_snooze().await;

    fixture.restart();
    assert_eq!(fixture.attention().await, TaskAttention::Waiting);
    assert!(fixture.sync().await.is_empty());
    let row = fixture.service.task(ID).await.unwrap();
    fixture
        .service
        .schedule_result(&row, &wait, Priority::Decision)
        .await
        .unwrap();
    assert!(fixture.sync().await.is_empty());
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    assert_eq!(fixture.observed_snooze().await, receipt);
}

#[tokio::test]
async fn a_reserved_reviewer_without_a_native_thread_allows_the_capacity_snooze() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let (task, _, _) = crate::tests::reserved_reviewer(ID, &service.fixture().start);
    let run = task.run().unwrap().launch();
    let worker = task.threads().get(Role::Worker).unwrap();
    assert_ne!(worker, run.thread);
    fixture.child(worker, false);
    let row = {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("run_reserved"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        service.desire_title(&mut state, &task, None);
        service.lookup(&state, ID).unwrap()
    };
    service
        .observe_role_state(
            &row,
            &Observed::Known(Host::Current {
                instance: run.instance.clone(),
                state: RunState::ReadyToSend,
            }),
        )
        .await
        .unwrap();
    service
        .schedule_result(
            &row,
            &Err(service.parent_not_sent("waiting for shell confirmation")),
            Priority::Effect,
        )
        .await
        .unwrap();
    assert_eq!(
        fixture.sync().await.get("orchestration.dispatchCommand"),
        Some(&1)
    );
    assert!(fixture.sync().await.is_empty());
    service
        .schedule_result(
            &row,
            &Ok(Action::Wait(WaitReason::Capacity)),
            Priority::Effect,
        )
        .await
        .unwrap();
    let card = fixture.board_task().await;
    assert_eq!(card["stateLabel"], "Waiting for a slot");
    assert_eq!(card["attention"], "waiting");
    fixture
        .native
        .lock()
        .unwrap()
        .child
        .as_mut()
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("pendingBackgroundTasks");
    assert!(fixture.sync().await.is_empty());
    fixture.child(worker, true);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    fixture.elapse_visibility_ms(HANDOVER_MS);
    fixture.child(worker, false);
    fixture.sync().await;
    assert!(fixture.sync().await.is_empty());
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "thread.snooze"]
    );
    fixture.observed_snooze().await;
}
