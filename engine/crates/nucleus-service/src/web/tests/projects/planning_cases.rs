use super::*;

#[tokio::test]
async fn item_assess_allows_parked_and_refuses_dropped_or_promoted_items() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    let alpha = registry
        .service
        .state
        .lock()
        .await
        .live_planner_project("alpha-planner")
        .expect("alpha")
        .to_owned();
    let items = format!("/v1/planning/{alpha}/items");
    let created = json_body(
        post_as(
            &registry.api,
            &items,
            &BOARD_KEY,
            &json!({"kind": "papercut", "title": "Parkable", "body": "Body"}),
        )
        .await,
    )
    .await;
    let id = created["id"].as_str().unwrap();

    assert_eq!(
        post_as(
            &registry.api,
            &format!("{items}/{id}/park"),
            &BOARD_KEY,
            &json!({"reason": "Later", "revisitAt": null}),
        )
        .await
        .status(),
        StatusCode::OK
    );
    let (v_parked, _) = item_latest_version(&registry.api, &alpha, id).await;
    assert_eq!(
        post_as(
            &registry.api,
            &format!("{items}/{id}/assess"),
            &BOARD_KEY,
            &json!({"version": v_parked}),
        )
        .await
        .status(),
        StatusCode::OK
    );

    assert_eq!(
        post_as(
            &registry.api,
            &format!("{items}/{id}/drop"),
            &BOARD_KEY,
            &json!({"disposition": "deprecated", "reason": "Done"}),
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        post_as(
            &registry.api,
            &format!("{items}/{id}/assess"),
            &BOARD_KEY,
            &json!({}),
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );

    let lead = json_body(
        post_as(
            &registry.api,
            &items,
            &BOARD_KEY,
            &json!({"kind": "lead", "title": "Ready", "body": "---\nqueue:\n  complexity: low\n---\nShip."}),
        )
        .await,
    )
    .await;
    let lead_id = lead["id"].as_str().unwrap();
    assert_eq!(
        post_as(
            &registry.api,
            &format!("{items}/{lead_id}/promote"),
            &BOARD_KEY,
            &json!({}),
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        post_as(
            &registry.api,
            &format!("{items}/{lead_id}/assess"),
            &BOARD_KEY,
            &json!({}),
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn item_assess_starts_one_claimed_planner_thread_when_project_has_no_thread() {
    let registry = registry().await;
    registry.enroll("beta-planner").await;
    let beta = registry
        .service
        .state
        .lock()
        .await
        .live_planner_project("beta-planner")
        .expect("beta")
        .to_owned();
    clear_project_planners(&registry, &beta, "Beta").await;

    let items = format!("/v1/planning/{beta}/items");
    let created = json_body(
        post_as(
            &registry.api,
            &items,
            &BOARD_KEY,
            &json!({"kind": "lead", "title": "Cold project lead", "body": "Needs a planner to assess."}),
        )
        .await,
    )
    .await;
    let id = created["id"].as_str().expect("item id").to_owned();
    let (v1, _) = item_latest_version(&registry.api, &beta, &id).await;

    let first = json_body(
        post_as(
            &registry.api,
            &format!("{items}/{id}/assess"),
            &BOARD_KEY,
            &json!({"version": v1}),
        )
        .await,
    )
    .await;
    let v2 = first["version"].as_i64().unwrap();
    assert_eq!(
        post_as(
            &registry.api,
            &format!("{items}/{id}/assess"),
            &BOARD_KEY,
            &json!({"version": v2}),
        )
        .await
        .status(),
        StatusCode::OK
    );
    let (_, entries) = item_latest_version(&registry.api, &beta, &id).await;
    assert_eq!(entries[1]["snapshot"]["recipient"], "new planner thread");
    assert_eq!(entries[2]["snapshot"]["recipient"], "new planner thread");

    registry
        .advance_tell()
        .await
        .expect("launch planner thread");
    let launched_thread = {
        let fixture = registry.notices.lock().expect("notices");
        assert_eq!(fixture.launches.len(), 1);
        let launch = &fixture.launches[0];
        assert_eq!(launch["projectId"], "beta-native");
        assert_eq!(launch["title"], "Beta planner");
        assert_eq!(
            launch["modelSelection"],
            json!({"instanceId": "codex", "model": "gpt-5"})
        );
        assert_eq!(launch["workspaceStrategy"]["type"], "root");
        let text = launch["initialMessage"]["text"].as_str().expect("prompt");
        assert!(text.contains("Cold project lead") && text.contains(&id));
        launch["threadId"].as_str().expect("thread id").to_owned()
    };
    {
        let state = registry.service.state.lock().await;
        let project = &state.settings.projects.as_ref().unwrap().projects[&beta];
        assert_eq!(
            project.planner_claim.as_ref().map(|c| c.thread.as_str()),
            Some(launched_thread.as_str())
        );
        assert!(
            project
                .repositories
                .iter()
                .any(|r| r.planner_threads.contains(&launched_thread))
        );
    }

    registry.advance_tell().await.expect("queue second assess");
    let fixture = registry.notices.lock().expect("notices");
    assert_eq!(fixture.launches.len(), 1, "exactly one thread started");
    assert_eq!(fixture.sends.len(), 1);
    assert_eq!(fixture.sends[0]["threadId"], launched_thread);
    assert_eq!(
        fixture.sends[0]["dispatchMode"]["type"],
        "queue_after_active"
    );
}

#[tokio::test]
async fn item_assess_with_archived_claimed_planner_and_no_fallback_records_new_thread_and_launches()
{
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    let alpha = registry
        .service
        .state
        .lock()
        .await
        .live_planner_project("alpha-planner")
        .expect("alpha")
        .to_owned();
    assert_eq!(
        caller_request(
            &registry.api,
            Method::POST,
            "/v1/planning/claim",
            "alpha-planner",
            json!({}),
        )
        .await
        .status(),
        StatusCode::OK
    );

    let items = format!("/v1/planning/{alpha}/items");
    let created = json_body(
        post_as(
            &registry.api,
            &items,
            &BOARD_KEY,
            &json!({"kind": "lead", "title": "Orphaned claim", "body": "Claimed planner is archived."}),
        )
        .await,
    )
    .await;
    let id = created["id"].as_str().expect("item id").to_owned();
    let (v1, _) = item_latest_version(&registry.api, &alpha, &id).await;

    // Archive the only claimed planner; no fallback thread exists.
    registry.archived.store(true, Ordering::Relaxed);
    let sent = post_as(
        &registry.api,
        &format!("{items}/{id}/assess"),
        &BOARD_KEY,
        &json!({"version": v1}),
    )
    .await;
    assert_eq!(sent.status(), StatusCode::OK);
    let (_, entries) = item_latest_version(&registry.api, &alpha, &id).await;
    let last = entries.last().unwrap();
    assert_eq!(last["action"], "assess");
    assert_eq!(last["snapshot"]["recipient"], "new planner thread");

    registry.advance_tell().await.expect("launch replacement");
    let launched_thread = {
        let fixture = registry.notices.lock().expect("notices");
        assert_eq!(fixture.sends.len(), 0);
        assert_eq!(fixture.launches.len(), 1);
        let prompt = fixture.launches[0]["initialMessage"]["text"]
            .as_str()
            .expect("prompt");
        assert!(prompt.contains("--disposition completed|deprecated"));
        fixture.launches[0]["threadId"]
            .as_str()
            .expect("thread id")
            .to_owned()
    };
    let state = registry.service.state.lock().await;
    let project = &state.settings.projects.as_ref().unwrap().projects[&alpha];
    assert_eq!(
        project.planner_claim.as_ref().map(|c| c.thread.as_str()),
        Some(launched_thread.as_str())
    );
}

#[tokio::test]
async fn item_assess_starts_a_planner_in_the_unbound_t3_project_matching_the_repository() {
    let unbound = UnboundProject::new().await;
    let model = json!({"instanceId": "codex", "model": "gpt-5"});
    let elsewhere = unbound.root.with_file_name("elsewhere");
    // A fork's canonical key names its upstream; its origin carries the match.
    let mut fork = t3_project(
        "gamma-native",
        &unbound.root,
        Some("github.com/upstream/second"),
        &model,
    );
    fork["repositoryIdentity"]["origin"] = json!({"canonicalKey": BETA_KEY});
    unbound.shell(&[
        t3_project("a-other-folder", &elsewhere, Some(BETA_KEY), &model),
        t3_project(
            "b-other-repository",
            &unbound.root,
            Some("github.com/example/third"),
            &model,
        ),
        fork,
    ]);
    unbound.send_to_planner().await;
    unbound.registry.advance_tell().await.expect("launch");
    unbound.assert_launched("gamma-native", &model).await;
    assert_eq!(unbound.progress().await, [("assess".into(), None)]);
}

#[tokio::test]
async fn item_assess_uses_the_settings_planner_model_when_t3_has_no_default() {
    for chosen in [None, Some("medium")] {
        let unbound = UnboundProject::new().await;
        unbound.shell(&[t3_project(
            "gamma-native",
            &unbound.root,
            Some(BETA_KEY),
            &Value::Null,
        )]);
        if let Some(effort) = chosen {
            let current =
                json_body(get_as(&unbound.registry.api, "/v1/settings/dispatch", &BOARD_KEY).await)
                    .await;
            assert_eq!(
                current["value"]["plannerModel"],
                json!({"provider": "claude", "model": "claude-opus-5-5", "effort": "high"})
            );
            let mut value = current["value"].clone();
            value["plannerModel"]["effort"] = json!(effort);
            let saved = planning::put_as(
                &unbound.registry.api,
                "/v1/settings/dispatch",
                &BOARD_KEY,
                &json!({"revision": current["revision"], "value": value}),
            )
            .await;
            assert_eq!(saved.status(), StatusCode::OK);
        }
        unbound.send_to_planner().await;

        // The model list hasn't arrived: the send waits and says so once.
        unbound.registry.advance_tell().await.expect("wait");
        unbound.registry.advance_tell().await.expect("wait again");
        assert!(unbound.queued().await);
        assert_eq!(
            unbound.progress().await[1..],
            [(
                "assess_blocked".into(),
                Some("Can't start a planner: T3's model list hasn't arrived yet".into())
            )]
        );

        unbound.registry.notices.lock().unwrap().server_config = Some(json!({
            "environment": {"orchestrationProtocolVersion": 2},
            "providers": [{
                "instanceId": "claudeAgent", "driver": "claudeAgent", "enabled": true,
                "status": "ready",
                "models": [{"slug": "claude-opus-5-5", "name": "Claude Opus 5.5",
                    "capabilities": {"optionDescriptors": [{
                        "id": "effort", "label": "Reasoning", "type": "select",
                        "options": [{"id": "medium", "label": "Medium"},
                            {"id": "high", "label": "High", "isDefault": true}]
                    }]}}]
            }]
        }));
        let pass = unbound.registry.service.host.pass(&unbound.root);
        nucleus_hosts::TaskHost::profile_catalog(&pass)
            .await
            .expect("model list");
        unbound.registry.advance_tell().await.expect("launch");
        unbound
            .assert_launched(
                "gamma-native",
                &json!({"instanceId": "claudeAgent", "model": "claude-opus-5-5",
                    "options": [{"id": "effort", "value": chosen.unwrap_or("high")}]}),
            )
            .await;
        assert_eq!(
            unbound.progress().await.last().unwrap(),
            &("assess_reached".into(), None)
        );
    }
}

#[tokio::test]
async fn item_assess_without_a_matching_t3_project_stops_until_sent_again() {
    let unbound = UnboundProject::new().await;
    let model = json!({"instanceId": "codex", "model": "gpt-5"});
    let other = t3_project(
        "other-native",
        &unbound.root,
        Some("github.com/example/third"),
        &model,
    );
    unbound.shell(std::slice::from_ref(&other));
    let blocked = (
        "assess_blocked".to_owned(),
        Some("Can't start a planner: no T3 project matches example/second".to_owned()),
    );
    for _ in 0..2 {
        unbound.send_to_planner().await;
        unbound.registry.advance_tell().await.expect("stop");
        assert!(!unbound.queued().await, "the send must not retry");
    }
    assert_eq!(
        unbound.progress().await,
        [
            ("assess".into(), None),
            blocked.clone(),
            ("assess".into(), None),
            blocked,
        ]
    );
    assert!(unbound.registry.notices.lock().unwrap().launches.is_empty());

    unbound.shell(&[
        other,
        t3_project("gamma-native", &unbound.root, Some(BETA_KEY), &model),
    ]);
    unbound.send_to_planner().await;
    unbound.registry.advance_tell().await.expect("launch");
    unbound.assert_launched("gamma-native", &model).await;
}

#[tokio::test]
async fn item_assess_waits_for_t3_to_identify_the_repository() {
    let unbound = UnboundProject::new().await;
    let model = json!({"instanceId": "codex", "model": "gpt-5"});
    unbound.shell(&[t3_project("gamma-native", &unbound.root, None, &model)]);
    unbound.send_to_planner().await;
    unbound.registry.advance_tell().await.expect("wait");
    assert!(unbound.queued().await);
    assert_eq!(
        unbound.progress().await[1..],
        [(
            "assess_blocked".into(),
            Some(
                "Can't start a planner: T3 hasn't identified the repository for example/second yet"
                    .into()
            )
        )]
    );
    unbound.shell(&[t3_project(
        "gamma-native",
        &unbound.root,
        Some(BETA_KEY),
        &model,
    )]);
    unbound.registry.advance_tell().await.expect("launch");
    unbound.assert_launched("gamma-native", &model).await;
}

#[tokio::test]
async fn item_assess_progress_stays_with_its_own_send() {
    let unbound = UnboundProject::new().await;
    let model = json!({"instanceId": "codex", "model": "gpt-5"});
    let unidentified = t3_project("gamma-native", &unbound.root, None, &model);
    unbound.shell(std::slice::from_ref(&unidentified));
    unbound.send_to_planner().await;
    unbound.registry.advance_tell().await.expect("first waits");

    // Send again while the first still waits; the newer send is due first.
    unbound.shell(&[t3_project(
        "other-native",
        &unbound.root,
        Some("github.com/example/third"),
        &model,
    )]);
    unbound.send_to_planner().await;
    unbound.registry.advance_tell().await.expect("second stops");
    unbound.shell(&[t3_project(
        "gamma-native",
        &unbound.root,
        Some(BETA_KEY),
        &model,
    )]);
    unbound
        .registry
        .advance_tell()
        .await
        .expect("first launches");

    unbound.assert_launched("gamma-native", &model).await;
    // Only the launched send is still due, to confirm delivery. The newer one stays stopped.
    let due = unbound
        .registry
        .service
        .state
        .lock()
        .await
        .store
        .next_tell();
    assert!(matches!(
        due.unwrap().unwrap().state,
        nucleus_store::TellState::Accepted(_)
    ));
    assert_eq!(
        unbound.outcomes().await,
        [
            ("assess_blocked".into(), 0),
            ("assess_blocked".into(), 1),
            ("assess_reached".into(), 0),
        ]
    );
}

#[tokio::test]
async fn item_assess_records_causes_for_sends_queued_by_the_earlier_engine() {
    let unbound = UnboundProject::new().await;
    unbound.shell(&[]);
    for _ in 0..2 {
        unbound.send_to_planner().await;
        // The two sends need distinct times, as two clicks have.
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // The earlier engine's history entry held only the item and its recipient.
    let database = unbound
        .registry
        .service
        .storage
        .database()
        .path()
        .join("engine.sqlite");
    let rewritten = rusqlite::Connection::open(database)
        .unwrap()
        .execute(
            "UPDATE planning_history SET snapshot = json_remove(snapshot, '$.tell')
             WHERE action = 'assess'",
            [],
        )
        .unwrap();
    assert_eq!(rewritten, 2);

    for _ in 0..2 {
        unbound.registry.advance_tell().await.expect("stop");
    }
    assert!(!unbound.queued().await);
    assert_eq!(
        unbound.outcomes().await,
        [("assess_blocked".into(), 0), ("assess_blocked".into(), 1)]
    );
    assert_eq!(
        unbound.progress().await.last().unwrap().1.as_deref(),
        Some("Can't start a planner: no T3 project matches example/second")
    );
}

#[tokio::test]
async fn unknown_caller_cannot_watch_or_unwatch_and_makes_no_t3_calls() {
    let registry = registry().await;
    let reads = registry.reads.load(Ordering::Relaxed);
    assert_eq!(
        post_as(
            &registry.api,
            "/v1/tasks/missing/watch",
            &BOARD_KEY,
            &Value::Null
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        get_as(&registry.api, "/v1/tasks/missing/watchers", &BOARD_KEY)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );

    // Both unknown callers and callers absent from the synchronized shell are refused with 0 T3 calls.
    for actor in ["unknown-caller", "uncached-agent"] {
        for verb in ["watch", "unwatch"] {
            assert_eq!(
                watch_via(&registry.api, actor, "missing", verb)
                    .await
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            caller_request(
                &registry.api,
                Method::GET,
                "/v1/tasks/missing/watchers",
                actor,
                Value::Null,
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }

    let alpha_root = registry
        .service
        .host
        .cached_project("alpha-native")
        .unwrap()
        .root;
    registry.service.host.fixture_project_shell(
        &json!({
            "projects": [{"id": "alpha-native", "workspaceRoot": alpha_root}],
            "threads": [{
                "id": "archived-agent",
                "projectId": "external-native",
                "updatedAt": "2026-11-27T12:00:00Z",
                "archivedAt": "2026-11-27T12:01:00Z",
                "deletedAt": null,
            }]
        }),
        "fixture-acp",
    );
    assert_eq!(
        watch_via(&registry.api, "archived-agent", "missing", "watch")
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads);
}

#[tokio::test]
async fn watchers_notify_across_projects_dedupe_origin_and_skip_unwatched() {
    let registry = registry().await;
    for actor in ["alpha-planner", "beta-planner", "next-planner"] {
        registry.enroll(actor).await;
    }
    registry.task("alpha-planner", "alpha-done").await;
    registry.task("alpha-planner", "alpha-cancel").await;
    let done_number = registry
        .service
        .task("alpha-done")
        .await
        .unwrap()
        .number
        .unwrap();
    let done_ref = format!("{ALPHA_REPO}#{done_number}");
    let cancel_ref = format!(
        "{ALPHA_REPO}#{}",
        registry
            .service
            .task("alpha-cancel")
            .await
            .unwrap()
            .number
            .unwrap()
    );

    let w1 = json_body(watch_via(&registry.api, "beta-planner", &done_ref, "watch").await).await;
    assert_eq!(w1["watching"], true);
    assert_eq!(w1["reference"], format!("nucleus-fixture#{done_number}"));
    assert!(w1.get("outcome").is_none());

    for (actor, target, verb) in [
        ("alpha-planner", "alpha-done", "watch"),
        ("beta-planner", "alpha-done", "watch"),
        ("next-planner", "alpha-done", "watch"),
        ("next-planner", "alpha-done", "unwatch"),
        ("beta-planner", &cancel_ref, "watch"),
    ] {
        assert_eq!(
            watch_via(&registry.api, actor, target, verb).await.status(),
            StatusCode::OK
        );
    }

    for (actor, watching) in [("alpha-planner", true), ("next-planner", false)] {
        let next = json_body(
            caller_request(
                &registry.api,
                Method::GET,
                "/v1/tasks/alpha-done/next",
                actor,
                Value::Null,
            )
            .await,
        )
        .await;
        assert_eq!(next["watchers"], json!({"count": 2, "watching": watching}));
    }

    settle_phase(&registry.service, "alpha-done", "done", Some(PR)).await;
    settle_phase(&registry.service, "alpha-cancel", "cancelled", None).await;
    let done_row = registry.service.task("alpha-done").await.unwrap();
    let cancel_row = registry.service.task("alpha-cancel").await.unwrap();
    for row in [&done_row, &cancel_row] {
        registry.service.notify_completion(row).await.unwrap();
    }
    let reads = registry.reads.load(Ordering::Relaxed);
    for row in [&done_row, &cancel_row] {
        registry.service.notify_completion(row).await.unwrap();
    }
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads);

    let sends = &registry.notices.lock().unwrap().sends;
    for needle in [
        format!("#{}", done_row.number.unwrap()),
        "was cancelled".into(),
    ] {
        let recipients: Vec<_> = sends
            .iter()
            .filter(|s| s["text"].as_str().unwrap().contains(&needle))
            .map(|s| s["threadId"].as_str().unwrap())
            .collect();
        assert_eq!(recipients, ["alpha-planner", "beta-planner"]);
    }
}

#[tokio::test]
async fn watching_a_finished_task_returns_its_outcome_and_records_nothing() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("beta-planner").await;
    registry.task("alpha-planner", "alpha-done").await;
    settle_phase(&registry.service, "alpha-done", "done", Some(PR)).await;

    let late =
        json_body(watch_via(&registry.api, "beta-planner", "alpha-done", "watch").await).await;
    assert_eq!(late["watching"], false);
    assert_eq!(late["phase"], "done");
    assert!(late["outcome"].as_str().unwrap().contains(PR));
    assert_eq!(
        registry
            .service
            .state
            .lock()
            .await
            .store
            .watcher_summary("alpha-done", Some("beta-planner"))
            .unwrap(),
        (0, false)
    );
    assert_eq!(
        registry
            .service
            .state
            .lock()
            .await
            .store
            .completion_notices("alpha-done")
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn ticket_caller_watches_across_projects_and_receives_completion_notice() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.task("alpha-planner", "alpha-target").await;
    registry.task("alpha-planner", "alpha-runner").await;

    let mut runner = registry.service.task("alpha-runner").await.unwrap();
    let credential = [11; 32];
    let observation = Observation {
        forge: Observed::Known(Forge::Absent),
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Clean("a".repeat(40).parse().unwrap())),
    };
    let mut runner_task = runner.task.clone();
    let _ = runner_task.reconcile(&observation);
    let bearer = runner_task
        .reserve_grouped_launch(
            &observation,
            LaunchInputs {
                scratch: None,
                thread: "worker-thread".into(),
                started_at: 1,
                input: "fixture-only wire".into(),
            },
            &credential,
            None,
            "fixture-group".into(),
        )
        .unwrap();
    let instance = runner_task.run().unwrap().launch().instance.clone();
    runner = registry
        .service
        .save(&runner, runner_task, &event("reserved"))
        .await
        .unwrap();

    let resp = registry
        .api
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/v1/runs/alpha-runner/{instance}/watch"))
                .header(HOST, LOCAL_HOST)
                .header(
                    AUTHORIZATION,
                    format!("Bearer {}", hex::encode(bearer.as_bytes())),
                )
                .header("content-type", "application/json")
                .body(Body::from(json!({"task": "alpha-target"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let ticket_watchers = json_body(
        registry
            .api
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/v1/runs/alpha-runner/{instance}/watchers"))
                    .header(HOST, LOCAL_HOST)
                    .header(
                        AUTHORIZATION,
                        format!("Bearer {}", hex::encode(bearer.as_bytes())),
                    )
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"task": "alpha-target"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        ticket_watchers["watchers"],
        json!({"count": 1, "watching": true})
    );
    assert!(ticket_watchers.get("commands").is_none());
    let _ = runner;

    settle_phase(&registry.service, "alpha-target", "done", Some(PR)).await;
    let target_row = registry.service.task("alpha-target").await.unwrap();
    registry
        .service
        .notify_completion(&target_row)
        .await
        .unwrap();

    let sends = &registry.notices.lock().unwrap().sends;
    let recipients: Vec<_> = sends
        .iter()
        .map(|s| s["threadId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(recipients, vec!["alpha-planner", "worker-thread"]);
}

#[tokio::test]
async fn non_planner_t3_thread_watches_inspects_status_and_receives_notice() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.task("alpha-planner", "alpha-task").await;
    let number = registry
        .service
        .task("alpha-task")
        .await
        .unwrap()
        .number
        .unwrap();
    let target_ref = format!("{ALPHA_REPO}#{number}");

    let alpha_root = registry
        .service
        .host
        .cached_project("alpha-native")
        .unwrap()
        .root;
    // "standalone-agent" has no planner_route and no run ticket, only a synchronized shell thread.
    registry.service.host.fixture_project_shell(
        &json!({
            "projects": [{"id": "alpha-native", "workspaceRoot": alpha_root}],
            "threads": [{
                "id": "standalone-agent",
                "projectId": "external-native",
                "updatedAt": "2026-11-27T12:00:00Z",
                "archivedAt": null,
                "deletedAt": null,
            }]
        }),
        "fixture-acp",
    );
    let reads = registry.reads.load(Ordering::Relaxed);
    let watched =
        json_body(watch_via(&registry.api, "standalone-agent", &target_ref, "watch").await).await;
    assert_eq!(watched["watching"], true);
    let next = registry
        .inline_command(
            "standalone-agent",
            caller_request(
                &registry.api,
                Method::GET,
                "/v1/tasks/alpha-task/next",
                "standalone-agent",
                Value::Null,
            ),
        )
        .await;
    assert_eq!(next.status(), StatusCode::OK);
    let status = json_body(
        caller_request(
            &registry.api,
            Method::GET,
            "/v1/tasks/alpha-task/watchers",
            "standalone-agent",
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(status["watchers"], json!({"count": 1, "watching": true}));
    assert!(status.get("commands").is_none());
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads);

    settle_phase(&registry.service, "alpha-task", "done", Some(PR)).await;
    let row = registry.service.task("alpha-task").await.unwrap();
    registry.service.notify_completion(&row).await.unwrap();
    {
        let sends = &registry.notices.lock().unwrap().sends;
        let recipients: Vec<_> = sends
            .iter()
            .map(|s| s["threadId"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(recipients, vec!["alpha-planner", "standalone-agent"]);
    }

    let reads = registry.reads.load(Ordering::Relaxed);
    assert_eq!(
        watch_via(&registry.api, "standalone-agent", &target_ref, "unwatch")
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads);
}

#[tokio::test]
async fn cross_project_planner_can_read_next_and_scoped_watcher_status() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("beta-planner").await;
    registry.task("alpha-planner", "alpha-scoped").await;
    let number = registry
        .service
        .task("alpha-scoped")
        .await
        .unwrap()
        .number
        .unwrap();
    let target_ref = format!("{ALPHA_REPO}#{number}");
    let encoded = target_ref.replace('/', "%2F").replace('#', "%23");

    assert_eq!(
        watch_via(&registry.api, "beta-planner", &target_ref, "watch")
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        caller_request(
            &registry.api,
            Method::GET,
            "/v1/tasks/alpha-scoped/next",
            "beta-planner",
            Value::Null,
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        caller_request(
            &registry.api,
            Method::GET,
            &format!("/v1/tasks/{encoded}/next"),
            "beta-planner",
            Value::Null,
        )
        .await
        .status(),
        StatusCode::OK
    );
    let scoped = json_body(
        caller_request(
            &registry.api,
            Method::GET,
            &format!("/v1/tasks/{encoded}/watchers"),
            "beta-planner",
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(scoped["watchers"], json!({"count": 1, "watching": true}));
    assert!(scoped.get("commands").is_none());
    assert!(scoped.get("hold").is_none());
    assert!(scoped.get("allowance").is_none());
}

#[tokio::test]
async fn gone_watcher_is_dropped_and_recorded_while_origin_falls_back() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("next-planner").await;
    claim(&registry, "next-planner").await;
    registry.enroll("beta-planner").await;

    let task = registry.task("alpha-planner", "alpha-gone").await;
    assert_eq!(
        caller_request(
            &registry.api,
            Method::POST,
            "/v1/tasks/alpha-gone/watch",
            "beta-planner",
            Value::Null
        )
        .await
        .status(),
        StatusCode::OK
    );

    // Archive both alpha-planner (origin) and beta-planner (watcher) before closeout.
    registry.archived.store(true, Ordering::Relaxed);
    registry
        .notices
        .lock()
        .unwrap()
        .archived_threads
        .insert("beta-planner".into());

    let row = registry.service.task("alpha-gone").await.unwrap();
    let mut cancelled = serde_json::to_value(&task).unwrap();
    cancelled["phase"] = json!("cancelled");
    registry
        .service
        .save(
            &row,
            serde_json::from_value(cancelled).unwrap(),
            &event("cancelled"),
        )
        .await
        .unwrap();

    let row = registry.service.task("alpha-gone").await.unwrap();
    registry.service.notify_completion(&row).await.unwrap();

    {
        let sends = &registry.notices.lock().unwrap().sends;
        assert_eq!(sends.len(), 1);
        assert_eq!(sends[0]["threadId"], "next-planner");
    }

    let history = registry
        .service
        .history("alpha-gone", None, 20)
        .await
        .unwrap();
    let dropped = history
        .iter()
        .find(|entry| entry.content.kind == "completion_notice_watcher_dropped")
        .expect("dropped watcher recorded in task history");
    let detail: Value = serde_json::from_str(&dropped.content.detail).unwrap();
    assert_eq!(detail["recipient"], "beta-planner");
    assert!(
        registry
            .service
            .state
            .lock()
            .await
            .store
            .completion_notices("alpha-gone")
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn planner_paired_board_and_acp_sessions_reauthorize_after_stream_drop_and_restart() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    let task_id = "reauth-task";
    let admitted = submit(&registry.api, "alpha-planner", task_id, None).await;
    assert_eq!(admitted.status(), StatusCode::CREATED);
    let (read_key, write_key) = acp_keys(
        &registry.api,
        &format!("/v1/tasks/{task_id}/acp"),
        "alpha-planner",
    )
    .await;
    let board = registry_board_api(&registry);
    let cookie = pair_planner_board(&board, "alpha-planner").await;

    // Stream drop: ACP read, ACP write and board sessions each reauthorize the calling thread.
    let worker = spawn_enrollments(&registry.service);
    assert_acp_reauthorized(
        &registry.service,
        &registry.api,
        task_id,
        &read_key,
        &write_key,
        json!({"hold": "reauth check"}),
    )
    .await;
    registry
        .service
        .state
        .lock()
        .await
        .enrolled_planners
        .clear();
    assert_board_reauthorized(&board, &cookie, task_id).await;

    // Restart: persisted board cookie and ACP read/write sessions reauthorize the calling thread.
    worker.abort();
    let _ = worker.await;
    drop(board);
    let restarted = registry.reopen();
    let worker = spawn_enrollments(&restarted.service);
    let restarted_board = registry_board_api(&restarted);
    assert_board_reauthorized(&restarted_board, &cookie, task_id).await;
    assert_acp_reauthorized(
        &restarted.service,
        &restarted.api,
        task_id,
        &read_key,
        &write_key,
        json!("release"),
    )
    .await;
    worker.abort();
}

#[tokio::test]
async fn scratch_acp_session_reauthorizes_after_proof_loss_and_restart() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll(SCRATCH_AGENT).await;
    // The session issuer differs from the task's origin.
    let id = "scratch-acp";
    registry.task("alpha-planner", id).await;
    let (read_key, write_key) =
        acp_keys(&registry.api, &format!("/v1/tasks/{id}/acp"), SCRATCH_AGENT).await;

    let worker = spawn_enrollments(&registry.service);
    assert_acp_reauthorized(
        &registry.service,
        &registry.api,
        id,
        &read_key,
        &write_key,
        json!({"hold": "Reauthorized scratch controller"}),
    )
    .await;
    worker.abort();
    let _ = worker.await;
    assert!(
        registry
            .service
            .task(id)
            .await
            .unwrap()
            .task
            .hold()
            .is_some()
    );

    let registry = registry.reopen();
    let worker = spawn_enrollments(&registry.service);
    assert_acp_reauthorized(
        &registry.service,
        &registry.api,
        id,
        &read_key,
        &write_key,
        json!("release"),
    )
    .await;
    worker.abort();
    let _ = worker.await;
    assert!(
        registry
            .service
            .task(id)
            .await
            .unwrap()
            .task
            .hold()
            .is_none()
    );

    {
        let mut state = registry.service.state.lock().await;
        assert!(state.settings.planner_route(SCRATCH_AGENT).is_none());
        state.enrolled_planners.clear();
    }
    registry
        .notices
        .lock()
        .unwrap()
        .missing_threads
        .insert(SCRATCH_AGENT.into());
    let denied = registry
        .inline_command(
            SCRATCH_AGENT,
            acp_call(
                &registry.api,
                Method::POST,
                "/v1/tasks/scratch-acp/commands",
                &write_key,
                Some(json!("cancel")),
            ),
        )
        .await;
    assert_eq!(denied, StatusCode::FORBIDDEN);
    assert_eq!(
        registry.service.task(id).await.unwrap().task.phase(),
        Phase::Queued
    );
}

#[tokio::test]
async fn tell_pre_send_unavailable_returns_stored_row_to_pending() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    let alpha = registry
        .service
        .state
        .lock()
        .await
        .live_planner_project("alpha-planner")
        .expect("alpha")
        .to_owned();
    let repo_root = registry
        .service
        .state
        .lock()
        .await
        .settings
        .projects
        .as_ref()
        .unwrap()
        .projects[&alpha]
        .repositories[0]
        .path
        .clone();

    let items = format!("/v1/planning/{alpha}/items");
    let created = json_body(
        post_as(
            &registry.api,
            &items,
            &BOARD_KEY,
            &json!({"kind": "lead", "title": "Pre-send 503", "body": "Launch hits 503."}),
        )
        .await,
    )
    .await;
    let id = created["id"].as_str().unwrap().to_owned();
    let (v1, _) = item_latest_version(&registry.api, &alpha, &id).await;
    registry.archived.store(true, Ordering::Relaxed);
    assert_eq!(
        post_as(
            &registry.api,
            &format!("{items}/{id}/assess"),
            &BOARD_KEY,
            &json!({"version": v1}),
        )
        .await
        .status(),
        StatusCode::OK
    );

    let (host, reject_server) = reject_ticket_503_host(&repo_root).await;
    let Registry {
        home: _home,
        service,
        api,
        ..
    } = registry;
    drop(api);
    let settings = service.settings.clone();
    drop(service);
    let revision = settings.read::<nucleus_store::Projects>().unwrap().revision;
    settings
        .edit(&revision, |projects: &mut nucleus_store::Projects| {
            projects.projects.get_mut(&alpha).unwrap().repositories[0]
                .planner_threads
                .clear();
            Ok(())
        })
        .unwrap();
    let service = registry_service(&settings, host);
    let row = service
        .state
        .lock()
        .await
        .store
        .next_tell()
        .unwrap()
        .expect("queued assess tell");
    service.advance_tell(&row).await.unwrap();
    let after = service
        .state
        .lock()
        .await
        .store
        .next_tell()
        .unwrap()
        .expect("tell returned to pending");
    assert!(matches!(after.state, nucleus_store::TellState::Pending));
    reject_server.await.unwrap();
}
