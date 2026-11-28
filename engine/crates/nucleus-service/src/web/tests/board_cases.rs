use super::*;

#[tokio::test]
async fn done_archival_follows_the_held_shell_after_a_thread_reopens() {
    let (_home, mut service) = registry_fixture(GitHub::new("fixture").expect("client"));
    service.set_fixture_acp_provider(Some("fixture-acp"));
    let (mut first, merged) = fixture_at_done(&service).await;
    {
        let mut state = service.state.lock().await;
        first.version = crate::tests::save_row(
            &mut state.store,
            &first,
            &first.task,
            &event("role_threads_archived"),
        )
        .expect("first receipt");
    }
    let second = reopen_and_finish_review(&service, &first, &merged).await;
    let child = second
        .task
        .threads()
        .get(nucleus_core::Role::Reviewer)
        .expect("new child");
    let (host, parent, archived, publish, native) = archive_shell_fixture(&service, child).await;
    service.host = host.with_quiet_fixture_processes();
    let (forge, readable, _, reads, server) = serve_merged_forge(&service.fixture().start).await;
    service.forge = forge;
    let draft = {
        let work = service.worktrees();
        let project = service.fixture();
        let identity = second.task.identity();
        let checkout = work
            .checkout(&project.checkout, &identity.repository, &identity.id)
            .unwrap();
        checkout.allocate(&project.start).unwrap();
        let draft = checkout.path().join("unfinished-draft");
        std::fs::write(&draft, "keep this draft").unwrap();
        draft
    };
    let registered = service.fixture().checkout.clone();
    let moved = registered.with_file_name("moved-registered-checkout");
    std::fs::rename(&registered, &moved).unwrap();
    for _ in 0..2 {
        publish(&service.host, None);
        assert!(matches!(
            service.archive_done(&second).await.expect("archive effect"),
            Action::Wait(WaitReason::Stopping)
        ));
    }
    assert!(draft.is_file());
    std::fs::rename(moved, registered).unwrap();
    publish(&service.host, None);
    assert!(
        matches!(service.archive_done(&second).await,Err(ServiceError::CheckoutRetained(cause)) if cause.contains("retained"))
    );
    assert_eq!(std::fs::read_to_string(&draft).unwrap(), "keep this draft");
    assert_eq!(
        *archived.lock().expect("archive writes"),
        [child, parent.as_str()]
    );
    publish(&service.host, Some(child));
    assert!(matches!(
        service
            .archive_done(&second)
            .await
            .expect("archive reopened child"),
        Action::Wait(WaitReason::Stopping)
    ));
    assert_eq!(
        *archived.lock().expect("archive writes"),
        [child, parent.as_str(), child]
    );
    publish(&service.host, None);
    assert_eq!(reads.load(Ordering::Relaxed), 0);
    std::fs::remove_file(&draft).unwrap();
    let checkout = draft.parent().unwrap();
    assert!(
        matches!(service.archive_done(&second).await, Err(ServiceError::Forge(ForgeError::Status(status))) if status == StatusCode::SERVICE_UNAVAILABLE)
    );
    assert!(checkout.is_dir());
    assert_eq!(reads.load(Ordering::Relaxed), 1);

    readable.store(true, Ordering::Relaxed);
    service.forge_until.store(0, Ordering::Relaxed);
    assert_eq!(
        service.archive_done(&second).await.unwrap(),
        Action::Nothing
    );
    assert!(!checkout.exists());
    server.abort();
    native.abort();
}

#[tokio::test]
async fn done_archival_recovers_interrupted_cleanup_without_dot_git_and_prunes_trash() {
    let (_home, mut service) = fixture(GitHub::new("fixture").expect("client"));
    service.set_fixture_acp_provider(Some("fixture-acp"));
    {
        let repo = &service.fixture().checkout;
        std::fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(repo.join("tracked.txt"), "published").unwrap();
        crate::tests::git(repo, &["add", ".gitignore", "tracked.txt"]);
        crate::tests::git(
            repo,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                "Add tracked inputs",
            ],
        );
        crate::tests::git(repo, &["push", "origin", "main"]);
    }
    let (done, _) = fixture_at_done(&service).await;
    assert!(matches!(
        service
            .command(
                &done.task.identity().id,
                &Authority::Operator {
                    actor: "fixture".into(),
                },
                Command::Release,
            )
            .await
            .expect("release hold"),
        nucleus_store::TaskRow { task, .. } if task.hold().is_none()
    ));
    let done = service.task(&done.task.identity().id).await.unwrap();
    let (native, _archive) = empty_archive_fixture(1).await;
    service.host = native.with_quiet_fixture_processes();
    service.host.use_held_shell();
    let (forge, readable, _, _, server) = serve_merged_forge(&service.fixture().start).await;
    readable.store(true, Ordering::Relaxed);
    service.forge = forge;

    let checkout_path = {
        let work = service.worktrees();
        let project = service.fixture();
        let identity = done.task.identity();
        let checkout = work
            .checkout(&project.checkout, &identity.repository, &identity.id)
            .unwrap();
        checkout.allocate(&project.start).unwrap();
        checkout.path().to_owned()
    };
    hold_archived_workspace(&service, &done.task, &checkout_path);
    let deps = checkout_path.join("node_modules/pkg");
    std::fs::create_dir_all(&deps).unwrap();
    std::fs::write(deps.join("index.js"), "ignored build artifact").unwrap();
    std::fs::remove_file(checkout_path.join("tracked.txt")).unwrap();
    std::fs::remove_file(checkout_path.join(".git")).unwrap();

    // Unpublished work must still retain the checkout even when .git was already deleted.
    let draft = checkout_path.join("draft.md");
    std::fs::write(&draft, "keep local work").unwrap();
    let retained_outcome = service.archive_done(&done).await;
    assert!(
        matches!(
            &retained_outcome,
            Err(ServiceError::CheckoutRetained(cause)) if cause.contains("retained")
        ),
        "{retained_outcome:?}"
    );
    assert_eq!(std::fs::read_to_string(&draft).unwrap(), "keep local work");
    std::fs::remove_file(&draft).unwrap();

    assert_eq!(service.archive_done(&done).await.unwrap(), Action::Nothing);
    assert!(!checkout_path.exists());

    let trash_root = service.storage.work().path().join(".trash");
    assert!(trash_root.is_dir());
    nucleus_work::prune_trash(service.storage.work(), u64::MAX, |_| true).unwrap();
    assert_eq!(std::fs::read_dir(&trash_root).unwrap().count(), 0);
    server.abort();
}

#[tokio::test]
async fn standalone_board_serves_assets_and_local_apis_without_a_typescript_service() {
    let (home, service, _planner_host) =
        enrolled_fixture(GitHub::new("unused-forge-fixture").expect("client")).await;
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).expect("assets directory");
    std::fs::write(assets.join("index.html"), "<script src='/app.js'></script>")
        .expect("board HTML");
    std::fs::write(assets.join("app.js"), "document.title = 'Fixture Board';")
        .expect("board script");
    let api = router_with_board(
        Arc::new(service),
        [
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            },
            planner_controller(PLANNER_KEY, "planner"),
        ],
        &assets,
    )
    .expect("board router");
    assert_board_assets(&api).await;

    let tasks = "/api/engine/tasks";
    let dispatch = "/api/engine/settings/dispatch";
    assert_eq!(
        get_as(&api, tasks, &BOARD_KEY).await.status(),
        StatusCode::UNAUTHORIZED,
        "the browser route requires a paired session"
    );
    let operator = pair_board(&api, &BOARD_KEY).await;
    let planner = pair_board(&api, &PLANNER_KEY).await;
    let view = json_body(
        browser_request(
            &api,
            Method::GET,
            "/api/engine/session",
            Some(&planner),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(view["canEditSettings"], false);

    assert_browser_origin(&api, &operator).await;

    let response = browser_request(
        &api,
        Method::GET,
        "/api/engine/events",
        Some(&operator),
        None,
    )
    .await;
    let mut events = response.into_body().into_data_stream();
    assert_event(&mut events, &["event: refresh"]).await;
    let starting =
        json_body(browser_request(&api, Method::GET, dispatch, Some(&operator), None).await).await;
    assert_eq!(starting["value"]["mode"], "running");
    let mut update = json!({"revision": starting["revision"], "value": starting["value"]});
    update["value"]["heavySlots"] = json!(3);
    update["value"]["mode"] = json!("held");
    assert_eq!(
        browser_request(&api, Method::PUT, dispatch, Some(&planner), Some(&update))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let saved = json_body(
        browser_request(&api, Method::PUT, dispatch, Some(&operator), Some(&update)).await,
    )
    .await;
    assert_eq!(saved["value"]["heavySlots"], 3);
    assert_eq!(saved["value"]["mode"], "held");
    assert_event(&mut events, &["event: settings"]).await;
    let admission = json!({"repository":REPOSITORY, "id":"board-task","reference":"D1","brief":"---\nqueue:\n  complexity: low\n---\n# Standalone task"});
    let response =
        browser_request(&api, Method::POST, tasks, Some(&operator), Some(&admission)).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_event(&mut events, &["event: invalidate", "board-task"]).await;
    let listed =
        json_body(browser_request(&api, Method::GET, tasks, Some(&operator), None).await).await;
    assert_eq!(listed[0]["phase"], "queued");
    assert_eq!(listed[0]["title"], "Standalone task");
    let hold = json!({"hold":"Wait for the fixture"});
    let response = browser_request(
        &api,
        Method::POST,
        "/api/engine/tasks/board-task/commands",
        Some(&operator),
        Some(&hold),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["phase"], "queued");
    assert_event(&mut events, &["event: invalidate", "board-task"]).await;
    assert_eq!(
        json_body(get_as(&api, "/v1/tasks/board-task", &BOARD_KEY).await).await["wait"],
        "hold"
    );
    assert_browser_lanes(&api, &operator, &mut events).await;
}

#[tokio::test]
async fn mounted_task_detail_uses_the_paired_stored_task() {
    let (home, mut service) = fixture(GitHub::new("unused-forge-fixture").unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    service.callback = address;
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "Fixture Board").unwrap();
    std::fs::write(assets.join("app.js"), "").unwrap();
    let api = router_with_board(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
        &assets,
    )
    .unwrap();
    let request = |method, path: &str, credential: &str, body: Body| {
        Request::builder()
            .method(method)
            .uri(path)
            .header(HOST, address.to_string())
            .header(ORIGIN, format!("http://{address}"))
            .header("x-nucleus-board", "1")
            .header(AUTHORIZATION, format!("Bearer {credential}"))
            .header("content-type", "application/json")
            .body(body)
            .unwrap()
    };
    let link = json_body(
        api.clone()
            .oneshot(request(
                Method::POST,
                "/v1/board/link",
                &hex::encode(BOARD_KEY),
                Body::from("{}"),
            ))
            .await
            .unwrap(),
    )
    .await;
    let token = link["url"]
        .as_str()
        .unwrap()
        .split("#token=")
        .nth(1)
        .unwrap();
    let pair = api
        .clone()
        .oneshot(request(
            Method::POST,
            "/api/engine/pair",
            token,
            Body::empty(),
        ))
        .await
        .unwrap();
    assert_eq!(pair.status(), StatusCode::NO_CONTENT);
    let cookie = pair.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let admission = json!({"repository":REPOSITORY, "id":"board-task", "reference":"D1", "brief":"---\nqueue:\n  complexity: low\n---\n# Standalone task"});
    let response = api
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/engine/tasks")
                .header(HOST, address.to_string())
                .header(ORIGIN, format!("http://{address}"))
                .header("x-nucleus-board", "1")
                .header("content-type", "application/json")
                .header("cookie", &cookie)
                .body(Body::from(admission.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let server = tokio::spawn(async move { axum::serve(listener, api).await.unwrap() });
    let output = run_mounted_task_board(address, &cookie).await;
    server.abort();
    assert!(
        output.status.success(),
        "mounted board failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn board_age_survives_an_amendment_and_restart_only_baselines_the_wait() {
    let forge = || GitHub::new("unused-fixture-forge").unwrap();
    let (home, service) = fixture(forge());
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "Fixture Board").unwrap();
    std::fs::write(assets.join("app.js"), "").unwrap();
    let settings = service.settings.clone();
    let project = service.fixture().clone();
    let service = Arc::new(service);
    let setup = |service| {
        router_with_board(
            service,
            [Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "fixture".into(),
                },
            }],
            &assets,
        )
        .unwrap()
    };
    let api = setup(Arc::clone(&service));
    let cookie = pair_board(&api, &BOARD_KEY).await;
    let list = "/api/engine/tasks";
    let detail = "/api/engine/tasks/age";
    let next = "/api/engine/tasks/age/next";
    let admitted = json!({"repository":REPOSITORY, "id":"age","reference":"age","brief":"---\nqueue:\n  complexity: low\n---\n# Initial title"});
    let response = browser_request(&api, Method::POST, list, Some(&cookie), Some(&admitted)).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let queued = read_paired_task(&api, detail, &cookie).await;
    assert_eq!(queued["stateLabel"], "Queued");
    let created = &queued["createdAtMs"];
    assert!(created.is_u64());
    assert_eq!(&queued["stateSinceMs"], created);

    observe_task_wait(&service, WaitReason::Capacity).await;
    let since = 1_700_000_000_000_i64;
    service
        .state
        .lock()
        .await
        .store
        .record_board_entry("age", since)
        .unwrap();
    let capacity = read_paired_task(&api, list, &cookie).await[0].clone();
    assert_eq!(capacity["stateLabel"], "Queued · capacity");
    assert_eq!(capacity["stateSinceMs"], since);

    let amend = json!({"amend": "---\nqueue:\n  complexity: low\n---\n# Renamed title"});
    let response = browser_request(
        &api,
        Method::POST,
        "/api/engine/tasks/age/commands",
        Some(&cookie),
        Some(&amend),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let changed = json_body(response).await;
    assert_eq!(changed["title"], "Renamed title");
    assert_eq!(changed["stateSinceMs"], since);
    assert!(
        service.host.host_calls().is_empty(),
        "board GETs do not read the host"
    );
    drop(api);
    drop(service);

    let reopened = Arc::new(reopen_fixture(&settings, &project, forge()));
    let api = setup(Arc::clone(&reopened));
    observe_task_wait(&reopened, WaitReason::Capacity).await;
    let recorded = reopened
        .state
        .lock()
        .await
        .store
        .board_times("age")
        .unwrap()
        .since;
    assert_eq!(
        recorded,
        u64::try_from(since).ok(),
        "restart did not write a clock"
    );

    for (path, array) in [(list, true), (detail, false), (next, false)] {
        let dto = read_paired_task(&api, path, &cookie).await;
        let view = if array { &dto[0] } else { &dto };
        assert_eq!(view["stateLabel"], capacity["stateLabel"], "{path}");
        assert!(
            view["stateSinceMs"].is_null(),
            "{path} has no verified entry"
        );
    }
    observe_task_wait(&reopened, WaitReason::ForgeUnknown).await;
    let changed = read_paired_task(&api, detail, &cookie).await;
    assert_eq!(changed["stateLabel"], "Queued · GitHub");
    assert_eq!(
        changed["lifecycle"]["steps"][0]["note"],
        changed["stateLabel"]
    );
    assert!(changed["stateSinceMs"].as_i64().unwrap() > since);
    assert_eq!(&changed["createdAtMs"], created);
}

#[tokio::test]
async fn operator_hold_keeps_its_state_entry_across_restart() {
    let forge = || GitHub::new("unused-fixture-forge").unwrap();
    let (_home, service) = registry_fixture(forge());
    let settings = service.settings.clone();
    let project = service.fixture().clone();
    seed_planner_task(&service, "held", "fixture-planner").await;
    let operator = Authority::Operator {
        actor: "fixture".into(),
    };
    service
        .command("held", &operator, Command::Hold("Wait for approval".into()))
        .await
        .unwrap();
    let api = settings_api(&Arc::new(service));
    let path = "/v1/tasks/held";
    let before = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(before["stateLabel"], "Queued · Tom");
    assert!(before["stateSinceMs"].is_u64());
    assert!(before["latestEventAtMs"].is_u64());
    drop(api);

    let reopened = Arc::new(reopen_fixture(&settings, &project, forge()));
    let after = json_body(get_as(&settings_api(&reopened), path, &BOARD_KEY).await).await;
    assert_eq!(after["stateLabel"], before["stateLabel"]);
    assert_eq!(after["stateSinceMs"], before["stateSinceMs"]);
    assert_eq!(after["latestEventAtMs"], before["latestEventAtMs"]);
}

#[tokio::test]
async fn board_cookie_survives_a_service_restart_and_operator_revocation() {
    use std::os::unix::fs::PermissionsExt;

    let forge = || GitHub::new("unused-fixture-forge").expect("fixture forge");
    let (home, service, _planner_host) = enrolled_fixture(forge()).await;
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "Fixture Board").unwrap();
    std::fs::write(assets.join("app.js"), "").unwrap();
    let controllers = || {
        [
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            },
            planner_controller(PLANNER_KEY, "planner"),
        ]
    };
    let endpoint = service.host.endpoint().to_owned();
    let settings = service.settings.clone();
    let project = service.fixture().clone();
    let file = service.storage.database().path().join("web-sessions.json");
    let setup = |service| router_with_board(service, controllers(), &assets).unwrap();
    let api = setup(Arc::new(service));
    let cookie = pair_board(&api, &BOARD_KEY).await;
    assert_eq!(
        post_as(&api, "/v1/board/revoke", &PLANNER_KEY, &json!({}))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let cookie_secret = cookie.split_once('=').unwrap().1;
    let stored = std::fs::read_to_string(&file).unwrap();
    assert!(!stored.contains(cookie_secret));
    assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    drop(api);

    let reopen = || Arc::new(reopen_fixture_at(&settings, &project, forge(), &endpoint));
    let restarted = reopen();
    let api = setup(Arc::clone(&restarted));
    {
        let empty = json!({});
        let request = post_as(&api, "/v1/board/revoke", &PLANNER_KEY, &empty);
        tokio::pin!(request);
        tokio::select! {
            biased;
            () = restarted.enrollment_wake.notified() => {}
            _ = &mut request => panic!("restarted planner request finished before enrollment"),
        }
        assert_eq!(
            restarted.take_enrollment().await.as_deref(),
            Some("planner")
        );
        restarted.complete_enrollment("planner").await;
        assert_eq!(request.await.status(), StatusCode::FORBIDDEN);
    }
    let session_path = "/api/engine/session";
    let session = browser_request(&api, Method::GET, session_path, Some(&cookie), None).await;
    assert_eq!(json_body(session).await["canEditSettings"], true);
    let mut events = browser_request(&api, Method::GET, "/api/engine/events", Some(&cookie), None)
        .await
        .into_body()
        .into_data_stream();
    assert_event(&mut events, &["event: refresh"]).await;
    assert_eq!(
        json_body(post_as(&api, "/v1/board/revoke", &BOARD_KEY, &json!({})).await).await["revoked"],
        1
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), events.next())
            .await
            .unwrap()
            .is_none()
    );
    drop(events);
    drop(api);
    drop(restarted);
    let api = setup(reopen());
    let revoked = browser_request(&api, Method::GET, session_path, Some(&cookie), None).await;
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn board_pairing_at_capacity_reclaims_the_least_recently_used_device() {
    let forge = || GitHub::new("unused-fixture-forge").expect("fixture forge");
    let (home, service) = registry_fixture(forge());
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "Fixture Board").unwrap();
    std::fs::write(assets.join("app.js"), "").unwrap();
    let controllers = [Controller {
        credential: BOARD_KEY,
        authority: Authority::Operator {
            actor: "operator".into(),
        },
    }];
    let api = router_with_board(Arc::new(service), controllers, &assets).unwrap();
    let session_path = "/api/engine/session";
    let mut cookies = Vec::new();
    for _ in 0..64 {
        cookies.push(pair_board(&api, &BOARD_KEY).await);
    }
    // Device 1 opens an event stream first, then every other device is used
    // again. Device 1 is therefore the least recently used device at capacity.
    let mut idle_events = browser_request(
        &api,
        Method::GET,
        "/api/engine/events",
        Some(cookies[1].as_str()),
        None,
    )
    .await
    .into_body()
    .into_data_stream();
    assert_event(&mut idle_events, &["event: refresh"]).await;
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    for (index, cookie) in cookies.iter().enumerate().filter(|(index, _)| *index != 1) {
        let used = browser_request(&api, Method::GET, session_path, Some(cookie), None).await;
        assert_eq!(used.status(), StatusCode::OK, "device {index}");
    }

    let fresh = pair_board(&api, &BOARD_KEY).await;

    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), idle_events.next())
            .await
            .unwrap()
            .is_none()
    );
    let fresh_session = browser_request(&api, Method::GET, session_path, Some(&fresh), None).await;
    assert_eq!(fresh_session.status(), StatusCode::OK);
    let recent = browser_request(
        &api,
        Method::GET,
        session_path,
        Some(cookies[0].as_str()),
        None,
    )
    .await;
    assert_eq!(recent.status(), StatusCode::OK);
    let evicted = browser_request(
        &api,
        Method::GET,
        session_path,
        Some(cookies[1].as_str()),
        None,
    )
    .await;
    assert_eq!(evicted.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn planner_extend_via_http_raises_the_exhausted_allowance_once() {
    let (_root, mut service, _planner_host) =
        enrolled_fixture(GitHub::new("unused").unwrap()).await;
    let (host, _, _, native) = planner_roster_fixture("planner", "other").await;
    service.host = host;
    let (asked, limit) = exhaust_legacy_allowance(&service).await;
    let mut assigned = asked.task.clone();
    let notice =
        T3::prepare_notice("planner".into(), "notice".into(), "Extend the allowance?").unwrap();
    assert!(assigned.bind_question_delivery(notice));
    service
        .save(&asked, assigned, &event("question_delivery"))
        .await
        .unwrap();
    service.refresh_planner_authority("legacy").await.unwrap();
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [
            planner_controller(PLANNER_KEY, "planner"),
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "board".into(),
                },
            },
        ],
    );
    let next = "/v1/tasks/legacy/next";
    let commands = "/v1/tasks/legacy/commands";
    let before = json_body(get_as(&api, next, &BOARD_KEY).await).await;
    assert_eq!(before["allowance"]["exhausted"], true);
    assert_eq!(before["allowance"]["limitMs"], 2 * limit);
    let answer = json!({"answer":"extend"});
    assert_eq!(
        post_json(&api, commands, &PLANNER_KEY, &answer).await,
        StatusCode::OK
    );
    let after = json_body(get_as(&api, next, &BOARD_KEY).await).await;
    let used_before = before["allowance"]["usedMs"].as_u64().unwrap();
    let extended_limit = after["allowance"]["limitMs"].as_u64().unwrap();
    assert!(used_before >= 2 * limit + 1_000);
    assert!(
        extended_limit >= used_before + limit,
        "new limit {extended_limit}, used {used_before}"
    );
    assert_eq!(after["allowance"]["exhausted"], false);
    assert!(after["question"].is_null());
    assert!(
        !post_as(&api, commands, &PLANNER_KEY, &answer)
            .await
            .status()
            .is_success()
    );
    let row = service.task("legacy").await.unwrap();
    assert!(
        row.task.run().is_some(),
        "the unsent reservation still belongs to the task"
    );
    let store = nucleus_store::Store::open(&service.storage).unwrap();
    let restored = store
        .allowance("legacy")
        .unwrap()
        .view(&row.task, store.allowance_elapsed().unwrap());
    assert_eq!(restored.limit_ms, extended_limit);
    assert!(!restored.exhausted);
    native.abort();
}

#[tokio::test]
async fn board_detail_serves_full_transcript_and_per_step_times_without_t3_calls() {
    let (_home, mut service) =
        registry_fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let (host, native) = crate::tests::native_fixture(|_| {
        panic!("reading task detail must not call T3");
    })
    .await;
    service.host = host;
    let head1 = service.fixture().start.clone();
    let head2 = nucleus_core::Head::try_from("b".repeat(40)).unwrap();
    let (row, pr1) = Box::pin(start_full_cycle_task(&service, head1)).await;
    Box::pin(finish_full_cycle_task(&service, row, pr1, head2)).await;

    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "board".into(),
            },
        }],
    );
    let detail = json_body(get_as(&api, "/v1/tasks/full-cycle", &BOARD_KEY).await).await;
    assert_full_cycle_detail(&detail);
    assert!(service.host.host_calls().is_empty());
    native.abort();
}

#[tokio::test]
async fn board_detail_serves_pre_1601_nulls_and_failure_outcomes() {
    let (_home, service) = registry_fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let head = service.fixture().start.clone();
    Box::pin(seed_pre_1601_task(&service, &head)).await;
    Box::pin(seed_outcome_runs(&service, &head)).await;

    let api = router(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "board".into(),
            },
        }],
    );

    let legacy_detail = json_body(get_as(&api, "/v1/tasks/pre-1601", &BOARD_KEY).await).await;
    let legacy_steps = legacy_detail["lifecycle"]["steps"].as_array().unwrap();
    assert_eq!(legacy_steps[0]["enteredAtMs"], 1_000);
    assert!(legacy_steps[0]["leftAtMs"].is_null());
    for step in &legacy_steps[1..=3] {
        assert!(step["enteredAtMs"].is_null());
        assert!(step["leftAtMs"].is_null());
    }
    assert!(legacy_steps[4]["enteredAtMs"].is_null());
    assert_eq!(legacy_steps[4]["leftAtMs"], 10_000);
    assert_eq!(
        legacy_detail["lifecycle"]["transcript"]["cards"][0]["endedAtMs"],
        10_000
    );

    let outcomes_detail = json_body(get_as(&api, "/v1/tasks/outcomes", &BOARD_KEY).await).await;
    let cards = outcomes_detail["lifecycle"]["transcript"]["cards"]
        .as_array()
        .unwrap();
    assert_eq!(cards.len(), 3);
    assert_eq!(cards[0]["outcome"]["kind"], "provider_limit");
    assert_eq!(cards[0]["outcome"]["group"], "shared");
    assert_eq!(cards[0]["outcome"]["reset_at_ms"], 90_000);
    assert_eq!(cards[0]["endedAtMs"], 25_000);
    assert_eq!(cards[1]["outcome"]["kind"], "question");
    assert_eq!(
        cards[1]["outcome"]["question"]["work"]["prompt"],
        "Which strategy?"
    );
    assert_eq!(cards[1]["endedAtMs"], 29_000);
    assert_eq!(cards[2]["outcome"]["kind"], "blocked");
    assert_eq!(cards[2]["endedAtMs"], 35_000);
}

#[tokio::test]
async fn acp_server_error_is_logged_with_timestamp() {
    use tower::ServiceExt as _;
    let app = Router::new()
        .route(
            "/v1/acp/inbox",
            axum::routing::get(|| async {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error": "fixture-1622-store-error"})),
                )
            }),
        )
        .layer(axum::middleware::from_fn(super::log_acp_error));
    let response = app
        .oneshot(Request::get("/v1/acp/inbox").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let lines = crate::diagnostics::TEST_LINES.lock().unwrap();
    let line = lines
        .iter()
        .find(|line| line.contains("fixture-1622-store-error"))
        .unwrap();
    assert!(line.contains("+00:00"));
    assert!(line.contains("route=/v1/acp/inbox status=503"));
    assert_eq!(line.lines().count(), 1);
}

#[tokio::test]
async fn a_retained_checkout_backs_off_to_a_long_cap_for_done_and_cancelled_tasks() {
    for phase in ["done", "cancelled"] {
        let (_home, mut service) = registry_fixture(GitHub::new("fixture").expect("client"));
        service.set_fixture_acp_provider(Some("fixture-acp"));
        let (done, _) = fixture_at_done(&service).await;
        let id = done.task.identity().id.clone();
        service
            .command(
                &id,
                &Authority::Operator {
                    actor: "fixture".into(),
                },
                Command::Release,
            )
            .await
            .expect("release hold");
        let current = service.task(&id).await.unwrap();
        let mut stored = serde_json::to_value(&current.task).unwrap();
        stored["phase"] = json!(phase);
        let row = service
            .save(
                &current,
                serde_json::from_value(stored).unwrap(),
                &event("fixture_finished"),
            )
            .await
            .unwrap();
        let (native, _archive) = empty_archive_fixture(1).await;
        service.host = native.with_quiet_fixture_processes();
        service.host.use_held_shell();
        let (forge, readable, _, _, server) = serve_merged_forge(&service.fixture().start).await;
        readable.store(true, Ordering::Relaxed);
        service.forge = forge;
        let draft = {
            let work = service.worktrees();
            let project = service.fixture();
            let identity = row.task.identity();
            let checkout = work
                .checkout(&project.checkout, &identity.repository, &identity.id)
                .unwrap();
            checkout.allocate(&project.start).unwrap();
            checkout.path().join("unfinished-draft")
        };
        hold_archived_workspace(&service, &row.task, draft.parent().unwrap());
        std::fs::write(&draft, "keep this draft").unwrap();
        let mut cause = String::new();

        for expected in [3, 6, 12, 24, 48, 96, 192, 384, 600, 600] {
            let result = service.archive_done(&row).await;
            assert!(
                matches!(result, Err(ServiceError::CheckoutRetained(_))),
                "{phase}: {result:?}"
            );
            assert_delay(settle_pass(&service, &id, &result).await, expected);
            cause = result.unwrap_err().to_string();
        }
        let service = Arc::new(service);
        let api = settings_api(&service);
        let view = json_body(get_as(&api, &format!("/v1/tasks/{id}"), &BOARD_KEY).await).await;
        assert_eq!(view["phase"], phase);
        assert_eq!(view["wait"], "stopping", "{phase}");
        assert_eq!(view["waitDetail"], cause.as_str(), "{phase}");
        assert!(cause.contains("Inspect its local changes"), "{cause}");
        {
            // The periodic scan finds the row and must keep the later deadline.
            let mut state = service.state.lock().await;
            let due = state.schedule.due(&id).unwrap();
            let crate::State {
                schedule,
                store,
                capacity_waiters,
                ..
            } = &mut *state;
            schedule
                .seed(store, tokio::time::Instant::now(), true, capacity_waiters)
                .unwrap();
            assert_eq!(schedule.due(&id), Some(due), "{phase}");
        }
        if phase == "done" {
            // A retirement which succeeds forgets the earlier failures.
            std::fs::remove_file(&draft).unwrap();
            let result = service.archive_done(&row).await;
            assert_eq!(result.as_ref().unwrap(), &Action::Nothing);
            service
                .schedule_result(&row, &result, crate::schedule::Priority::Closeout)
                .await
                .unwrap();
            let mut state = service.state.lock().await;
            assert_eq!(state.schedule.back_off(&id), crate::schedule::RETRY);
        }
        server.abort();
    }
}

#[tokio::test]
async fn an_unmapped_error_shows_its_cause_backs_off_and_accepts_recheck() {
    let (_home, mut service) = registry_fixture(GitHub::new("fixture").expect("client"));
    service.set_fixture_acp_provider(Some("fixture-acp"));
    let project = service.fixture().clone();
    let (reserved, _, _) =
        crate::tests::reservation("wrong-branch", nucleus_core::Entry::Brief, &project.start);
    let task = Task::new(reserved.identity().clone(), "Fixture".into(), None);
    {
        let mut state = service.state.lock().await;
        state.settings.profiles = Some(Arc::new(nucleus_store::Profiles::default()));
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
    }
    let id = "wrong-branch";
    crate::tests::git(&project.checkout, &["switch", "-c", "other"]);
    let route = service.project_for(task.identity()).await.unwrap();
    let operator = Authority::Operator {
        actor: "fixture".into(),
    };

    for expected in [3, 6, 12] {
        let error = service
            .verify_route(task.identity(), &route)
            .await
            .expect_err("the registered checkout left its base branch");
        let delay = settle_pass(&service, id, &Err(error)).await;
        assert_delay(delay, expected);
    }
    let service = Arc::new(service);
    let api = settings_api(&service);
    let view = json_body(get_as(&api, &format!("/v1/tasks/{id}"), &BOARD_KEY).await).await;
    assert_eq!(view["wait"], "engine_blocked");
    assert_eq!(view["stateLabel"], "Queued · blocked");
    let cause = view["waitDetail"].as_str().unwrap();
    assert!(
        cause.contains("base branch") && cause.ends_with("Use Recheck after the repair."),
        "{cause}"
    );

    let version = service.task(id).await.unwrap().version;
    service
        .recheck(id, version, &operator, None, &ControllerScope::default())
        .await
        .unwrap();
    assert!(service.state.lock().await.schedule.due(id).unwrap() <= tokio::time::Instant::now());
    let error = service
        .verify_route(task.identity(), &route)
        .await
        .unwrap_err();
    assert_delay(settle_pass(&service, id, &Err(error)).await, 3);

    // A cancelled task keeps the cause of a closeout which fails the same way.
    service
        .command(id, &operator, Command::Cancel)
        .await
        .unwrap();
    for expected in [3, 6] {
        let error = service
            .verify_route(task.identity(), &route)
            .await
            .unwrap_err();
        assert_delay(settle_pass(&service, id, &Err(error)).await, expected);
    }
    let view = json_body(get_as(&api, &format!("/v1/tasks/{id}"), &BOARD_KEY).await).await;
    assert_eq!(view["phase"], "cancelled");
    assert_eq!(view["wait"], "stopping");
    let cause = view["waitDetail"].as_str().unwrap();
    assert!(cause.contains("base branch"), "{cause}");
}

#[tokio::test]
async fn board_pair_code_pairs_device_with_issuer_authority_and_revokes() {
    let (_home, _service, api, _planner_host) = board_pair_fixture().await;
    assert_eq!(
        browser_request(&api, Method::POST, "/api/engine/pair/code", None, None)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let operator = pair_board(&api, &BOARD_KEY).await;
    let planner = pair_board(&api, &PLANNER_KEY).await;

    let code = issue_pair_code(&api, &operator).await;
    assert_eq!(code.len(), 9);
    assert_eq!(code.as_bytes()[4], b'-');
    let redeemed = redeem_code(&api, &code.replace('-', "").to_lowercase()).await;
    assert_eq!(redeemed.status(), StatusCode::NO_CONTENT);
    let set_cookie = redeemed.headers()["set-cookie"].to_str().expect("cookie");
    assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Strict"));
    let device_cookie = set_cookie.split(';').next().expect("cookie").to_owned();
    let session = json_body(
        browser_request(
            &api,
            Method::GET,
            "/api/engine/session",
            Some(&device_cookie),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(session["canEditSettings"], true);
    assert_eq!(
        redeem_code(&api, &code).await.status(),
        StatusCode::UNAUTHORIZED
    );

    let first = issue_pair_code(&api, &operator).await;
    let second = issue_pair_code(&api, &planner).await;
    assert_eq!(
        redeem_code(&api, &first).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let redeemed_planner = redeem_code(&api, &second).await;
    assert_eq!(redeemed_planner.status(), StatusCode::NO_CONTENT);
    let planner_device = redeemed_planner.headers()["set-cookie"]
        .to_str()
        .expect("planner cookie")
        .split(';')
        .next()
        .expect("cookie")
        .to_owned();
    let planner_session = json_body(
        browser_request(
            &api,
            Method::GET,
            "/api/engine/session",
            Some(&planner_device),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(planner_session["canEditSettings"], false);

    assert_eq!(
        post_as(&api, "/v1/board/revoke", &BOARD_KEY, &json!({}))
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        browser_request(
            &api,
            Method::GET,
            "/api/engine/session",
            Some(&device_cookie),
            None,
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn board_pair_code_burns_after_five_wrong_attempts_and_expires() {
    let (_home, service, api, _planner_host) = board_pair_fixture().await;
    let operator = pair_board(&api, &BOARD_KEY).await;

    let burned = issue_pair_code(&api, &operator).await;
    for _ in 0..5 {
        assert_eq!(
            redeem_code(&api, "AAAA-AAAA").await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        redeem_code(&api, &burned).await.status(),
        StatusCode::UNAUTHORIZED
    );

    let expiring = issue_pair_code(&api, &operator).await;
    service
        .board
        .get()
        .expect("board")
        .expire_pair_code_for_test();
    assert_eq!(
        redeem_code(&api, &expiring).await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn board_pair_code_redeem_enforces_host_origin_and_board_header() {
    let (_home, _service, api, _planner_host) = board_pair_fixture().await;
    let operator = pair_board(&api, &BOARD_KEY).await;
    let code = issue_pair_code(&api, &operator).await;
    let payload = json!({"code": code}).to_string();

    let bad_host = api
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/engine/pair/redeem")
                .header(HOST, "evil.example:9")
                .header(ORIGIN, "http://evil.example:9")
                .header("x-nucleus-board", "1")
                .header("content-type", "application/json")
                .body(Body::from(payload.clone()))
                .expect("bad host request"),
        )
        .await
        .expect("bad host response");
    assert_eq!(bad_host.status(), StatusCode::FORBIDDEN);

    let bad_origin = api
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/engine/pair/redeem")
                .header(HOST, LOCAL_HOST)
                .header(ORIGIN, "http://127.0.0.1:10")
                .header("x-nucleus-board", "1")
                .header("content-type", "application/json")
                .body(Body::from(payload.clone()))
                .expect("bad origin request"),
        )
        .await
        .expect("bad origin response");
    assert_eq!(bad_origin.status(), StatusCode::FORBIDDEN);

    let missing_header = api
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/engine/pair/redeem")
                .header(HOST, LOCAL_HOST)
                .header(ORIGIN, "http://127.0.0.1:9")
                .header("content-type", "application/json")
                .body(Body::from(payload))
                .expect("missing header request"),
        )
        .await
        .expect("missing header response");
    assert_eq!(missing_header.status(), StatusCode::UNAUTHORIZED);
}
