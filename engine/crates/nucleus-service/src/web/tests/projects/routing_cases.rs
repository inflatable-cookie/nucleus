use super::*;

#[tokio::test]
async fn planners_coexist_and_archive_revokes_only_the_closed_binding() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    let task = registry.task("alpha-planner", "first").await;
    registry.enroll("next-planner").await;
    let api = &registry.api;
    let detail = "/v1/tasks/first";
    assert_eq!(
        caller_request(api, Method::GET, detail, "alpha-planner", Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        caller_request(api, Method::GET, detail, "next-planner", Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        registry
            .service
            .responsible_planner(&task, false)
            .await
            .expect("delivery route")
            .as_deref(),
        Some("alpha-planner")
    );
    let attempt = T3::prepare_notice(
        "alpha-planner".into(),
        "fixture-notice".into(),
        "Synthetic notice",
    )
    .unwrap();
    let stale = registry
        .service
        .host
        .authorize_notice(&attempt)
        .await
        .unwrap()
        .unwrap();
    registry.archived.store(true, Ordering::Relaxed);
    let archived = json!({
        "kind": "thread.updated", "sequence": 17,
        "thread": {"id": "alpha-planner", "projectId": "alpha-native",
            "archivedAt": "2026-11-23T18:10:00Z"},
    });
    registry.service.host.fixture_shell_delta(&archived);
    registry
        .service
        .wake_from_host(nucleus_hosts::ThreadHint::fixture(&archived).expect("archive event"))
        .await;
    assert_eq!(
        caller_request(api, Method::GET, detail, "alpha-planner", Value::Null)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        caller_request(api, Method::GET, detail, "next-planner", Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    assert!(matches!(
        registry
            .service
            .dispatch_gate(&task, DispatchTarget::Planner(&stale))
            .await,
        Err(ServiceError::Host(HostError::Binding))
    ));
    assert_eq!(
        registry
            .service
            .responsible_planner(&task, false)
            .await
            .expect("fallback planner")
            .as_deref(),
        Some("next-planner")
    );
}

#[tokio::test]
async fn task_notice_delivery_stays_spent_across_restart() {
    for kind in [
        TaskNotice::Report,
        TaskNotice::Prerequisite,
        TaskNotice::Completion,
    ] {
        let registry = kind.fixture().await;
        assert_eq!(
            advance_task_notice(&registry).await.unwrap(),
            Action::Nothing
        );
        assert!(!kind.pending(&registry.service).await);
        registry.archived.store(true, Ordering::Relaxed);
        let registry = registry.reopen();
        assert_idle_notice(&registry).await;
        let fixture = registry.notices.lock().unwrap();
        assert_eq!(fixture.sends.len(), 1);
        assert_eq!(fixture.sends[0]["threadId"], "alpha-planner");
        assert_eq!(fixture.sends[0]["accepted"], true);
        if matches!(kind, TaskNotice::Completion) {
            let text = fixture.sends[0]["text"].as_str().unwrap();
            assert!(!text.contains("Reply:"));
            assert!(!text.contains("nreply_"));
        }
    }
}

#[tokio::test]
async fn exact_task_notice_rejection_allows_one_fresh_attempt_after_restart() {
    for kind in [
        TaskNotice::Report,
        TaskNotice::Prerequisite,
        TaskNotice::Completion,
    ] {
        let registry = kind.fixture().await;
        registry.notices.lock().unwrap().next_reply = NoticeReply::Rejected;
        advance_task_notice(&registry).await.unwrap();
        assert!(kind.pending(&registry.service).await);
        assert_eq!(registry.notices.lock().unwrap().sends.len(), 1);

        registry.archived.store(true, Ordering::Relaxed);
        let registry = registry.reopen();
        registry.notices.lock().unwrap().next_reply = NoticeReply::Rejected;
        assert_eq!(
            advance_task_notice(&registry).await.unwrap(),
            Action::Nothing
        );
        assert!(!kind.pending(&registry.service).await);
        {
            let fixture = registry.notices.lock().unwrap();
            let [original, retry] = fixture.sends.as_slice() else {
                panic!("expected exactly two native sends");
            };
            assert_eq!(original["threadId"], "alpha-planner");
            assert_eq!(retry["threadId"], "next-planner");
            assert_ne!(original["commandId"], retry["commandId"]);
            assert_ne!(original["messageId"], retry["messageId"]);
            assert_eq!(original["text"], retry["text"]);
            assert_eq!(original["accepted"], false);
            assert_eq!(retry["accepted"], false);
        }
        let registry = registry.reopen();
        assert_idle_notice(&registry).await;

        if matches!(kind, TaskNotice::Prerequisite) {
            // A separate release starts with its own retry allowance.
            release_notice(&registry).await;
            registry.notices.lock().unwrap().next_reply = NoticeReply::Rejected;
            advance_task_notice(&registry).await.unwrap();
            assert!(kind.pending(&registry.service).await);
            let registry = registry.reopen();
            advance_task_notice(&registry).await.unwrap();
            assert!(!kind.pending(&registry.service).await);
            let fixture = registry.notices.lock().unwrap();
            assert_eq!(fixture.sends.len(), 4);
            assert_ne!(fixture.sends[0]["commandId"], fixture.sends[2]["commandId"]);
            assert_eq!(fixture.sends[3]["accepted"], true);
        }
    }
}

#[tokio::test]
async fn lost_reply_or_rejection_for_another_command_keeps_both_task_notices_closed() {
    for kind in [
        TaskNotice::Report,
        TaskNotice::Prerequisite,
        TaskNotice::Completion,
    ] {
        for reply in [NoticeReply::Lost, NoticeReply::WrongCommand] {
            let registry = kind.fixture().await;
            registry.notices.lock().unwrap().next_reply = reply;
            let result = advance_task_notice(&registry).await;
            if matches!(kind, TaskNotice::Report) {
                assert!(matches!(result, Err(ServiceError::Host(_))));
            } else {
                assert_eq!(result.unwrap(), Action::Nothing);
            }
            assert!(!kind.pending(&registry.service).await);
            registry.archived.store(true, Ordering::Relaxed);
            let registry = registry.reopen();
            assert_idle_notice(&registry).await;
            let fixture = registry.notices.lock().unwrap();
            assert_eq!(fixture.sends.len(), 1);
            assert_eq!(fixture.sends[0]["threadId"], "alpha-planner");
            assert_eq!(fixture.sends[0]["accepted"], reply == NoticeReply::Lost);
        }
    }
}

#[tokio::test]
async fn report_notice_reverifies_a_persisted_origin_after_reopen_without_a_cli_call() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("next-planner").await;
    seed_ready_report(&registry.service, "report", false).await;
    seed_ready_report(&registry.service, "already-spent", true).await;
    let registry = registry.reopen();
    {
        let state = registry.service.state.lock().await;
        assert!(
            state.enrolled_planners.is_empty(),
            "disk records confer no authority"
        );
        assert!(state.settings.planner_route("alpha-planner").is_some());
        assert!(state.settings.planner_route("next-planner").is_some());
    }
    let outcomes = notice_pass(&registry.service, "report").await;
    assert_eq!(outcomes.len(), 1, "the legacy spent row stays closed");
    assert_eq!(outcomes[0].task, "report");
    assert!(matches!(outcomes[0].result, Ok(Action::Nothing)));
    let fixture = registry.notices.lock().expect("notices");
    assert_eq!(fixture.sends.len(), 1);
    assert_eq!(fixture.sends[0]["threadId"], "alpha-planner");
    assert!(
        fixture.sends[0]["text"]
            .as_str()
            .expect("notice text")
            .contains("qa v3")
    );
}

#[tokio::test]
async fn report_notice_waits_for_a_planner_then_dispatches_once() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    seed_ready_report(&registry.service, "report", false).await;
    registry.archived.store(true, Ordering::Relaxed);
    let outcomes = notice_pass(&registry.service, "report").await;
    assert!(matches!(
        outcomes[0].result,
        Ok(Action::Wait(WaitReason::Question))
    ));
    let row = registry
        .service
        .task("report")
        .await
        .expect("pending report");
    assert!(!row.task.report_task().expect("report").notice_attempted);
    assert!(registry.notices.lock().expect("notices").sends.is_empty());
    let registry = registry.reopen();
    assert!(
        registry
            .service
            .state
            .lock()
            .await
            .settings
            .planner_route("alpha-planner")
            .is_none()
    );
    let outcomes = notice_pass(&registry.service, "report").await;
    assert!(matches!(
        outcomes[0].result,
        Ok(Action::Wait(WaitReason::Question))
    ));
    registry.notices.lock().expect("notices").settled = true;
    // Enrollment must wake the notice without relying on a previously scheduled recheck.
    registry.service.state.lock().await.schedule.park("report");
    registry.enroll("next-planner").await;
    let outcomes = notice_pass(&registry.service, "report").await;
    assert!(matches!(outcomes[0].result, Ok(Action::Nothing)));
    let sent = registry.service.task("report").await.expect("sent report");
    assert!(sent.task.report_task().expect("report").notice_attempted);
    let registry = registry.reopen();
    assert!(matches!(
        Box::pin(registry.service.notify_report_ready(&sent)).await,
        Ok(Action::Nothing)
    ));
    let fixture = registry.notices.lock().expect("notices");
    assert!(fixture.controls.is_empty());
    assert_eq!(fixture.sends.len(), 1);
    assert_eq!(fixture.sends[0]["threadId"], "next-planner");
    assert_eq!(
        fixture.sends[0]["dispatchMode"]["type"],
        "queue_after_active"
    );
}

#[tokio::test]
async fn an_uncertain_cold_origin_cannot_route_or_lose_its_persisted_binding() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("next-planner").await;
    seed_ready_report(&registry.service, "report", false).await;
    let registry = registry.reopen();
    registry.notices.lock().expect("notices").uncertain_planner = true;
    let outcomes = notice_pass(&registry.service, "report").await;
    assert!(matches!(
        outcomes[0].result,
        Err(ServiceError::Host(HostError::Uncertain))
    ));
    assert!(registry.notices.lock().expect("notices").sends.is_empty());
    let registry = registry.reopen();
    let state = registry.service.state.lock().await;
    assert!(state.settings.planner_route("alpha-planner").is_some());
    assert!(state.live_planner_project("alpha-planner").is_none());
}

#[tokio::test]
async fn a_work_question_remains_unbound_until_its_planner_notice_can_be_sent() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    let (mut task, credential, mut observation) = {
        let state = registry.service.state.lock().await;
        let (_, repo) = state
            .settings
            .planner_route("alpha-planner")
            .expect("route");
        let head = git(&repo.path, &["rev-parse", "HEAD"])
            .parse()
            .expect("base head");
        reservation("question", Entry::Brief, &head)
    };
    let instance = task.run().expect("worker").launch().instance.clone();
    task.record_report(
        &instance,
        credential.as_bytes(),
        Report::Question {
            prompt: "Which greeting should the worker use?".into(),
            options: Vec::new(),
        },
    )
    .expect("worker question");
    observation.host = Observed::Known(Host::Current {
        instance,
        state: RunState::Ended,
    });
    assert!(matches!(task.reconcile(&observation), Action::Ask(_)));
    seed_task(&registry.service, &task).await;
    let response = caller_request(
        &registry.api,
        Method::POST,
        "/v1/tasks/question/commands",
        "alpha-planner",
        json!({"answer":{"work":"Use the fixture greeting"}}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert!(
        json_body(response).await["error"]
            .as_str()
            .unwrap()
            .contains("not been delivered")
    );
    registry.archived.store(true, Ordering::Relaxed);
    let pending = registry
        .service
        .task("question")
        .await
        .expect("open question");
    assert!(matches!(
        registry.service.notify_question(&pending).await,
        Ok(Action::Wait(WaitReason::Question))
    ));
    assert_eq!(
        registry
            .service
            .task("question")
            .await
            .expect("no send intent"),
        pending
    );
    assert!(registry.notices.lock().expect("notices").sends.is_empty());

    registry.enroll("next-planner").await;
    assert!(matches!(
        registry.service.notify_question(&pending).await,
        Ok(Action::Wait(WaitReason::Question))
    ));
    let sent = registry
        .service
        .task("question")
        .await
        .expect("bound question");
    let receipt = sent.task.question_delivery().expect("exact native receipt");
    assert_eq!(receipt.thread, "next-planner");
    let registry = registry.reopen();
    registry.notices.lock().expect("notices").started = true;
    assert!(matches!(
        registry.service.notify_question(&sent).await,
        Ok(Action::Wait(WaitReason::Question))
    ));
    let fixture = registry.notices.lock().expect("notices");
    assert_eq!(fixture.sends.len(), 1);
    assert_eq!(fixture.sends[0]["commandId"], receipt.command);
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one routing scenario keeps its sends and receipts together"
)]
async fn project_tell_routes_to_verified_same_and_cross_project_planners() {
    let registry = registry().await;
    registry.enroll("next-planner").await;
    registry.enroll("alpha-planner").await;
    registry.enroll("beta-planner").await;
    let (alpha, beta) = {
        let state = registry.service.state.lock().await;
        (
            state
                .live_planner_project("alpha-planner")
                .expect("alpha")
                .to_owned(),
            state
                .live_planner_project("beta-planner")
                .expect("beta")
                .to_owned(),
        )
    };
    let alpha_name = {
        let state = registry.service.state.lock().await;
        state.settings.projects.as_ref().unwrap().projects[&alpha]
            .name
            .clone()
    };
    let reads = registry.reads.load(Ordering::Relaxed);
    let broadcast = || {
        registry.tell(
            "alpha-planner",
            json!("all"),
            "Synthetic cross-project note",
        )
    };
    let original = broadcast().await;
    assert_eq!(original.status(), StatusCode::OK);
    let original = json_body(original).await;
    assert_eq!(
        original["deliveries"].as_array().expect("receipts").len(),
        2
    );
    for receipt in original["deliveries"].as_array().expect("receipts") {
        assert_eq!(receipt["status"], "queued");
        assert_eq!(receipt["fromProject"], alpha);
    }
    assert_eq!(
        registry.reads.load(Ordering::Relaxed),
        reads,
        "admission is local"
    );
    registry.notices.lock().expect("notices").settled = true;
    for _ in 0..2 {
        registry.advance_tell().await.expect("scheduler delivery");
    }
    let staged = json_body(broadcast().await).await;
    assert_eq!(staged, original, "native acceptance still reports queued");
    {
        let fixture = registry.notices.lock().expect("notices");
        assert!(fixture.controls.is_empty());
        assert_eq!(fixture.sends.len(), 2);
        let threads: std::collections::BTreeSet<_> = fixture
            .sends
            .iter()
            .map(|send| send["threadId"].as_str().expect("thread ID"))
            .collect();
        assert_eq!(
            threads,
            std::collections::BTreeSet::from(["next-planner", "beta-planner"])
        );
        for send in &fixture.sends {
            assert_eq!(send["dispatchMode"]["type"], "queue_after_active");
            let text = send["text"].as_str().expect("message text");
            assert!(text.starts_with(&format!("From {alpha_name}")));
            assert!(text.contains("Synthetic cross-project note"));
        }
    }
    registry.notices.lock().expect("notices").started = true;
    for _ in 0..2 {
        registry.advance_tell().await.expect("scheduler receipt");
    }
    let delivered = json_body(broadcast().await).await;
    for (prior, after) in original["deliveries"]
        .as_array()
        .unwrap()
        .iter()
        .zip(delivered["deliveries"].as_array().unwrap())
    {
        assert_eq!(after["messageId"], prior["messageId"]);
        assert_eq!(after["status"], "delivered");
        assert!(after["deliveredAtMs"].is_u64());
    }
    let duplicate = json_body(
        registry
            .tell(
                "alpha-planner",
                json!([&beta, "Exact T3 Alpha", &alpha]),
                "Synthetic cross-project note",
            )
            .await,
    )
    .await;
    assert_eq!(
        duplicate, delivered,
        "canonical recipients dedupe across aliases and broadcasts"
    );
}

#[tokio::test]
async fn project_tell_verifies_callers_and_refuses_ambiguous_requests_without_host_reads() {
    let registry = registry().await;
    let actor = "alpha-planner";
    let unknown_actor = "unknown-caller";
    let unverified = registry
        .inline_command(
            unknown_actor,
            registry.tell(unknown_actor, json!("all"), "test"),
        )
        .await;
    assert_eq!(unverified.status(), StatusCode::FORBIDDEN);
    registry.enroll(actor).await;
    registry.enroll("beta-planner").await;
    let reads = registry.reads.load(Ordering::Relaxed);
    let unknown = registry
        .tell(actor, json!(["Exact T3 Alpha", "missing"]), "test")
        .await;
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    assert!(
        json_body(unknown).await["error"]
            .as_str()
            .unwrap()
            .contains("no project named")
    );
    {
        let mut state = registry.service.state.lock().await;
        for project in state
            .settings
            .projects
            .as_mut()
            .unwrap()
            .projects
            .values_mut()
        {
            project.name = "Shared name".into();
        }
    }
    let ambiguous = registry.tell(actor, json!("shared name"), "test").await;
    assert_eq!(ambiguous.status(), StatusCode::BAD_REQUEST);
    assert!(
        json_body(ambiguous).await["error"]
            .as_str()
            .unwrap()
            .contains("ambiguous")
    );
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads);
    let state = registry.service.state.lock().await;
    assert!(state.store.next_tell().expect("empty queue").is_none());
}

#[tokio::test]
async fn project_tell_retries_an_empty_snapshot_and_reuses_real_receipts() {
    let registry = registry().await;
    let source = "alpha-planner";
    registry.enroll(source).await;
    let settings = &registry.service.settings;
    let current = settings.read::<nucleus_store::Projects>().unwrap();
    let (updated, _) = settings
        .edit(
            &current.revision,
            |projects: &mut nucleus_store::Projects| {
                projects.projects.insert(
                    "unbound".into(),
                    nucleus_store::ProjectSettings {
                        planner_claim: None,
                        claimed_planner_threads: Vec::new(),
                        name: "Unbound project".into(),
                        archived: false,
                        repositories: Vec::new(),
                    },
                );
                Ok(())
            },
        )
        .unwrap();
    registry.service.state.lock().await.settings.projects = Some(updated.value);
    let pending = json_body(
        registry
            .tell(source, json!("all"), "Will wait for a planner")
            .await,
    )
    .await;
    assert_eq!(pending["deliveries"], json!([]));
    assert_eq!(pending["noLivePlanners"][0]["name"], "Exact T3 Alpha");
    assert_eq!(pending["noLivePlanners"][1]["name"], "Unbound project");
    assert!(registry.notices.lock().unwrap().sends.is_empty());
    registry.enroll("beta-planner").await;
    let replay = json_body(
        registry
            .tell(source, json!("all"), "Will wait for a planner")
            .await,
    )
    .await;
    assert_eq!(replay["deliveries"].as_array().unwrap().len(), 1);
    assert_eq!(replay["noLivePlanners"], pending["noLivePlanners"]);
    assert_eq!(
        json_body(
            registry
                .tell(source, json!("all"), "Will wait for a planner")
                .await
        )
        .await,
        replay
    );
    let unbound = json_body(
        registry
            .tell(source, json!("Unbound project"), "No unrelated fallback")
            .await,
    )
    .await;
    assert_eq!(unbound["deliveries"], json!([]));
    assert_eq!(
        unbound["noLivePlanners"],
        json!([pending["noLivePlanners"][1]])
    );
    assert!(
        registry
            .service
            .state
            .lock()
            .await
            .store
            .next_tell()
            .unwrap()
            .is_some()
    );
    assert!(registry.notices.lock().unwrap().sends.is_empty());
}

#[tokio::test]
async fn project_tell_rechecks_only_saved_cold_recipients_before_admitting_a_request() {
    let registry = registry().await;
    registry.enroll("beta-planner").await;
    registry.enroll("alpha-planner").await;
    let registry = registry.reopen();
    registry.enroll("beta-planner").await;
    let send = || registry.tell("beta-planner", json!("Exact T3 Alpha"), "After restart");
    let reads = registry.reads.load(Ordering::Relaxed);
    let response = registry.inline_command("alpha-planner", send()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads + 1);
    let result = json_body(response).await;
    assert_eq!(result["deliveries"].as_array().unwrap().len(), 1);
    assert_eq!(result["noLivePlanners"], json!([]));
    let reads = registry.reads.load(Ordering::Relaxed);
    assert_eq!(result, json_body(send().await).await);
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads);
    assert!(registry.notices.lock().unwrap().sends.is_empty());
}

#[tokio::test]
async fn project_tell_routes_the_verified_subset_after_one_uncertain_recipient_check() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("next-planner").await;
    registry.enroll("beta-planner").await;
    let registry = registry.reopen();
    registry.enroll("next-planner").await;
    registry.enroll("beta-planner").await;
    let send = || registry.tell("next-planner", json!("all"), "Cold recipient");
    assert_eq!(send().await.status(), StatusCode::SERVICE_UNAVAILABLE);
    let actor = registry.service.take_enrollment().await.unwrap();
    assert_eq!(actor, "alpha-planner");
    registry.notices.lock().unwrap().uncertain_planner = true;
    registry.service.complete_enrollment(&actor).await;
    let result = json_body(send().await).await;
    assert_eq!(result["deliveries"].as_array().unwrap().len(), 1);
    assert_eq!(result["noLivePlanners"][0]["name"], "Exact T3 Alpha");
    assert_eq!(result, json_body(send().await).await);
    let state = registry.service.state.lock().await;
    assert!(state.settings.planner_route(&actor).is_some());
    assert!(state.live_planner_project(&actor).is_none());
    assert_eq!(
        result["deliveries"][0]["to"].as_str(),
        state.live_planner_project("beta-planner")
    );
}

#[tokio::test]
async fn project_tell_cannot_reenroll_a_removed_recipient_route() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("beta-planner").await;
    let registry = registry.reopen();
    registry.enroll("beta-planner").await;
    let send = || registry.tell("beta-planner", json!("Exact T3 Alpha"), "Cold recipient");
    assert_eq!(send().await.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        registry
            .service
            .state
            .lock()
            .await
            .store
            .next_tell()
            .unwrap()
            .is_none()
    );
    let actor = registry.service.take_enrollment().await.unwrap();
    // Settings can remove the binding between the request and its scheduled check.
    {
        let mut state = registry.service.state.lock().await;
        let projects = &mut state.settings.projects.as_mut().unwrap().projects;
        for repository in projects.values_mut().flat_map(|p| &mut p.repositories) {
            repository.planner_threads.retain(|thread| thread != &actor);
        }
    }
    registry.service.complete_enrollment(&actor).await;
    let result = json_body(send().await).await;
    assert_eq!(result["deliveries"], json!([]));
    assert_eq!(result["noLivePlanners"][0]["name"], "Exact T3 Alpha");
    assert!(
        registry
            .service
            .state
            .lock()
            .await
            .settings
            .planner_route(&actor)
            .is_none()
    );
    assert!(registry.notices.lock().unwrap().sends.is_empty());
}

#[tokio::test]
async fn project_tell_reads_back_an_unknown_send_without_replaying_it() {
    let registry = registry().await;
    let source = "alpha-planner";
    registry.enroll(source).await;
    registry.enroll("beta-planner").await;
    let beta = registry
        .service
        .state
        .lock()
        .await
        .live_planner_project("beta-planner")
        .unwrap()
        .to_owned();
    let notice = json_body(
        registry
            .tell(source, json!(&beta), "Uncertain fixture")
            .await,
    )
    .await;
    registry.notices.lock().unwrap().next_reply = NoticeReply::Uncertain;
    assert!(matches!(
        registry.advance_tell().await,
        Err(ServiceError::Host(HostError::Uncertain))
    ));
    let reopened =
        nucleus_store::Store::open(&registry.service.storage).expect("reopen durable queue");
    let persisted = reopened
        .next_tell()
        .expect("retained notice")
        .expect("notice");
    assert!(matches!(
        persisted.state,
        nucleus_store::TellState::InFlight(_)
    ));
    let unknown = json_body(
        registry
            .tell(source, json!(&beta), "Uncertain fixture")
            .await,
    )
    .await;
    assert_eq!(
        unknown["deliveries"][0]["messageId"],
        notice["deliveries"][0]["messageId"]
    );
    assert_eq!(unknown["deliveries"][0]["status"], "uncertain");
    registry.service.advance_tell(&persisted).await.unwrap();
    {
        let mut fixture = registry.notices.lock().unwrap();
        assert_eq!(fixture.sends.len(), 1);
        fixture.sends[0]["accepted"] = json!(true);
        fixture.started = true;
    }
    registry
        .advance_tell()
        .await
        .expect("late exact observation");
    let delivered = json_body(
        registry
            .tell(source, json!(&beta), "Uncertain fixture")
            .await,
    )
    .await;
    assert_eq!(delivered["deliveries"][0]["status"], "delivered");
    assert_eq!(
        delivered["deliveries"][0]["messageId"],
        notice["deliveries"][0]["messageId"]
    );
    assert_eq!(registry.notices.lock().unwrap().sends.len(), 1);
}

#[tokio::test]
async fn project_tell_retries_a_proven_rejection_and_falls_back_after_archive() {
    let registry = registry().await;
    registry.enroll("next-planner").await;
    registry.enroll("alpha-planner").await;
    registry.enroll("beta-planner").await;
    let queued = registry
        .tell(
            "beta-planner",
            json!("Exact T3 Alpha"),
            "Retry after rejection",
        )
        .await;
    assert_eq!(queued.status(), StatusCode::OK);
    registry.notices.lock().unwrap().next_reply = NoticeReply::Rejected;
    registry.advance_tell().await.expect("proven rejection");
    registry.archived.store(true, Ordering::Relaxed);
    registry
        .advance_tell()
        .await
        .expect("closed planner invalidated");
    registry
        .advance_tell()
        .await
        .expect("verified fallback receives notice");
    let fixture = registry.notices.lock().unwrap();
    assert_eq!(fixture.sends.len(), 2);
    assert_eq!(fixture.sends[0]["threadId"], "alpha-planner");
    assert_eq!(fixture.sends[1]["threadId"], "next-planner");
    assert_ne!(fixture.sends[0]["commandId"], fixture.sends[1]["commandId"]);
}

#[tokio::test]
async fn registry_gate_refuses_cross_project_wrong_push_remote_and_moved_native_root() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("beta-planner").await;
    let service = &registry.service;
    let alpha = registry.task("alpha-planner", "first").await;
    let beta = registry.task("beta-planner", "second").await;
    let worktrees = service.worktrees();
    let alpha_route = service
        .project_for(alpha.identity())
        .await
        .expect("first route");
    let beta_route = service
        .project_for(beta.identity())
        .await
        .expect("second route");
    let alpha_tree = worktrees
        .checkout(&alpha_route.checkout, ALPHA_REPO, "first")
        .expect("first tree");
    let beta_tree = worktrees
        .checkout(&beta_route.checkout, BETA_REPO, "second")
        .expect("second tree");
    let alpha_binding = alpha_route.binding(&alpha_tree).expect("first binding");
    let beta_binding = beta_route.binding(&beta_tree).expect("second binding");
    let mut alpha_launch = alpha.clone();
    for (task, tree, binding) in [
        (&alpha, &alpha_tree, &alpha_binding),
        (&beta, &beta_tree, &beta_binding),
    ] {
        let route = service.project_for(task.identity()).await.expect("route");
        let head = service
            .verify_route(task.identity(), &route)
            .await
            .expect("checked base");
        tree.allocate(&head).expect("synthetic worktree");
        let permit = service
            .dispatch_gate(task, run_target(tree, binding))
            .await
            .expect("verified destination");
        assert!(permit.is_some());
        assert!(
            service.project_writes.try_write().is_err(),
            "the permit fences settings publication"
        );
        if task == &alpha {
            occupy_slot(&mut alpha_launch, &head);
        }
    }
    assert!(matches!(
        service
            .dispatch_gate(&alpha, run_target(&beta_tree, &beta_binding))
            .await,
        Err(ServiceError::Host(HostError::Binding))
    ));
    let prior = service.task("first").await.expect("task");
    service
        .save(&prior, alpha_launch, &event("fixture"))
        .await
        .expect("reserve and occupy first slot");
    assert_project_slots(&registry, &beta).await;

    push_origin(&alpha_route.checkout, "example/wrong");
    assert!(matches!(
        service
            .dispatch_gate(&alpha, run_target(&alpha_tree, &alpha_binding))
            .await,
        Err(ServiceError::Project)
    ));
    push_origin(&alpha_route.checkout, ALPHA_REPO);
    registry.moved.store(true, Ordering::Relaxed);
    service.host.fixture_project_shell(
        &json!({"projects":[
            {"id":"alpha-native","workspaceRoot":beta_route.checkout},
            {"id":"beta-native","workspaceRoot":beta_route.checkout}
        ],"threads":[]}),
        "fixture-acp",
    );
    let reads = registry.reads.load(Ordering::Relaxed);
    assert!(matches!(
        service
            .dispatch_gate(&alpha, run_target(&alpha_tree, &alpha_binding))
            .await,
        Err(ServiceError::Host(HostError::Binding))
    ));
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads);
}

#[tokio::test]
async fn project_removal_rechecks_open_work_and_operator_authority() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    let projects = registry
        .service
        .settings
        .read::<nucleus_store::Projects>()
        .unwrap();
    let id = projects.value.projects.keys().next().unwrap();
    let removal = format!("{PROJECTS}/{id}/removal");
    let preview = json_body(get_as(&registry.api, &removal, &BOARD_KEY).await).await;
    assert_eq!(preview["tasks"], json!([]));
    let confirm = json!({"digest":preview["digest"], "reason":"Retired fixture"});
    for method in [Method::GET, Method::POST] {
        assert_eq!(
            caller_request(
                &registry.api,
                method,
                &removal,
                "alpha-planner",
                confirm.clone()
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }

    let mut edited = projects.value.clone();
    edited.projects.get_mut(id).unwrap().name = "Renamed fixture".into();
    assert_eq!(
        planning::put_as(
            &registry.api,
            PROJECTS,
            &BOARD_KEY,
            &json!({"revision":projects.revision,"value":edited})
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        post_as(&registry.api, &removal, &BOARD_KEY, &confirm)
            .await
            .status(),
        StatusCode::CONFLICT
    );

    registry.task("alpha-planner", "removal-blocker").await;
    let reply = post_as(&registry.api, &removal, &BOARD_KEY, &confirm).await;
    assert_eq!(reply.status(), StatusCode::CONFLICT);
    assert!(
        json_body(reply).await["error"]
            .as_str()
            .unwrap()
            .contains("open tasks")
    );
    let blocked = json_body(get_as(&registry.api, &removal, &BOARD_KEY).await).await;
    assert_eq!(blocked["tasks"][0]["taskId"], "removal-blocker");
    assert!(
        registry
            .service
            .settings
            .read::<nucleus_store::Projects>()
            .unwrap()
            .value
            .projects
            .contains_key(id)
    );
}

#[tokio::test]
async fn project_removal_deletes_planning_and_preserves_finished_repository_history() {
    use nucleus_store::planning::RecordKind;

    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    let snapshot = registry
        .service
        .settings
        .read::<nucleus_store::Projects>()
        .unwrap();
    let id = snapshot.value.projects.keys().next().unwrap();
    let removal = format!("{PROJECTS}/{id}/removal");
    registry.task("alpha-planner", "finished-removal").await;
    finish_removal_task(&registry, "finished-removal", None).await;
    let preview = json_body(get_as(&registry.api, &removal, &BOARD_KEY).await).await;
    let confirm = |digest: &Value| json!({"digest":digest, "reason":"Retired fixture"});
    seed_removal_planning(&registry, id).await;
    assert_eq!(
        post_as(
            &registry.api,
            &removal,
            &BOARD_KEY,
            &confirm(&preview["digest"])
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let preview = json_body(get_as(&registry.api, &removal, &BOARD_KEY).await).await;
    let confirmation = confirm(&preview["digest"]);
    let first = post_as(&registry.api, &removal, &BOARD_KEY, &confirmation).await;
    assert_eq!(first.status(), StatusCode::OK);
    let receipt = json_body(first).await;
    let original = &snapshot.value.projects[id].repositories[0];
    let saved = registry
        .service
        .settings
        .read::<nucleus_store::Projects>()
        .unwrap();
    assert_eq!(
        receipt,
        json!({
            "repositories":[{"origin":original.origin,"path":original.path}],
            "removedAtMs":saved.value.removed[id].removed_at_ms,
        })
    );

    {
        let state = registry.service.state.lock().await;
        assert_eq!(state.store.plan(id).unwrap().version, 0);
        assert!(state.store.lanes(id).unwrap().is_empty());
        assert!(state.store.items(id).unwrap().is_empty());
        assert!(state.store.decisions(id, false).unwrap().is_empty());
        assert!(
            state
                .store
                .planning_history(id, RecordKind::Lane, "release")
                .unwrap()
                .is_empty()
        );
    }
    let task_path = "/v1/tasks/finished-removal";
    let task = json_body(get_as(&registry.api, task_path, &BOARD_KEY).await).await;
    assert_eq!(task["phase"], "done");
    assert_eq!(task["identity"]["repository"], ALPHA_REPO);
    let registry = registry.reopen();
    assert_eq!(
        json_body(post_as(&registry.api, &removal, &BOARD_KEY, &confirmation).await).await,
        receipt
    );
    assert_retirement_history(&registry, task_path).await;
    registry.enroll("alpha-planner").await;
    assert!(
        !registry
            .service
            .settings
            .read::<nucleus_store::Projects>()
            .unwrap()
            .value
            .projects
            .contains_key(id)
    );
    assert!(matches!(
        registry
            .service
            .command(
                "finished-removal",
                &Authority::Operator {
                    actor: "fixture".into()
                },
                Command::Move(Phase::Working)
            )
            .await,
        Err(ServiceError::Project)
    ));
}

#[tokio::test]
async fn a_removed_projects_finished_tasks_are_no_longer_scheduled() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    let head = "a".repeat(40).parse::<Head>().unwrap();
    // One finished row, and one which still holds a leftover run record.
    let ids = ["removed-done", "removed-reserved"];
    for (id, leftover) in ids.into_iter().zip([None, Some(&head)]) {
        registry.task("alpha-planner", id).await;
        finish_removal_task(&registry, id, leftover).await;
    }
    let scheduled = |state: &crate::State| {
        let mut due = state.store.archive_due_ids(None, 32).unwrap();
        due.extend(
            state
                .store
                .active_ids(None, 32)
                .unwrap()
                .into_iter()
                .map(|seed| seed.id),
        );
        due.sort();
        due
    };
    assert_eq!(scheduled(&*registry.service.state.lock().await), ids);
    let id = removal_settings(&registry)
        .value
        .projects
        .into_keys()
        .next()
        .unwrap();
    let removal = format!("{PROJECTS}/{id}/removal");
    let preview = json_body(get_as(&registry.api, &removal, &BOARD_KEY).await).await;
    let confirmation = json!({"digest":preview["digest"], "reason":"Retired fixture"});
    assert_eq!(
        post_as(&registry.api, &removal, &BOARD_KEY, &confirmation)
            .await
            .status(),
        StatusCode::OK
    );
    {
        // A retry queued before the removal is still due.
        let mut state = registry.service.state.lock().await;
        assert!(scheduled(&state).is_empty());
        for id in ids {
            state.schedule.wake(
                id,
                tokio::time::Instant::now(),
                crate::schedule::Priority::Closeout,
            );
        }
    }
    let outcomes = registry.service.pass().await.unwrap();
    assert_eq!(outcomes.len(), ids.len());
    for outcome in outcomes {
        assert_eq!(outcome.result.unwrap(), Action::Nothing, "{}", outcome.task);
    }
    let state = registry.service.state.lock().await;
    for id in ids {
        assert_eq!(state.schedule.due(id), None, "{id}");
    }
}
