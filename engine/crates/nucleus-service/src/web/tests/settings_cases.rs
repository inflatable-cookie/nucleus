use super::*;

#[tokio::test]
async fn settings_save_is_local_validated_and_wakes_capacity() {
    let (_home, service, _planner_host) =
        enrolled_fixture(GitHub::new("fixture").expect("client")).await;
    let service = Arc::new(service);
    let api = settings_api(&service);
    let now = tokio::time::Instant::now();
    {
        let mut state = service.state.lock().await;
        state.capacity_waiters.insert((
            std::cmp::Reverse(false),
            nucleus_core::QueuePriority::Normal,
            1,
            "awaiting-slot".into(),
        ));
        state.set_wait("awaiting-slot", Some(nucleus_core::WaitReason::Capacity));
        state.schedule.wake(
            "awaiting-slot",
            now + std::time::Duration::from_mins(1),
            crate::schedule::Priority::Refresh,
        );
    }
    let path = "/v1/settings/dispatch";
    let original = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    for (key, slots) in [("heavySlots", 5), ("totalSlots", 32)] {
        assert_eq!(original["value"][key], slots);
    }
    assert_eq!(original["value"]["projectDefaultSlots"], 5);
    let mut update = json!({"revision": original["revision"], "value": original["value"]});
    update["value"]["totalSlots"] = json!(0);
    assert_eq!(
        put_settings(&api, path, &BOARD_KEY, &update).await.status(),
        StatusCode::BAD_REQUEST
    );
    update["value"]["totalSlots"] = json!(3);
    assert_eq!(
        put_settings(&api, path, &BOARD_KEY, &update).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        json_body(get_as(&api, path, &BOARD_KEY).await).await,
        original
    );
    update["value"]["heavySlots"] = json!(3);
    assert_eq!(
        put_settings(&api, path, &PLANNER_KEY, &update)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );

    let saved = json_body(put_settings(&api, path, &BOARD_KEY, &update).await).await;
    assert_eq!(saved["value"]["heavySlots"], 3);
    assert_ne!(saved["revision"], original["revision"]);
    assert_eq!(
        put_settings(&api, path, &BOARD_KEY, &update).await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(json_body(get_as(&api, path, &BOARD_KEY).await).await, saved);
    let state = service.state.lock().await;
    assert_eq!(
        state
            .settings
            .dispatch
            .as_ref()
            .expect("published dispatch")
            .total_slots,
        3
    );
    assert!(
        state.schedule.due("awaiting-slot").expect("capacity wake") <= tokio::time::Instant::now()
    );
}

#[tokio::test]
async fn operators_can_pause_a_known_subscription_until_its_reset() {
    let (_home, service, _planner_host) =
        enrolled_fixture(GitHub::new("fixture").expect("client")).await;
    let service = Arc::new(service);
    let api = settings_api(&service);
    let profiles = "/v1/settings/profiles";
    let initial = json_body(get_as(&api, profiles, &BOARD_KEY).await).await;
    let input = json!({"revision":initial["revision"], "value":{"profiles":[{
        "name":"Fixture", "selection":{"id":"fixture","provider":"codex","model":"fixture"},
        "group":"shared",
    }]}});
    assert_eq!(
        put_settings(&api, profiles, &BOARD_KEY, &input)
            .await
            .status(),
        StatusCode::OK
    );
    let path = "/v1/settings/profiles/pauses/shared";
    let deadline = now_ms() + 60_000;
    let pause = json!({"untilMs":deadline});
    assert_eq!(
        put_settings(&api, path, &PLANNER_KEY, &pause)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let mut changes = service.profile_usage_changes.subscribe();
    let saved = put_settings(&api, path, &BOARD_KEY, &pause).await;
    assert_eq!(saved.status(), StatusCode::OK);
    assert_eq!(
        json_body(saved).await,
        json!({"group":"shared","untilMs":deadline})
    );
    assert!(changes.has_changed().unwrap());
    changes.mark_unchanged();
    let repeated = put_settings(&api, path, &BOARD_KEY, &pause).await;
    assert_eq!(repeated.status(), StatusCode::OK);
    assert!(
        !changes.has_changed().unwrap(),
        "an identical stored pause is quiet"
    );
    let state = service.state.lock().await;
    assert_eq!(
        state.store.provider_pause("shared", deadline - 1).unwrap(),
        Some(deadline)
    );
    assert_eq!(
        state.store.provider_pause("shared", deadline).unwrap(),
        None
    );
}

#[tokio::test]
async fn profile_pause_edits_wake_a_parked_capacity_waiter() {
    let (_home, service) = registry_fixture(GitHub::new("fixture").expect("client"));
    let service = Arc::new(service);
    let api = settings_api(&service);
    let path = "/v1/settings/profiles";
    let initial = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(initial["value"]["pausedGroups"], json!([]));
    let mut input = json!({"revision": initial["revision"], "value": initial["value"]});
    input["value"]["pausedGroups"] = json!([" shared"]);
    assert_eq!(
        put_settings(&api, path, &BOARD_KEY, &input).await.status(),
        StatusCode::BAD_REQUEST
    );
    input["value"]["pausedGroups"] = json!(["shared"]);
    let paused = json_body(put_settings(&api, path, &BOARD_KEY, &input).await).await;
    assert_eq!(paused["value"]["pausedGroups"], json!(["shared"]));
    {
        let mut state = service.state.lock().await;
        state.set_wait("awaiting-group", Some(WaitReason::Capacity));
        state.group_waits.insert(
            "awaiting-group".into(),
            crate::profiles::GroupPause::Manual {
                group: "shared".into(),
            },
        );
        state.schedule.park("awaiting-group");
        assert!(state.schedule.due("awaiting-group").is_none());
    }
    let input =
        json!({"revision": paused["revision"], "value": {"profiles": [], "pausedGroups": []}});
    let unpaused = json_body(put_settings(&api, path, &BOARD_KEY, &input).await).await;
    assert_eq!(unpaused["value"]["pausedGroups"], json!([]));
    let state = service.state.lock().await;
    assert!(
        state.schedule.due("awaiting-group").expect("settings wake") <= tokio::time::Instant::now()
    );
}

#[tokio::test]
async fn board_profiles_use_dispatch_subscription_groups_and_pause_the_same_group() {
    use crate::profiles::LaunchSelection;

    let (home, mut service, _planner_host) =
        enrolled_fixture(GitHub::new("fixture").expect("client")).await;
    let (host, native) = crate::tests::native_fixture(subscription_catalog_reply).await;
    service.host = host;
    let service = Arc::new(service);
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "Profiles").unwrap();
    std::fs::write(assets.join("app.js"), "").unwrap();
    let api = router_with_board(
        Arc::clone(&service),
        [
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            },
            Controller {
                credential: PLANNER_KEY,
                authority: Authority::Planner {
                    actor: "planner".into(),
                },
            },
        ],
        &assets,
    )
    .unwrap();
    let cookie = pair_board(&api, &BOARD_KEY).await;
    let path = "/api/engine/settings/profiles";
    let initial = read_paired_task(&api, path, &cookie).await;
    let mut input = json!({"revision":initial["revision"],"value":{"profiles":[
        {"name":"Team","selection":{"id":"team","provider":"codex","model":"team-only"}},
        {"name":"Explicit","enabled":false,"group":"shared","providerInstanceId":"codex-team",
         "selection":{"id":"explicit","provider":"codex","model":"base"}},
        {"name":"Pinned","enabled":false,"providerInstanceId":"codex-team",
         "selection":{"id":"pinned","provider":"codex","model":"base"}},
        {"name":"Missing","selection":{"id":"missing","provider":"codex","model":"other"}}
    ]}});
    let saved =
        json_body(browser_request(&api, Method::PUT, path, Some(&cookie), Some(&input)).await)
            .await;
    assert_eq!(
        saved["effectiveGroups"],
        json!({"explicit":"shared","pinned":"codex-team"})
    );
    assert!(service.host.host_calls().is_empty());

    let pass = service.host.fixture_pass();
    pass.profile_catalog().await.expect("seed cached catalog");
    let calls = service.host.host_calls();
    let snapshot = read_paired_task(&api, "/api/engine/settings", &cookie).await;
    let groups = json!({"team":"codex-team","explicit":"shared","pinned":"codex-team"});
    assert_eq!(snapshot["profiles"]["effectiveGroups"], groups);
    let profiles = read_paired_task(&api, path, &cookie).await;
    assert_eq!(profiles["effectiveGroups"], groups);
    assert_eq!(service.host.host_calls(), calls);

    let (task, observation) = subscription_launch_task();
    let select = || service.select_launch(&task, &observation, nucleus_core::Role::Worker, &pass);
    let Ok(LaunchSelection::Profile(launch)) = select().await else {
        panic!("eligible team profile")
    };
    assert_eq!(launch.group, groups["team"]);

    input["revision"] = saved["revision"].clone();
    input["value"]["pausedGroups"] = json!([groups["team"]]);
    let manual =
        json_body(browser_request(&api, Method::PUT, path, Some(&cookie), Some(&input)).await)
            .await;
    assert_eq!(manual["value"]["pausedGroups"], json!(["codex-team"]));
    assert!(matches!(select().await, Ok(LaunchSelection::Paused)));

    input["revision"] = manual["revision"].clone();
    input["value"]["pausedGroups"] = json!([]);
    assert_eq!(
        browser_request(&api, Method::PUT, path, Some(&cookie), Some(&input))
            .await
            .status(),
        StatusCode::OK
    );
    let now = now_ms();
    let deadline = now + 60_000;
    {
        let state = service.state.lock().await;
        service
            .record_subscription_pause(&state, &launch.group, deadline, now)
            .unwrap();
    }
    let usage = read_paired_task(&api, "/api/engine/profiles/usage", &cookie).await;
    assert_eq!(usage["limitedGroups"], json!({"codex-team":deadline}));
    assert!(matches!(select().await, Ok(LaunchSelection::Paused)));
    assert_paired_pause_clear(&api, &service, &cookie, now, deadline).await;
    native.abort();
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the admission, pause and both labels read as one story"
)]
async fn a_required_paused_group_is_named_and_a_slot_wait_stays_capacity() {
    use crate::profiles::LaunchSelection;

    let (home, mut service) = fixture(GitHub::new("fixture").expect("client"));
    let (host, native) = crate::tests::native_fixture(subscription_catalog_reply).await;
    service.host = host;
    let service = Arc::new(service);
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "Profiles").unwrap();
    std::fs::write(assets.join("app.js"), "").unwrap();
    let api = router_with_board(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "operator".into(),
            },
        }],
        &assets,
    )
    .unwrap();
    let cookie = pair_board(&api, &BOARD_KEY).await;
    let path = "/api/engine/settings/profiles";
    let initial = read_paired_task(&api, path, &cookie).await;
    let input = json!({"revision": initial["revision"], "value": {"profiles": [
        {"name":"Team","selection":{"id":"team","provider":"codex","model":"team-only"}}
    ]}});
    assert_eq!(
        browser_request(&api, Method::PUT, path, Some(&cookie), Some(&input))
            .await
            .status(),
        StatusCode::OK
    );

    let paused = json!({"repository":REPOSITORY, "id":"paused","reference":"paused","brief":"---\nqueue:\n  complexity: low\n  profileRequests:\n    worker:\n      profileId: team\n      reason: fixture\n      required: true\n---\n# Paused brief"});
    let response = browser_request(
        &api,
        Method::POST,
        "/api/engine/tasks",
        Some(&cookie),
        Some(&paused),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let slot = json!({"repository":REPOSITORY, "id":"slot","reference":"slot","brief":"---\nqueue:\n  complexity: low\n---\n# Slot brief"});
    let response = browser_request(
        &api,
        Method::POST,
        "/api/engine/tasks",
        Some(&cookie),
        Some(&slot),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);

    let deadline = now_ms() + 60_000;
    {
        let state = service.state.lock().await;
        service
            .record_subscription_pause(&state, "codex-team", deadline, now_ms())
            .unwrap();
    }
    let observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(nucleus_core::Workspace::Absent),
    };
    let mut launch = service.task("paused").await.unwrap().task;
    assert_eq!(
        launch.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    let pass = service.host.fixture_pass();
    assert!(matches!(
        service
            .select_launch(&launch, &observation, nucleus_core::Role::Worker, &pass)
            .await,
        Ok(LaunchSelection::Paused)
    ));
    let row = service.task("paused").await.unwrap();
    service
        .schedule_result(
            &row,
            &Ok(Action::Wait(WaitReason::Capacity)),
            crate::schedule::Priority::Wake,
        )
        .await
        .unwrap();

    let horizon = nucleus_hosts::snooze_deadline(deadline);
    let detail = read_paired_task(&api, "/api/engine/tasks/paused", &cookie).await;
    assert_eq!(detail["stateLabel"], "Queued · paused");
    let next = read_paired_task(&api, "/api/engine/tasks/paused/next", &cookie).await;
    assert_eq!(next["wait"], "capacity");
    assert_eq!(
        next["waitDetail"],
        format!("Paused: subscription group codex-team resets at {horizon}.")
    );
    let list = read_paired_task(&api, "/api/engine/tasks", &cookie).await;
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .any(|task| task["stateLabel"] == "Queued · paused")
    );

    let slot_row = service.task("slot").await.unwrap();
    service
        .schedule_result(
            &slot_row,
            &Ok(Action::Wait(WaitReason::Capacity)),
            crate::schedule::Priority::Wake,
        )
        .await
        .unwrap();
    let slot_detail = read_paired_task(&api, "/api/engine/tasks/slot", &cookie).await;
    assert_eq!(slot_detail["stateLabel"], "Queued · capacity");
    let slot_next = read_paired_task(&api, "/api/engine/tasks/slot/next", &cookie).await;
    assert_eq!(slot_next["wait"], "capacity");
    assert!(slot_next["waitDetail"].is_null());
    native.abort();
}

#[tokio::test]
async fn storage_saves_the_preference_and_reports_a_failed_backup() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let service = Arc::new(service);
    let api = settings_api(&service);
    let path = "/v1/settings/storage";
    let original = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(original["backups"]["verified"], json!([]));
    assert!(original["configBackups"]["verified"].is_array());
    service.backup_failed.store(true, Ordering::Release);
    let failed = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(failed["backups"]["issues"], 1);
    assert_eq!(failed["configBackups"], original["configBackups"]);
    assert_eq!(original["active"]["placement"], "internal");
    assert_eq!(original["active"]["bargePaths"], json!({}));
    assert!(original["settings"]["value"].get("workVolume").is_none());
    let mut update = json!({
        "revision": original["settings"]["revision"],
        "value": original["settings"]["value"],
    });
    update["value"]["workVolume"] = json!({"mount": "/fixture/volume", "volumeId": "fixture"});
    assert_eq!(
        put_settings(&api, path, &BOARD_KEY, &update).await.status(),
        StatusCode::BAD_REQUEST
    );
    update["value"]
        .as_object_mut()
        .unwrap()
        .remove("workVolume");
    update["value"]["retention"]["keepNewest"] = json!(3);
    let saved = json_body(put_settings(&api, path, &BOARD_KEY, &update).await).await;
    assert_eq!(saved["settings"]["value"]["retention"]["keepNewest"], 3);
    assert_eq!(
        service
            .settings
            .load()
            .expect("read on-disk settings")
            .retention
            .keep_newest,
        3
    );
}

#[tokio::test]
async fn host_settings_reject_embedded_credentials_and_stage_the_endpoint() {
    let (_home, service) = registry_fixture(GitHub::new("fixture").expect("client"));
    let service = Arc::new(service);
    let api = settings_api(&service);
    let path = "/v1/settings/hosts";
    let original = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    let mut update = json!({
        "revision": original["settings"]["revision"],
        "value": {"t3": {"endpoint": "http://user:fixture-password@localhost:8000", "credentialRef": "T3_TEST_BEARER"}}
    });
    let failed = put_settings(&api, path, &BOARD_KEY, &update).await;
    assert_eq!(failed.status(), StatusCode::BAD_REQUEST);
    assert!(
        !json_body(failed)
            .await
            .to_string()
            .contains("fixture-password")
    );
    update["value"]["t3"]["endpoint"] = json!("http://localhost:8000");
    update["value"]["t3"]["bearer"] = json!("fixture-not-a-reference");
    assert_eq!(
        put_settings(&api, path, &BOARD_KEY, &update).await.status(),
        StatusCode::BAD_REQUEST
    );
    update["value"]["t3"]
        .as_object_mut()
        .expect("T3 config")
        .remove("bearer");
    let after = json_body(put_settings(&api, path, &BOARD_KEY, &update).await).await;
    assert_eq!(
        after["settings"]["value"]["t3"]["endpoint"],
        "http://localhost:8000/"
    );
    assert_eq!(after["active"], original["active"]);
}
