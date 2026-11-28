use super::*;

#[tokio::test]
async fn native_rows_follow_dependency_wait_run_and_question() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    let service = &fixture.service;
    let (mut worker, credential, mut observation) =
        reservation(ID, Entry::Brief, &service.fixture().start);
    fixture.seed_prerequisite(&pending).await;
    assert_eq!(fixture.attention().await, TaskAttention::Waiting);
    fixture.sync().await;
    fixture.sync().await;
    assert!(fixture.observed_snooze().await.until_ms > now_ms() + RENEW_BEFORE_MS);
    assert_eq!(fixture.commands(), ["thread.snooze"]);

    let instance = worker.run().unwrap().launch().instance.clone();
    worker.record_send(&instance, 1).unwrap();
    let row = {
        let mut state = service.state.lock().await;
        let prior = service.lookup(&state, ID).unwrap();
        state
            .store
            .save_brief_with_dependencies(
                &prior,
                &pending,
                &event("dependency_released"),
                &[],
                None,
            )
            .unwrap();
        let released = service.lookup(&state, ID).unwrap();
        service
            .commit(&mut state, &released, &worker, &event("run_reserved"), None)
            .unwrap();
        service.lookup(&state, ID).unwrap()
    };
    let observed = |state| {
        Observed::Known(Host::Current {
            instance: instance.clone(),
            state,
        })
    };
    service
        .observe_role_state(&row, &observed(RunState::Running))
        .await
        .unwrap();
    assert_eq!(fixture.attention().await, TaskAttention::Active);
    fixture.child(&worker.run().unwrap().launch().thread, true);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);

    service
        .observe_role_state(&row, &observed(RunState::Permission))
        .await
        .unwrap();
    assert_eq!(fixture.attention().await, TaskAttention::Attention);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);

    service
        .observe_role_state(&row, &observed(RunState::IdleWithoutTerminalRun))
        .await
        .unwrap();
    assert!(fixture.sync().await.is_empty());
    fixture.child(&worker.run().unwrap().launch().thread, false);
    fixture.sync().await;
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "thread.snooze"]
    );

    worker
        .record_report(
            &instance,
            credential.as_bytes(),
            Report::Question {
                prompt: "Which copy?".into(),
                options: vec!["Short".into(), "Long".into()],
            },
        )
        .unwrap();
    observation.host = observed(RunState::Ended);
    worker.reconcile(&observation);
    {
        let mut state = service.state.lock().await;
        service
            .commit(&mut state, &row, &worker, &event("question_asked"), None)
            .unwrap();
        state
            .observe_wait(&worker, Some(WaitReason::Question))
            .unwrap();
    }
    let card = fixture.board_task().await;
    assert_eq!(card["stateLabel"], "Working · planner");
    assert_eq!(card["attention"], "waiting");
    fixture.sync().await;
    assert_eq!(
        fixture.commands(),
        [
            "thread.snooze",
            "thread.unsnooze",
            "thread.snooze",
            "thread.unsnooze"
        ]
    );
}

#[tokio::test]
async fn a_planner_question_stays_visible_regardless_of_child_activity() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let head = &service.fixture().start;
    let (mut task, credential, mut observation) = reservation(ID, Entry::ReviewEntry, head);
    let run = task.run().unwrap().launch().clone();
    task.record_send(&run.instance, 1).unwrap();
    task.record_report(
        &run.instance,
        credential.as_bytes(),
        Report::Review {
            head: head.clone(),
            decision: Review::Approve,
            summary: "Approve the exact head".into(),
            finding_titles: Vec::new(),
        },
    )
    .unwrap();
    observation.host = Observed::Known(Host::Current {
        instance: run.instance,
        state: RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Merging)
    );
    let Observed::Known(Forge::Open { checks, .. }) = &mut observation.forge else {
        panic!("open fixture PR");
    };
    *checks = CheckState::Blocked;
    assert_eq!(
        task.reconcile(&observation),
        Action::Ask(Question::Repair(Repair::MergeBlocked))
    );
    {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        state
            .observe_wait(&task, Some(WaitReason::Question))
            .unwrap();
        service.desire_title(&mut state, &task, None);
    }
    let card = fixture.board_task().await;
    assert_eq!(card["phase"], "merging");
    assert_eq!(card["attention"], "waiting");
    assert_eq!(card["stateLabel"], "Merging · planner");
    fixture.child(&run.thread, true);
    fixture.sync().await;
    assert!(fixture.commands().is_empty());
    fixture.child(&run.thread, false);
    fixture.sync().await;
    fixture.sync().await;
    assert!(fixture.commands().is_empty());
}

#[tokio::test]
async fn an_actionable_row_retries_its_claimed_clear_with_the_same_command() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    let service = &fixture.service;
    {
        let mut state = service.state.lock().await;
        state.store.create(&pending, &event("fixture")).unwrap();
        service.desire_title(&mut state, &pending, None);
    }
    fixture.sync().await;
    fixture.sync().await;
    let mut claim = fixture.observed_snooze().await;
    claim.clear_attempted_for = Some(claim.until_ms);
    let old_horizon = fixture.native.lock().unwrap().until.clone();
    let frozen = snooze_command(ID, &fixture.thread, RowChange::Unsnooze, &claim);
    service
        .restore_row_snooze(ID, &fixture.thread, Some(&claim))
        .await
        .unwrap();
    {
        let mut state = service.state.lock().await;
        state
            .observe_wait(&pending, Some(WaitReason::Permission))
            .unwrap();
    }
    assert_eq!(fixture.attention().await, TaskAttention::Attention);

    fixture.native.lock().unwrap().next_reply = NextReply::Lost;
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    fixture.sync().await;

    // An operator restores the identical horizon before the next shell observation.
    fixture.native.lock().unwrap().until = old_horizon.clone();
    fixture.sync().await;
    fixture.sync().await;
    let native = fixture.native.lock().unwrap();
    assert_eq!(native.commands.len(), 3);
    assert_eq!(native.commands[1]["commandId"], frozen);
    assert_eq!(native.commands[2]["commandId"], frozen);
    assert_eq!(native.until, old_horizon);
}

#[tokio::test]
async fn pre_delivery_wakes_owned_and_settled_rows_and_preserves_operator_snooze() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    let service = &fixture.service;
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&pending, &event("fixture")).unwrap();
        service.desire_title(&mut state, &pending, None);
        service.lookup(&state, ID).unwrap()
    };
    fixture.sync().await;
    let publish_shell = || {
        let revision = 1 + fixture.native.lock().unwrap().commands.len();
        fixture.publish_shell_at(Some(revision));
    };
    publish_shell();
    let fence = service.effect(&row).await.unwrap();
    let prepare = |label: &str| {
        let command = format!("{}-hold-acp-0:{PROVIDER}~{label}", fixture.thread);
        fixture.prepare_hold(label, Some(&command))
    };
    let write = prepare("owned");
    fixture
        .service
        .visibility_time
        .store(1_893_456_002_000, std::sync::atomic::Ordering::Relaxed);
    assert!(service.deliver_parent(&row, write, None).await.unwrap());
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
    assert_eq!(fixture.commands(), ["thread.snooze", "message.dispatch"]);
    drop(fence);
    fixture.elapse_visibility_ms(HANDOVER_MS);
    fixture.sync().await;
    assert!(fixture.sync().await.is_empty());
    fixture.observed_snooze().await;
    let fence = service.effect(&row).await.unwrap();
    {
        let mut native = fixture.native.lock().unwrap();
        native.until = json!(OPERATOR_SNOOZE);
        native.settled_at = json!("2026-11-23T18:10:00Z");
    }
    publish_shell();
    let snoozed_hold = prepare("snoozed");
    assert!(
        service
            .deliver_parent(&row, snoozed_hold, None)
            .await
            .unwrap()
    );
    publish_shell();
    service.reconcile_delivery_snoozes().await.unwrap();
    assert_eq!(
        fixture.commands()[3..],
        ["message.dispatch", "thread.snooze"]
    );
    assert_eq!(fixture.native.lock().unwrap().until, OPERATOR_SNOOZE);
    observe_restored_delivery_snooze(&fixture).await;

    fixture.native.lock().unwrap().until = Value::Null;
    publish_shell();
    let write = prepare("awake");
    let (sent, calls) =
        nucleus_hosts::T3::count_pass_calls(Box::pin(service.host.write_parent(write, |_| Ok(()))))
            .await;
    sent.unwrap();
    service
        .schedule_result(&row, &Ok(Action::Nothing), Priority::Effect)
        .await
        .unwrap();
    assert!(!calls.contains_key("orchestration.subscribeThread"));
    assert_eq!(calls.get("orchestration.dispatchCommand"), Some(&1));
    assert_eq!(fixture.commands()[5..], ["message.dispatch"]);
    drop(fence);

    assert_terminal_forgets_snooze(&fixture).await;
}

#[tokio::test]
async fn a_pass_leaves_a_stored_pending_row_refresh_unsent() {
    let task = pending_task();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    service
        .state
        .lock()
        .await
        .store
        .create(&task, &event("fixture"))
        .unwrap();
    // A held task prepares no launch, so any message here would be the refresh.
    let operator = Authority::Operator {
        actor: "fixture".into(),
    };
    let row = service
        .command(ID, &operator, Command::Hold("Wait".into()))
        .await
        .unwrap();
    // The row an earlier engine froze before it could confirm the send.
    let command = format!("{}-refresh-1", fixture.thread);
    let text = "Nucleus refreshes the current task row.";
    let wire = json!({
        "binding":fixture.binding, "method":"continue", "provider":PROVIDER,
        "payload":{"type":"message.dispatch","commandId":command,"threadId":fixture.thread,
            "messageId":"fixture-refresh-message","text":text,"attachments":[],
            "createdBy":"user","creationSource":"server",
            "dispatchMode":{"type":"queue_after_active"}},
    })
    .to_string();
    let db = rusqlite::Connection::open(service.storage.database().path().join("engine.sqlite"))
        .unwrap();
    db.execute(
        "INSERT INTO parent_refresh_deliveries (task_id,version,command,wire,due_ms,result)
         VALUES (?1,?2,?3,?4,0,'pending')",
        rusqlite::params![ID, row.version, command, wire],
    )
    .unwrap();
    fixture.publish_shell_at(Some(1));

    let result = Box::pin(service.advance_due_task(&row, &service.host.fixture_pass())).await;

    assert!(fixture.commands().is_empty(), "{result:?}");
    let stored: (String, String) = db
        .query_row(
            "SELECT command, result FROM parent_refresh_deliveries WHERE task_id=?1",
            [ID],
            |stored| Ok((stored.get(0)?, stored.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, (command, "pending".into()));
}

#[tokio::test]
async fn a_pass_forgets_a_planner_notice_wait_it_does_not_renew() {
    let task = pending_task();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    service
        .state
        .lock()
        .await
        .store
        .create(&task, &event("fixture"))
        .unwrap();
    // A held task waits on no planner notice.
    let operator = Authority::Operator {
        actor: "fixture".into(),
    };
    let row = service
        .command(ID, &operator, Command::Hold("Wait".into()))
        .await
        .unwrap();
    service
        .state
        .lock()
        .await
        .planner_notice_waiters
        .insert(ID.into());
    fixture.publish_shell_at(Some(1));

    let result = Box::pin(service.advance_due_task(&row, &service.host.fixture_pass())).await;

    assert!(
        matches!(result, Ok(Action::Wait(WaitReason::Hold))),
        "{result:?}"
    );
    assert!(
        !service
            .state
            .lock()
            .await
            .planner_notice_waiters
            .contains(ID)
    );
}

#[tokio::test]
async fn launch_preparation_can_unarchive_before_recording_a_hold() {
    let mut task = pending_task();
    let fixture = Fixture::new(&task).await;
    let (_, _, observation) = reservation(ID, Entry::Brief, &fixture.service.fixture().start);
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    let service = &fixture.service;
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        service.lookup(&state, ID).unwrap()
    };
    let archive = json!({
        "id":fixture.thread,"projectId":fixture.binding.project_id,
        "worktreePath":fixture.binding.worktree_path,"branch":fixture.binding.branch,
        "providerInstanceId":PROVIDER,
        "modelSelection":{"instanceId":PROVIDER,"model":"nucleus"},
        "archivedAt":"2026-11-27T00:00:00Z","status":"completed",
        "activeRunId":null,"pendingRuntimeRequest":null,"pendingBackgroundTasks":[]
    });
    service.host.fixture_project_shell(
        &json!({"snapshotSequence":18,"projects":[],"threads":[archive]}),
        PROVIDER,
    );
    let write = service
        .host
        .prepare_parent_unarchive(&fixture.binding, PROVIDER)
        .await
        .unwrap()
        .unwrap();
    assert!(service.deliver_parent(&row, write, None).await.unwrap());
    assert_eq!(fixture.commands(), ["thread.unarchive"]);
    assert!(
        service
            .state
            .lock()
            .await
            .store
            .current_parent_hold(ID)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn an_active_role_publishes_its_frozen_parent_prompt() {
    let head: nucleus_core::Head = "1".repeat(40).parse().unwrap();
    let (mut task, _, _) = reservation(ID, Entry::Brief, &head);
    let launch = task.run().unwrap().launch().clone();
    task.record_send(&launch.instance, 1).unwrap();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    fixture.child(&launch.thread, true);
    fixture.native.lock().unwrap().child.as_mut().unwrap()["worktreePath"] =
        json!(fixture.binding.worktree_path);
    fixture.publish_shell();
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        service.lookup(&state, ID).unwrap()
    };

    let mut changes = service.changes();
    let prompt = "Continue the active worker.";
    let write = fixture.prepare_hold(prompt, None);
    let frozen = write.freeze().prompt().unwrap().to_owned();
    let _fence = service.effect(&row).await.unwrap();
    assert!(service.deliver_parent(&row, write, None).await.unwrap());
    let change = changes.try_recv().unwrap();
    assert_eq!(change.task_id, ID);
    assert_eq!(change.version, row.version);
    assert!(change.detail_only);
    let mut state = service.state.lock().await;
    assert_eq!(
        service.acp_turn_view(&state, &row).unwrap(),
        (Some(frozen.clone()), false)
    );
    state.settings.dispatch = Some(nucleus_store::DispatchSettings {
        mode: nucleus_store::DispatchMode::Stopped,
        ..Default::default()
    });
    assert_eq!(service.acp_turn_view(&state, &row).unwrap(), (None, false));
    state.settings.dispatch = None;
    assert_eq!(
        service.acp_turn_view(&state, &row).unwrap(),
        (Some(frozen), false)
    );
    fixture.child(&launch.thread, false);
    fixture.publish_shell();
    assert_eq!(service.acp_turn_view(&state, &row).unwrap(), (None, false));
}

#[tokio::test]
async fn the_held_parent_follows_the_child_across_an_authenticated_report() {
    use nucleus_core::{Observation, PullRequest, Workspace};

    let head: nucleus_core::Head = "1".repeat(40).parse().unwrap();
    let (mut task, credential, _) = reservation(ID, Entry::Brief, &head);
    let launch = task.run().unwrap().launch().clone();
    task.record_send(&launch.instance, 1).unwrap();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    fixture.child(&launch.thread, true);
    fixture.native.lock().unwrap().child.as_mut().unwrap()["worktreePath"] =
        json!(fixture.binding.worktree_path);
    fixture.publish_shell();
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        service.lookup(&state, ID).unwrap()
    };
    service.reconcile_live_parent(&row).await.unwrap();
    let record = fixture.parent_record(&row).await;
    let frozen = crate::acp::frozen_parent(&record).unwrap();
    let expected = (frozen.prompt().map(str::to_owned), false);
    let mut changes = service.changes();
    let pr = PullRequest {
        url: "https://github.com/inflatable-cookie/nucleus-fixture/pull/1".into(),
        head: head.clone(),
    };
    service
        .report(
            ID,
            &launch.instance,
            credential.as_bytes(),
            Report::Work(pr.clone().into()),
        )
        .await
        .unwrap();
    // Drop the report invalidation. No child-completion delta reaches the shell.
    assert_eq!(changes.recv().await.unwrap().task_id, ID);
    let mut state = service.state.lock().await;
    let row = service.lookup(&state, ID).unwrap();
    assert_eq!(service.acp_turn_view(&state, &row).unwrap(), expected);
    let mut next = row.task.clone();
    let action = next.reconcile(&Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Open {
            pr,
            checks: CheckState::Ready,
        }),
        workspace: Observed::Known(Workspace::Clean(head)),
    });
    assert_eq!(action, Action::Advance(Phase::Reviewing));
    service
        .commit(&mut state, &row, &next, &event("phase_reconciled"), None)
        .unwrap();
    let change = changes.try_recv().unwrap();
    let next = service.lookup(&state, &change.task_id).unwrap();
    assert_eq!(change.version, next.version);
    assert_eq!(service.acp_turn_view(&state, &next).unwrap(), expected);
    assert_eq!(fixture.commands(), ["message.dispatch"]);
    assert_eq!(
        state
            .store
            .current_parent_hold(ID)
            .unwrap()
            .unwrap()
            .command,
        record.command
    );
}

#[tokio::test]
async fn a_retained_role_waiting_on_background_work_keeps_one_hold_after_restart() {
    let (mut fixture, row) = instant_parent_fixture().await;
    fixture.service.reconcile_live_parent(&row).await.unwrap();
    let first = fixture.parent_record(&row).await;
    {
        let mut native = fixture.native.lock().unwrap();
        let run = native.parent_runs.last_mut().unwrap();
        run["status"] = json!("running");
        run["completedAt"] = Value::Null;
    }
    fixture.restart();
    {
        let service = &fixture.service;
        let mut state = service.state.lock().await;
        state.registry_mode = true;
        assert_eq!(
            service.acp_turn_view(&state, &row).unwrap(),
            (
                crate::acp::frozen_parent(&first)
                    .unwrap()
                    .prompt()
                    .map(str::to_owned),
                false,
            )
        );
        state.registry_mode = false;
    }
    fixture.publish_shell();

    let (result, calls) =
        nucleus_hosts::T3::count_pass_calls(Box::pin(fixture.service.reconcile_live_parent(&row)))
            .await;
    result.unwrap();
    assert!(
        calls.is_empty(),
        "held shell supplies the parent and role evidence"
    );
    let service = &fixture.service;
    let state = service.state.lock().await;
    assert_eq!(
        service.acp_turn_view(&state, &row).unwrap().0.as_deref(),
        crate::acp::frozen_parent(&first).unwrap().prompt()
    );
    assert_eq!(fixture.commands(), ["message.dispatch"]);
}

#[tokio::test]
async fn short_holds_back_off_to_a_cap_and_resume_without_a_role_change() {
    let (fixture, row) = instant_parent_fixture().await;
    let service = &fixture.service;
    service.reconcile_live_parent(&row).await.unwrap();
    for count in 1..=9 {
        // Reserve room for slow filesystems without sleeping past each backoff.
        let shown_completion = now_ms() + 120_000;
        {
            let mut native = fixture.native.lock().unwrap();
            let finished = native.parent_runs.last_mut().unwrap();
            finished["startedAt"] = json!(native_timestamp(shown_completion - 100));
            finished["completedAt"] = json!(native_timestamp(shown_completion));
        }
        fixture.publish_shell();
        let result = service
            .reconcile_live_parent(&row)
            .await
            .map(|()| Action::Nothing);
        let Err(ServiceError::ParentHoldBackoff { until }) = &result else {
            panic!("expected a short-hold delay, got {result:?}");
        };
        let delay = (3_000_u64 << (count - 1)).min(300_000);
        let remaining = until.saturating_duration_since(tokio::time::Instant::now());
        let due = now_ms() + u64::try_from(remaining.as_millis()).unwrap();
        assert!(due.abs_diff(shown_completion + delay) < 1_000);
        service
            .schedule_result(&row, &result, Priority::Decision)
            .await
            .unwrap();
        let board = fixture.board_task().await;
        assert!(
            board["waitDetail"]
                .as_str()
                .unwrap()
                .contains("under a second")
        );
        let record = fixture.parent_record(&row).await;
        let completed = now_ms().saturating_sub(delay + 1_000);
        let db =
            rusqlite::Connection::open(service.storage.database().path().join("engine.sqlite"))
                .unwrap();
        assert_eq!(db.execute(
            "UPDATE parent_deliveries SET wire=json_set(wire, '$.checkpoint.recorded_at_ms', ?2)
             WHERE command=?1",
            rusqlite::params![record.command, crate::acp::ms(completed - 500)],
        ).unwrap(), 1);
        {
            let mut native = fixture.native.lock().unwrap();
            let finished = native.parent_runs.last_mut().unwrap();
            finished["startedAt"] = json!(native_timestamp(completed - 100));
            finished["completedAt"] = json!(native_timestamp(completed));
        }
        fixture.publish_shell();
        service.reconcile_live_parent(&row).await.unwrap();
        let next = fixture.parent_record(&row).await;
        assert_ne!(next.command, record.command);
        assert_eq!(
            crate::acp::frozen_parent(&next)
                .unwrap()
                .checkpoint()
                .unwrap()
                .short_turns,
            count
        );
        assert_eq!(fixture.commands().len(), usize::from(count) + 1);
    }
    fixture.native.lock().unwrap().finish_live_hold();
    fixture.publish_shell();
    service.reconcile_live_parent(&row).await.unwrap();
    let record = fixture.parent_record(&row).await;
    assert_eq!(
        crate::acp::frozen_parent(&record)
            .unwrap()
            .checkpoint()
            .unwrap()
            .short_turns,
        0
    );
}

#[tokio::test]
async fn a_queued_run_waits_for_the_start_deadline_without_replacing_the_hold_after_restart() {
    let (mut fixture, row) = instant_parent_fixture().await;
    fixture.service.reconcile_live_parent(&row).await.unwrap();
    let first = fixture.parent_record(&row).await;
    {
        let mut native = fixture.native.lock().unwrap();
        let queued = native.parent_runs.last_mut().unwrap();
        queued["status"] = json!("queued");
        queued["startedAt"] = Value::Null;
        queued["completedAt"] = Value::Null;
    }
    fixture.restart();
    fixture.publish_shell();
    let service = &fixture.service;
    let (result, calls) =
        nucleus_hosts::T3::count_pass_calls(Box::pin(service.reconcile_live_parent(&row))).await;
    assert!(matches!(result, Err(ServiceError::ParentRetry { .. })));
    assert!(calls.is_empty());
    {
        let state = service.state.lock().await;
        state
            .store
            .finish_parent_delivery(
                ID,
                row.version,
                &first,
                nucleus_store::ParentResult::Accepted,
                0,
            )
            .unwrap();
    }
    service.reconcile_live_parent(&row).await.unwrap();
    let second = fixture.parent_record(&row).await;
    assert_ne!(first.command, second.command);
    let frozen = crate::acp::frozen_parent(&second).unwrap();
    assert_eq!(
        frozen.checkpoint().unwrap().after_run.as_deref(),
        Some("parent-run-0")
    );
    assert_eq!(fixture.commands(), ["message.dispatch"; 2]);
}

#[tokio::test]
async fn snoozed_closing_row_publishes_only_the_stable_title_without_a_visibility_write() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let head = &service.fixture().start;
    let (mut task, mut observation) = crate::tests::code_task_at_merge(ID, head);
    observation.forge = Observed::Known(Forge::Merged {
        pr: task.pull_request().unwrap().clone(),
        commit: head.clone(),
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Closing)
    );
    let row = create_visibility_row(&fixture, &task).await;
    let snooze = fixture.observed_snooze().await;
    let old = "Starting: #1 Synthetic change";
    fixture.native.lock().unwrap().title = Some(old.into());
    let generation = {
        let state = service.state.lock().await;
        state.store.desire_title(ID, &fixture.thread, old).unwrap();
        let prior = state.store.pending_title(&fixture.thread).unwrap().unwrap();
        state.store.confirm_title(&prior).unwrap();
        prior.generation
    };
    for result in [
        Err(service.parent_not_sent("waiting for the host")),
        Ok(Action::Wait(WaitReason::ForgeUnknown)),
    ] {
        fixture.publish_shell();
        service
            .schedule_result(&row, &result, Priority::Effect)
            .await
            .unwrap();
        let state = service.state.lock().await;
        assert!(
            state
                .store
                .pending_title(&fixture.thread)
                .unwrap()
                .is_none()
        );
    }
    {
        let mut state = service.state.lock().await;
        state
            .title_candidates
            .get_mut(&fixture.thread)
            .unwrap()
            .ready = tokio::time::Instant::now();
    }
    let title = "Closing · GitHub: #1 Synthetic change";
    {
        let mut watcher = std::pin::pin!(service.watch_titles());
        tokio::time::timeout(
            Duration::from_secs(30),
            std::future::poll_fn(|cx| {
                assert!(watcher.as_mut().poll(cx).is_pending());
                if fixture.native.lock().unwrap().title.as_deref() == Some(title) {
                    fixture.publish_shell();
                }
                if service.state.try_lock().is_ok_and(|state| {
                    state
                        .store
                        .title_state(&fixture.thread)
                        .unwrap()
                        .is_some_and(|stored| stored.confirmed && stored.receipt.desired == title)
                }) {
                    std::task::Poll::Ready(())
                } else {
                    std::task::Poll::Pending
                }
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            fixture.native.lock().unwrap().commands.last().unwrap(),
            &json!({
                "type":"thread.metadata.update", "threadId":fixture.thread,
                "commandId":format!("task-{ID}-title-{}", generation + 1), "title":title,
            })
        );
        assert!(fixture.sync().await.is_empty());
        assert_eq!(fixture.observed_snooze().await, snooze);
    }
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.metadata.update"]
    );
}

#[tokio::test]
async fn active_child_keeps_ownership_until_the_shell_observes_the_clear() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let (task, _, _) = crate::tests::reserved_reviewer(ID, &service.fixture().start);
    create_visibility_row(&fixture, &task).await;
    let owned = fixture.observed_snooze().await;
    fixture.child("reviewer", true);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    let prior = service.host.row_visibility_hint(&fixture.thread).unwrap();
    assert_eq!(prior.snoozed_until_ms, Some(owned.until_ms));
    assert_eq!(fixture.native.lock().unwrap().until, Value::Null);
    let receipt = fixture.observed_snooze().await;
    assert_eq!(receipt.clear_attempted_for, Some(owned.until_ms));
    assert!(receipt.owns(prior.snoozed_until_ms));
    service
        .reconcile_task_row(ID, PROVIDER, &fixture.thread)
        .await
        .unwrap();
    assert_eq!(fixture.commands().len(), 2);
    fixture.sync().await;
    assert!(
        service
            .state
            .lock()
            .await
            .store
            .row_snooze(ID, &fixture.thread)
            .unwrap()
            .is_none()
    );
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.sync().await;
    assert_eq!(fixture.native.lock().unwrap().until, OPERATOR_SNOOZE);
    assert_eq!(fixture.commands().len(), 2);
}

#[tokio::test]
async fn background_work_keeps_the_row_visible_and_clears_an_owned_snooze() {
    let fixture = Fixture::new(&pending_task()).await;
    let (task, _, _) = crate::tests::reserved_reviewer(ID, &fixture.service.fixture().start);
    fixture
        .service
        .visibility_time
        .store(1_893_456_000_000, std::sync::atomic::Ordering::Relaxed);
    create_visibility_row(&fixture, &task).await;
    fixture.child("worker", false);
    {
        let mut native = fixture.native.lock().unwrap();
        let child = native.child.as_mut().unwrap();
        // The captured thread.updated shell row is completed despite the thread read waiting.
        child.as_object_mut().unwrap().remove("parentThreadId");
        child["lineage"] = json!({"parentThreadId":fixture.thread,
            "rootThreadId":fixture.thread,"relationshipToParent":"subagent"});
        child["archivedAt"] = Value::Null;
        child["deletedAt"] = Value::Null;
        child["latestRunId"] = json!("worker-run");
        child["latestRunStartedAt"] = json!("2029-12-31T23:59:50Z");
        child["latestRunCompletedAt"] = json!("2030-01-01T00:00:00Z");
        child["pendingBackgroundTasks"] =
            json!([{"kind":"monitor", "taskId":"monitor", "awaited":true}]);
    }
    let child = fixture.native.lock().unwrap().child.clone().unwrap();
    fixture.service.host.fixture_shell_delta(
        &json!({"kind":"thread.updated", "sequence":3, "location":"active", "thread":child}),
    );
    let calls = fixture.sync_held().await;
    assert_eq!(calls, [("orchestration.dispatchCommand", 1)].into());
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    assert!(fixture.sync().await.is_empty());
    fixture.elapse_visibility_ms(120_001);
    assert!(fixture.sync().await.is_empty());
    {
        let state = fixture.service.state.lock().await;
        assert_eq!(fixture.service.working_row_count(&state).unwrap(), 1);
    }

    let child = {
        let mut native = fixture.native.lock().unwrap();
        let child = native.child.as_mut().unwrap();
        child["pendingBackgroundTasks"] = json!([]);
        child.clone()
    };
    fixture.service.host.fixture_shell_delta(
        &json!({"kind":"thread.updated", "sequence":4, "location":"active", "thread":child}),
    );
    let calls = fixture.sync_held().await;
    assert_eq!(calls, [("orchestration.dispatchCommand", 1)].into());
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "thread.snooze"]
    );
    assert!(fixture.sync().await.is_empty());
    fixture.observed_snooze().await;
    {
        let state = fixture.service.state.lock().await;
        assert_eq!(fixture.service.working_row_count(&state).unwrap(), 0);
    }

    let child = {
        let mut native = fixture.native.lock().unwrap();
        let child = native.child.as_mut().unwrap();
        child["pendingBackgroundTasks"] =
            json!([{"kind":"monitor", "taskId":"monitor", "awaited":true}]);
        child.clone()
    };
    fixture.service.host.fixture_shell_delta(
        &json!({"kind":"thread.updated", "sequence":5, "location":"active", "thread":child}),
    );
    let calls = fixture.sync_held().await;
    assert_eq!(calls, [("orchestration.dispatchCommand", 1)].into());
    assert_eq!(
        fixture.commands(),
        [
            "thread.snooze",
            "thread.unsnooze",
            "thread.snooze",
            "thread.unsnooze"
        ]
    );
    assert!(fixture.sync().await.is_empty());
    let state = fixture.service.state.lock().await;
    assert_eq!(fixture.service.working_row_count(&state).unwrap(), 1);
    assert!(
        state
            .store
            .row_snooze(ID, &fixture.thread)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn operator_snooze_alone_does_not_create_a_wait() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let (task, _, _) = reservation(ID, Entry::Brief, &service.fixture().start);
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.publish_shell();
    {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        let row = service.lookup(&state, ID).unwrap();
        assert_eq!(state.effective_wait(&task).unwrap(), None);
        service.desire_phase_title(&mut state, &task, row.number);
        assert!(
            state
                .store
                .pending_title(&fixture.thread)
                .unwrap()
                .unwrap()
                .desired
                .starts_with("Working:")
        );
    }
    let card = fixture.board_task().await;
    assert_eq!(card["stateLabel"], "Working");
    assert!(card["wait"].is_null());
    assert!(card["waitDetail"].is_null());
}

#[tokio::test]
async fn operator_snooze_preserves_the_real_wait_on_each_surface() {
    let mut task = pending_task();
    let observation = nucleus_core::Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(nucleus_core::Workspace::Absent),
    };
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    let fixture = Fixture::new(&task).await;
    fixture.seed_prerequisite(&task).await;
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.publish_shell();
    let service = &fixture.service;
    let row = service.task(ID).await.unwrap();
    {
        let mut state = service.state.lock().await;
        // A stale capacity observation must not hide the prerequisite.
        state
            .observe_wait(&task, Some(WaitReason::Capacity))
            .unwrap();
        assert_eq!(
            state.effective_wait(&task).unwrap(),
            Some(WaitReason::Prerequisite)
        );
        service.desire_phase_title(&mut state, &task, row.number);
        assert!(
            state
                .store
                .pending_title(&fixture.thread)
                .unwrap()
                .unwrap()
                .desired
                .starts_with("Waiting for #1:")
        );
    }
    assert_eq!(fixture.board_task().await["stateLabel"], "Waiting for #1");
    let key = [2; 32];
    let api = router(
        Arc::clone(service),
        [Controller {
            credential: key,
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
    );
    let request = || {
        Request::get("/v1/tasks/row/next")
            .header("host", "127.0.0.1:9")
            .header("authorization", format!("Bearer {}", hex::encode(key)))
            .body(Body::empty())
            .unwrap()
    };
    let response = api.clone().oneshot(request()).await.unwrap();
    let next: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(next["stateLabel"], "Waiting for #1");
    assert!(next["waitDetail"].as_str().unwrap().contains("#1"));

    task.command(
        Command::Hold("After fixture#192".into()),
        &Authority::Planner {
            actor: "planner".into(),
        },
        &observation,
    )
    .unwrap();
    {
        let mut state = service.state.lock().await;
        service
            .commit(&mut state, &row, &task, &event("fixture_hold"), None)
            .unwrap();
        service.desire_phase_title(&mut state, &task, row.number);
        assert!(
            state
                .store
                .pending_title(&fixture.thread)
                .unwrap()
                .unwrap()
                .desired
                .starts_with("Held by planner:")
        );
    }
    assert_eq!(fixture.board_task().await["stateLabel"], "Held by planner");
    let response = api.oneshot(request()).await.unwrap();
    let next: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap();
    assert_eq!(next["stateLabel"], "Held by planner");
    assert_eq!(next["hold"]["reason"], "After fixture#192");
    assert_eq!(next["waitDetail"], "After fixture#192");
}

#[tokio::test]
async fn a_handover_holds_the_parent_and_uses_the_child_completion_deadline() {
    let mut fixture = Fixture::new(&pending_task()).await;
    let (task, _, _) = crate::tests::reserved_reviewer(ID, &fixture.service.fixture().start);
    let clock = 1_893_456_000_000;
    fixture
        .service
        .visibility_time
        .store(clock, std::sync::atomic::Ordering::Relaxed);
    let row = create_visibility_row(&fixture, &task).await;
    let write = fixture.prepare_hold("Starting reviewer", None);
    let prompt = write.freeze().prompt().unwrap().to_owned();
    let hold = nucleus_store::ParentDelivery {
        version: row.version,
        command: write.command_id().unwrap().into(),
        wire: serde_json::to_string(write.freeze()).unwrap(),
        due_ms: 0,
        result: nucleus_store::ParentResult::Pending,
    };
    assert!(
        fixture
            .service
            .state
            .lock()
            .await
            .store
            .freeze_parent_delivery(ID, &hold)
            .unwrap()
    );
    fixture.child("worker", true);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    fixture.child("worker", false);
    fixture.native.lock().unwrap().child.as_mut().unwrap()["latestRunCompletedAt"] =
        json!("2030-01-01T00:00:00Z");
    fixture.sync().await;
    fixture.elapse_visibility_ms(119_999);
    fixture.restart();
    fixture.sync().await;
    {
        let service = &fixture.service;
        let mut state = service.state.lock().await;
        service.desire_phase_title(&mut state, &row.task, row.number);
        let title = state.store.pending_title(&fixture.thread).unwrap().unwrap();
        assert!(title.desired.starts_with("Waiting:"));
        assert!(!service.desire_title(&mut state, &row.task, row.number));
        assert!(!state.title_candidates.contains_key(&fixture.thread));
        assert_eq!(service.working_row_count(&state).unwrap(), 1);
        assert_eq!(
            fixture.service.acp_turn_view(&state, &row).unwrap(),
            (Some(prompt), false)
        );
    }
    fixture.child("reviewer", true);
    fixture.sync().await;
    fixture
        .service
        .state
        .lock()
        .await
        .title_candidates
        .get_mut(&fixture.thread)
        .unwrap()
        .ready = tokio::time::Instant::now();
    fixture.sync().await;
    {
        let state = fixture.service.state.lock().await;
        assert!(
            state
                .store
                .pending_title(&fixture.thread)
                .unwrap()
                .unwrap()
                .desired
                .starts_with("Reviewing:")
        );
    }
    fixture.child("reviewer", false);
    fixture.native.lock().unwrap().child.as_mut().unwrap()["latestRunCompletedAt"] =
        json!("2030-01-01T00:01:59.999Z");
    fixture.elapse_visibility_ms(119_999);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    fixture.elapse_visibility_ms(1);
    fixture.sync().await;
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "thread.snooze"]
    );
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.child("reviewer", true);
    fixture.sync().await;
    assert_eq!(fixture.native.lock().unwrap().until, OPERATOR_SNOOZE);
    let state = fixture.service.state.lock().await;
    let title = state.store.pending_title(&fixture.thread).unwrap().unwrap();
    assert_eq!(fixture.service.working_row_count(&state).unwrap(), 0);
    assert!(title.desired.starts_with("Reviewing:"));
    assert_eq!(fixture.commands().len(), 3);
}

#[tokio::test]
async fn a_handover_publishes_permission_and_planner_titles_immediately() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let (mut task, _, _) = crate::tests::reserved_reviewer(ID, &service.fixture().start);
    service
        .visibility_time
        .store(1_893_456_000_000, std::sync::atomic::Ordering::Relaxed);
    fixture.child("worker", false);
    fixture.native.lock().unwrap().child.as_mut().unwrap()["latestRunCompletedAt"] =
        json!("2030-01-01T00:00:00Z");
    fixture.publish_shell();

    let mut state = service.state.lock().await;
    state.store.create(&task, &event("fixture")).unwrap();
    let row = service.lookup(&state, ID).unwrap();
    assert!(service.role_window(&fixture.thread, &task).2.is_some());
    let pending_title =
        |state: &crate::State| state.store.pending_title(&fixture.thread).unwrap().unwrap();
    service.desire_title(&mut state, &task, row.number);
    assert!(pending_title(&state).desired.starts_with("Waiting:"));

    state.set_wait(ID, Some(WaitReason::Permission));
    service.desire_title(&mut state, &task, row.number);
    assert!(
        pending_title(&state)
            .desired
            .starts_with("Reviewing · permission:")
    );
    assert!(!state.title_candidates.contains_key(&fixture.thread));

    assert!(task.ask_allowance(2, 1));
    service
        .commit(&mut state, &row, &task, &event("fixture_question"), None)
        .unwrap();
    assert!(
        pending_title(&state)
            .desired
            .starts_with("Reviewing · planner:")
    );
    assert!(!state.title_candidates.contains_key(&fixture.thread));
}

#[tokio::test]
async fn a_child_starting_after_planning_prevents_the_parent_snooze() {
    let fixture = Fixture::new(&pending_task()).await;
    fixture.publish_shell();
    let host = &fixture.service.host;
    let target = host
        .title_target(
            &fixture.binding,
            PROVIDER,
            fixture.service.fixture().checkout.to_str().unwrap(),
        )
        .unwrap();
    fixture.child("late-writer", true);
    host.fixture_shell_delta(&json!({"kind":"thread.updated","location":"active",
        "sequence":2,"thread":fixture.native.lock().unwrap().child}));
    let (result, calls) = nucleus_hosts::T3::count_pass_calls(Box::pin(host.write_row_visibility(
        &fixture.binding,
        "late-snooze",
        RowChange::SnoozeUntil(now_ms() + HORIZON_MS),
        &target,
        (&[], 0),
    )))
    .await;
    assert!(matches!(
        result,
        Err(ParentSendError::NotSent(
            nucleus_hosts::HostError::RowChildBusy
        ))
    ));
    assert!(!calls.contains_key("orchestration.dispatchCommand"));
    assert!(fixture.commands().is_empty());
}
