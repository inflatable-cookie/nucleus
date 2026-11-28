use super::*;

#[tokio::test]
async fn project_removal_rechecks_positive_activity_for_a_finished_task() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    let task = registry.task("alpha-planner", "terminal-removal").await;
    let id = removal_settings(&registry)
        .value
        .projects
        .into_keys()
        .next()
        .unwrap();
    let removal = format!("{PROJECTS}/{id}/removal");
    let head = "a".repeat(40).parse::<Head>().unwrap();
    finish_removal_task(&registry, &task.identity().id, Some(&head)).await;
    let preview = json_body(get_as(&registry.api, &removal, &BOARD_KEY).await).await;
    assert_eq!(
        preview["tasks"],
        json!([]),
        "a leftover reservation is not activity"
    );
    let confirmation = json!({"digest":preview["digest"], "reason":"Retired fixture"});

    terminal_removal_worker(&registry, &task, true);
    let active = json_body(get_as(&registry.api, &removal, &BOARD_KEY).await).await;
    assert_eq!(active["tasks"][0]["taskId"], task.identity().id);
    let refused = post_as(&registry.api, &removal, &BOARD_KEY, &confirmation).await;
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    assert!(
        json_body(refused).await["error"]
            .as_str()
            .unwrap()
            .contains("open tasks")
    );

    terminal_removal_worker(&registry, &task, false);
    let removed = post_as(&registry.api, &removal, &BOARD_KEY, &confirmation).await;
    assert_eq!(removed.status(), StatusCode::OK);
}

#[tokio::test]
async fn project_removal_recreates_the_same_project_after_pending_cleanup() {
    assert_removal_restoration(None).await;
}

#[tokio::test]
async fn project_removal_restores_an_origin_under_a_different_project() {
    assert_removal_restoration(Some("restored-project")).await;
}

#[tokio::test]
async fn projects_view_keeps_removal_receipts_private() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    let before = removal_settings(&registry);
    registry
        .service
        .settings
        .edit::<nucleus_store::Projects>(&before.revision, |settings| {
            settings.removed.insert(
                "p-orbit-main".into(),
                serde_json::from_value(json!({
                    "repositories":[{"origin":"example/retired","path":"/fixture/retired"}],
                    "blockedOrigins":["example/retired"],"cleanupPending":false,
                    "digest":"retired","reason":"Retired","removedAtMs":42
                }))
                .unwrap(),
            );
            Ok(())
        })
        .unwrap();
    let view = json_body(get_as(&registry.api, PROJECTS, &BOARD_KEY).await).await;
    assert!(view["settings"]["value"].get("removed").is_none());
    assert!(!view.to_string().contains("example/retired"));
}

#[tokio::test]
async fn scratch_thread_broadcasts_and_receives_exact_replies_after_restart() {
    let registry = registry().await;
    for planner in ["alpha-planner", "beta-planner"] {
        registry.enroll(planner).await;
        claim(&registry, planner).await;
    }
    let sent = registry
        .inline_command(
            SCRATCH_AGENT,
            registry.tell(SCRATCH_AGENT, json!("all"), "Sweep complete"),
        )
        .await;
    assert_eq!(sent.status(), StatusCode::OK);
    let deliveries = json_body(sent).await["deliveries"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(deliveries.len(), 2);
    assert!(
        deliveries
            .iter()
            .all(|delivery| delivery["fromProject"] == "no project")
    );
    registry.notices.lock().unwrap().started = true;
    let mut routes = Vec::new();
    for _ in 0..2 {
        registry.advance_tell().await.unwrap();
        let (thread, text, handle) = received_notice(&registry);
        assert!(
            text.starts_with("From no project (scratch-agent)\n\n"),
            "{text}"
        );
        assert!(text.contains("Sweep complete"));
        routes.push((thread, handle));
    }
    for _ in 0..2 {
        registry.advance_tell().await.unwrap();
    }
    assert_eq!(
        routes
            .iter()
            .map(|(thread, _)| thread.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["alpha-planner", "beta-planner"])
    );

    let registry = registry.reopen();
    for (planner, handle) in routes {
        let response = registry
            .inline_command(
                &planner,
                registry.tell(
                    &planner,
                    json!({"reply": handle}),
                    &format!("Reply from {planner}"),
                ),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        registry.advance_tell().await.unwrap();
        let (thread, text, _) = received_notice(&registry);
        assert_eq!(thread, SCRATCH_AGENT);
        assert!(text.contains(&format!("({planner})")));
        registry.advance_tell().await.unwrap();
    }
    assert!(
        registry
            .service
            .state
            .lock()
            .await
            .settings
            .planner_route(SCRATCH_AGENT)
            .is_none()
    );
}

#[tokio::test]
async fn project_tell_claim_and_reply_keep_distinct_addresses_across_restart() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    claim(&registry, "alpha-planner").await;
    registry.enroll("next-planner").await;
    registry.enroll("beta-planner").await;
    let message = registry
        .tell("beta-planner", json!("Exact T3 Alpha"), "A question")
        .await;
    assert_eq!(message.status(), StatusCode::OK);
    registry.advance_tell().await.unwrap();
    let (thread, text, handle) = received_notice(&registry);
    assert_eq!(thread, "alpha-planner");
    assert!(!text.contains("Fallback"));
    let sender_project = {
        let state = registry.service.state.lock().await;
        let project = state.live_planner_project("beta-planner").unwrap();
        state.settings.projects.as_ref().unwrap().projects[project]
            .name
            .clone()
    };
    assert!(text.starts_with(&format!("From {sender_project} (beta-planner)\n\n")));
    registry.notices.lock().unwrap().started = true;
    registry.advance_tell().await.unwrap();

    let registry = registry.reopen();
    registry.enroll("alpha-planner").await;
    registry.enroll("next-planner").await;
    let reply = json!({"reply": handle});
    let reads = registry.reads.load(Ordering::Relaxed);
    let foreign = registry.tell("next-planner", reply.clone(), "answer").await;
    let unknown = registry
        .tell("alpha-planner", json!({"reply":"nreply_unknown"}), "answer")
        .await;
    assert_eq!(foreign.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(foreign).await, json_body(unknown).await);
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads);

    let sent = registry
        .tell("alpha-planner", reply.clone(), "answer")
        .await;
    assert_eq!(sent.status(), StatusCode::OK);
    registry.advance_tell().await.unwrap();
    let (thread, _, next_handle) = received_notice(&registry);
    assert_eq!(thread, "beta-planner");
    assert_ne!(handle, next_handle);
    registry.advance_tell().await.unwrap();
    let state = registry.service.state.lock().await;
    assert!(
        state
            .store
            .tell_reply_route(&handle, "alpha-planner", i64::MAX)
            .unwrap()
            .is_none()
    );
    drop(state);

    claim(&registry, "next-planner").await;
    claim(&registry, "next-planner").await;
    registry.advance_tell().await.unwrap();
    let (thread, notice, _) = received_notice(&registry);
    assert_eq!(thread, "alpha-planner");
    assert!(notice.contains("Another thread claimed this project"));
    registry.advance_tell().await.unwrap();
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
    let follow = registry
        .inline_command(
            "beta-planner",
            registry.tell("beta-planner", json!({"reply": next_handle}), "Follow-up"),
        )
        .await;
    assert_eq!(follow.status(), StatusCode::OK);
    registry.advance_tell().await.unwrap();
    assert_eq!(received_notice(&registry).0, "alpha-planner");
}

#[tokio::test]
async fn project_tell_reply_to_gone_sender_falls_back_after_restart() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    claim(&registry, "alpha-planner").await;
    registry.enroll("next-planner").await;
    registry.enroll("beta-planner").await;
    assert_eq!(
        registry
            .tell("alpha-planner", json!("second"), "Before closure")
            .await
            .status(),
        StatusCode::OK
    );
    registry.advance_tell().await.unwrap();
    let (_, _, handle) = received_notice(&registry);
    registry.notices.lock().unwrap().started = true;
    registry.advance_tell().await.unwrap();
    let registry = registry.reopen();
    registry.enroll("beta-planner").await;
    let route = json!({"reply":handle});
    assert_eq!(
        registry
            .tell("beta-planner", route.clone(), "After closure")
            .await
            .status(),
        StatusCode::OK
    );
    // An uncertain exact read keeps the reply addressed to the original thread.
    registry.notices.lock().unwrap().uncertain_planner = true;
    assert!(registry.advance_tell().await.is_err());
    registry.notices.lock().unwrap().uncertain_planner = false;
    registry.archived.store(true, Ordering::Relaxed);
    let pending = registry
        .service
        .state
        .lock()
        .await
        .store
        .next_tell()
        .unwrap()
        .unwrap();
    assert_eq!(pending.direct.as_deref(), Some("alpha-planner"));
    registry.advance_tell().await.unwrap();
    assert_eq!(registry.notices.lock().unwrap().sends.len(), 1);
    let registry = registry.reopen();
    registry.advance_tell().await.unwrap();
    let (thread, text, new_handle) = received_notice(&registry);
    assert_eq!(thread, "next-planner");
    assert!(text.contains("Fallback: the sender from Exact T3 Alpha is gone."));
    assert!(!text.contains("alpha-planner"));
    assert!(text.contains("After closure"));
    assert_ne!(handle, new_handle);
    registry.advance_tell().await.unwrap();
    assert_eq!(registry.notices.lock().unwrap().sends.len(), 2);
    assert!(registry.notices.lock().unwrap().controls.is_empty());
    registry.enroll("beta-planner").await;
    let replay = registry.tell("beta-planner", route, "After closure").await;
    assert_eq!(
        json_body(replay).await["deliveries"][0]["status"],
        "delivered"
    );
    assert_eq!(
        registry
            .tell("beta-planner", json!("Exact T3 Alpha"), "Project message")
            .await
            .status(),
        StatusCode::OK
    );
    registry.advance_tell().await.unwrap();
    let (thread, text, _) = received_notice(&registry);
    assert_eq!(thread, "next-planner");
    assert!(text.contains("Fallback: Exact T3 Alpha has no claimed planner;"));
}

#[tokio::test]
async fn opted_in_completion_survives_restart_and_retries_once_to_the_claimed_planner() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("next-planner").await;
    claim(&registry, "next-planner").await;
    registry.enroll("recent-planner").await;
    let brief =
        "---\nqueue:\n  complexity: low\n  notifyOriginOnCloseout: true\n---\n# Fix rounding";
    assert_eq!(
        submit(&registry.api, "alpha-planner", "notice", None)
            .await
            .status(),
        StatusCode::CREATED
    );
    let commands = "/v1/tasks/notice/commands";
    for command in [json!({"amend": brief}), json!("cancel")] {
        assert_eq!(
            caller_request(
                &registry.api,
                Method::POST,
                commands,
                "alpha-planner",
                command
            )
            .await
            .status(),
            StatusCode::OK
        );
    }

    let registry = registry.reopen();
    registry.notices.lock().unwrap().next_reply = NoticeReply::Rejected;
    advance_task_notice(&registry).await.unwrap();
    assert_eq!(
        registry
            .service
            .state
            .lock()
            .await
            .store
            .completion_notice("notice")
            .unwrap(),
        Some(true)
    );
    registry.archived.store(true, Ordering::Relaxed);
    let registry = registry.reopen();
    registry.notices.lock().unwrap().next_reply = NoticeReply::Lost;
    advance_task_notice(&registry).await.unwrap();
    let row = registry.service.task("notice").await.unwrap();
    let text = format!("#{} Fix rounding was cancelled", row.number.unwrap());
    {
        let fixture = registry.notices.lock().unwrap();
        let [first, retry] = fixture.sends.as_slice() else {
            panic!("expected exactly two attempts")
        };
        assert_eq!(first["threadId"], "alpha-planner");
        assert_eq!(retry["threadId"], "next-planner");
        assert_ne!(first["commandId"], retry["commandId"]);
        assert_eq!(first["text"], text);
        assert_eq!(retry["text"], text);
    }
    let registry = registry.reopen();
    let reads = registry.reads.load(Ordering::Relaxed);
    registry.service.notify_completion(&row).await.unwrap();
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads);
    assert_eq!(registry.notices.lock().unwrap().sends.len(), 2);
    assert!(
        registry
            .service
            .state
            .lock()
            .await
            .store
            .archive_due_ids(None, 32, false)
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn done_completion_names_the_pull_and_an_opt_out_stays_silent() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    for (id, opt) in [("quiet", "  notifyOriginOnCloseout: false\n"), ("done", "")] {
        let brief = format!("---\nqueue:\n  complexity: low\n{opt}---\n# Ship correction");
        assert_eq!(
            caller_request(
                &registry.api,
                Method::POST,
                "/v1/planning/tasks",
                "alpha-planner",
                json!({"id":id,"reference":id,"brief":brief})
            )
            .await
            .status(),
            StatusCode::CREATED
        );
        let row = registry.service.task(id).await.unwrap();
        let mut settled = serde_json::to_value(&row.task).unwrap();
        settled["phase"] = json!("done");
        settled["pr"] = json!({"url":PR,"head":"a".repeat(40)});
        registry
            .service
            .save(
                &row,
                serde_json::from_value(settled).unwrap(),
                &event("closed_checkout_removed"),
            )
            .await
            .unwrap();
        let row = registry.service.task(id).await.unwrap();
        let reads = registry.reads.load(Ordering::Relaxed);
        registry.service.notify_completion(&row).await.unwrap();
        let notices = registry.notices.lock().unwrap();
        if id == "quiet" {
            assert!(notices.sends.is_empty());
            assert_eq!(registry.reads.load(Ordering::Relaxed), reads);
        } else {
            assert_eq!(notices.sends.len(), 1);
            assert_eq!(
                notices.sends[0]["dispatchMode"]["type"],
                "queue_after_active"
            );
            assert_eq!(
                notices.sends[0]["text"],
                format!("#{} Ship correction is done · {PR}", row.number.unwrap())
            );
        }
    }
}

#[tokio::test]
async fn promoted_capacity_waiters_serve_oldest_promoted_with_room_and_keep_order_across_holds_and_parks()
 {
    let head: Head = "a".repeat(40).parse().unwrap();
    let registry = setup_promoted_queue_fixture(&head).await;
    verify_promote_command_and_holds(&registry).await;
    verify_promoted_wakeup_skips_full_project(&registry, &head).await;
    verify_released_and_unparked_keep_original_order(&registry).await;
}

#[tokio::test]
async fn nucleus_reply_with_a_short_handle_reaches_the_original_sender() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    claim(&registry, "alpha-planner").await;
    registry.enroll("beta-planner").await;
    assert_eq!(
        registry
            .tell("beta-planner", json!("Exact T3 Alpha"), "A question")
            .await
            .status(),
        StatusCode::OK
    );
    registry.advance_tell().await.unwrap();
    let (thread, text, handle) = received_notice(&registry);
    assert_eq!(thread, "alpha-planner");
    assert!(handle.starts_with('r') && handle.len() == 9, "{handle}");
    assert!(text.starts_with("From "), "{text}");
    assert!(text.ends_with(&format!("Reply: nucleus reply {handle} 'your message'")));
    assert!(!text.contains("Information only"));
    registry.notices.lock().unwrap().started = true;
    registry.advance_tell().await.unwrap();

    // `nucleus reply <handle> "Answer"` posts this exact body.
    let reply = registry
        .tell("alpha-planner", json!({"reply": handle}), "Answer")
        .await;
    assert_eq!(reply.status(), StatusCode::OK);
    registry.advance_tell().await.unwrap();
    let (thread, text, _) = received_notice(&registry);
    assert_eq!(thread, "beta-planner");
    assert!(text.contains("\n\nAnswer\n\n"), "{text}");

    // Another thread holding the same handle is refused plainly.
    let foreign = registry
        .tell("beta-planner", json!({"reply": handle}), "Intruder")
        .await;
    assert_eq!(foreign.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(foreign).await["error"],
        "This reply route is unavailable. Nothing was sent."
    );
}

#[tokio::test]
async fn shared_reply_fixtures_reach_the_sender_and_refuse_foreign_and_expired_handles() {
    const REFUSAL: &str = "This reply route is unavailable. Nothing was sent.";
    let fixtures = shared_reply_fixtures();
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("beta-planner").await;
    let now = i64::try_from(crate::now_ms()).unwrap();
    // Alpha received three messages earlier; each carried the fixture's handle.
    for (name, issued_at) in [
        ("shortReply", now),
        ("legacyReply", now),
        ("expiredReply", now - 8 * REPLY_DAY_MS),
    ] {
        let handle = fixture_handle(&fixture_body(&fixtures, name));
        record_delivered_reply_route(&registry, &handle, issued_at).await;
    }

    for name in ["shortReply", "legacyReply", "legacyJsonTell", "stdinReply"] {
        let body = fixture_body(&fixtures, name);
        let sent = post_tell(&registry, "alpha-planner", body.clone()).await;
        assert_eq!(sent.status(), StatusCode::OK, "{name}");
        registry.advance_tell().await.unwrap();
        let (thread, text, _) = received_notice(&registry);
        assert_eq!(thread, "beta-planner", "{name}");
        let expected = body["text"].as_str().expect("fixture text");
        assert!(
            text.contains(&format!("\n\n{expected}\n\n")),
            "{name}: {text}"
        );
        // Settle the delivered notice before the next one is scheduled.
        registry.notices.lock().unwrap().started = true;
        registry.advance_tell().await.unwrap();
    }

    // Beta sent the original message, so it cannot answer with alpha's handle.
    let foreign = post_tell(
        &registry,
        "beta-planner",
        fixture_body(&fixtures, "shortReply"),
    )
    .await;
    assert_eq!(foreign.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(foreign).await["error"], REFUSAL);

    // An expired handle is refused plainly and sends nothing.
    let sends = registry.notices.lock().unwrap().sends.len();
    let stale = post_tell(
        &registry,
        "alpha-planner",
        fixture_body(&fixtures, "expiredReply"),
    )
    .await;
    assert_eq!(stale.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(stale).await["error"], REFUSAL);
    assert_eq!(registry.notices.lock().unwrap().sends.len(), sends);
}

#[tokio::test]
async fn item_assess_routes_to_claimed_planner_and_fallback_thread() {
    let registry = registry().await;
    let fallback_thread = "01adc496-18f0-4b9e-a22c-d1acb7facdab";
    registry.enroll("alpha-planner").await;
    registry.enroll(fallback_thread).await;
    let alpha = registry
        .service
        .state
        .lock()
        .await
        .live_planner_project("alpha-planner")
        .expect("alpha")
        .to_owned();
    let claimed = caller_request(
        &registry.api,
        Method::POST,
        "/v1/planning/claim",
        "alpha-planner",
        json!({}),
    )
    .await;
    assert_eq!(claimed.status(), StatusCode::OK);

    let items = format!("/v1/planning/{alpha}/items");
    let created = json_body(
        post_as(
            &registry.api,
            &items,
            &BOARD_KEY,
            &json!({"kind": "papercut", "title": "Stale button", "body": "The old Promote button should go."}),
        )
        .await,
    )
    .await;
    let id = created["id"].as_str().expect("item id").to_owned();
    let (v1, _) = item_latest_version(&registry.api, &alpha, &id).await;

    let response = post_as(
        &registry.api,
        &format!("{items}/{id}/assess"),
        &BOARD_KEY,
        &json!({"version": v1}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved = json_body(response).await;
    assert_eq!(saved["authorLabel"], "Operator");
    let v2 = saved["version"].as_i64().unwrap();
    let (_, entries) = item_latest_version(&registry.api, &alpha, &id).await;
    let last = entries.last().unwrap();
    assert_eq!(last["action"], "assess");
    assert_eq!(last["actor"], "fixture-operator");
    assert_eq!(last["snapshot"]["recipient"], "alpha-planner");
    let project_name = registry
        .service
        .settings
        .read::<nucleus_store::Projects>()
        .unwrap()
        .value
        .projects[&alpha]
        .name
        .clone();
    assert_eq!(last["actorLabel"], "Operator");
    assert_eq!(last["recipientLabel"], format!("{project_name} planner"));

    registry.advance_tell().await.expect("deliver to claimed");
    {
        let fixture = registry.notices.lock().expect("notices");
        assert_eq!(fixture.sends.len(), 1);
        let msg = &fixture.sends[0];
        assert_eq!(msg["threadId"], "alpha-planner");
        assert_eq!(msg["dispatchMode"]["type"], "queue_after_active");
        let text = msg["text"].as_str().expect("message text");
        for expected in [
            "Papercut",
            id.as_str(),
            "Stale button",
            "The old Promote button should go.",
            "nucleus item.drop",
            "nucleus item.edit",
            "nucleus item.promote",
        ] {
            assert!(text.contains(expected), "missing {expected} in {text}");
        }
        assert!(!text.contains("Reply:"));
    }
    registry.notices.lock().expect("notices").started = true;
    registry.advance_tell().await.expect("mark delivered");

    // An archived claim sends again to the registered fallback planner thread.
    archive_and_assess_again(&registry, &items, &alpha, &id, v2, fallback_thread).await;
}

#[tokio::test]
async fn replacing_a_planner_keeps_both_threads_in_the_project_ledger() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("next-planner").await;
    let alpha = registry
        .service
        .state
        .lock()
        .await
        .live_planner_project("alpha-planner")
        .expect("alpha")
        .to_owned();

    for actor in ["alpha-planner", "next-planner"] {
        let response = caller_request(
            &registry.api,
            Method::POST,
            "/v1/planning/claim",
            actor,
            json!({}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "claim by {actor}");
    }

    let project = registry
        .service
        .settings
        .read::<nucleus_store::Projects>()
        .unwrap()
        .value
        .projects
        .remove(&alpha)
        .expect("project");
    assert_eq!(
        project.planner_claim.as_ref().unwrap().thread,
        "next-planner"
    );
    assert_eq!(
        project.planner_claim.as_ref().unwrap().replaced.as_deref(),
        Some("alpha-planner")
    );
    assert!(
        project
            .claimed_planner_threads
            .contains(&"alpha-planner".to_owned())
    );
    assert!(
        project
            .claimed_planner_threads
            .contains(&"next-planner".to_owned())
    );
}

#[tokio::test]
async fn clearing_a_planner_keeps_current_replaced_and_older_threads() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("next-planner").await;
    let alpha = registry
        .service
        .state
        .lock()
        .await
        .live_planner_project("alpha-planner")
        .expect("alpha")
        .to_owned();
    let file = registry.service.settings.clone();
    let id = alpha.clone();
    let saved = file
        .edit(
            &file.read::<nucleus_store::Projects>().unwrap().revision,
            |projects: &mut nucleus_store::Projects| {
                projects
                    .projects
                    .get_mut(&id)
                    .unwrap()
                    .claimed_planner_threads
                    .push("older-planner".into());
                Ok(())
            },
        )
        .unwrap();
    registry.service.state.lock().await.settings.projects = Some(saved.0.value);

    for actor in ["alpha-planner", "next-planner"] {
        let response = caller_request(
            &registry.api,
            Method::POST,
            "/v1/planning/claim",
            actor,
            json!({}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "claim by {actor}");
    }

    let before = registry
        .service
        .settings
        .read::<nucleus_store::Projects>()
        .unwrap();
    let response = post_as(
        &registry.api,
        &format!("/v1/settings/projects/{alpha}/clear-planner"),
        &BOARD_KEY,
        &json!({"revision": before.revision}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let project = registry
        .service
        .settings
        .read::<nucleus_store::Projects>()
        .unwrap()
        .value
        .projects
        .remove(&alpha)
        .expect("project");
    assert!(project.planner_claim.is_none());
    for thread in ["older-planner", "alpha-planner", "next-planner"] {
        assert!(
            project
                .claimed_planner_threads
                .iter()
                .any(|known| known == thread),
            "missing {thread}"
        );
    }
}

#[tokio::test]
async fn project_edits_preserve_but_cannot_change_claimed_planner_threads() {
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
            json!({})
        )
        .await
        .status(),
        StatusCode::OK
    );

    let before = registry
        .service
        .settings
        .read::<nucleus_store::Projects>()
        .unwrap();
    let mut omitted_history = before.value.clone();
    omitted_history
        .projects
        .get_mut(&alpha)
        .unwrap()
        .claimed_planner_threads
        .clear();
    assert_eq!(
        planning::put_as(
            &registry.api,
            PROJECTS,
            &BOARD_KEY,
            &json!({"revision":before.revision,"value":omitted_history})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let after = registry
        .service
        .settings
        .read::<nucleus_store::Projects>()
        .unwrap();
    assert!(
        after.value.projects[&alpha]
            .claimed_planner_threads
            .iter()
            .any(|thread| thread == "alpha-planner")
    );

    let mut forged = after.value.clone();
    forged
        .projects
        .get_mut(&alpha)
        .unwrap()
        .claimed_planner_threads = vec!["forged-thread".into()];
    assert_eq!(
        planning::put_as(
            &registry.api,
            PROJECTS,
            &BOARD_KEY,
            &json!({"revision":after.revision,"value":forged})
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let persisted = registry
        .service
        .settings
        .read::<nucleus_store::Projects>()
        .unwrap();
    assert_eq!(
        persisted.value.projects[&alpha].claimed_planner_threads,
        after.value.projects[&alpha].claimed_planner_threads
    );
}
