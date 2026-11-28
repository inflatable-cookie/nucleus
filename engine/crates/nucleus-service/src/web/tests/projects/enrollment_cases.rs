use super::*;

#[tokio::test]
async fn first_contact_enrolls_two_routes_and_allows_cross_project_task_commands() {
    let registry = registry().await;
    let api = &registry.api;
    let created = registry
        .inline_command("alpha-planner", submit(api, "alpha-planner", "first", None))
        .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    registry.enroll("beta-planner").await;
    let alpha = registry.service.task("first").await.unwrap().task;
    let beta = registry.task("beta-planner", "second").await;
    assert_eq!(alpha.identity().repository, ALPHA_REPO);
    assert_eq!(alpha.identity().base, "main");
    assert_eq!(beta.identity().repository, BETA_REPO);
    assert_eq!(beta.identity().base, "trunk");
    let created = caller_request(
        api,
        Method::POST,
        "/v1/planning/second/tasks",
        "alpha-planner",
        json!({"id": "cross-project", "brief": BRIEF}),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created = json_body(created).await;
    assert_eq!(created["identity"]["repository"], BETA_REPO);
    assert_eq!(created["identity"]["origin_thread"], "alpha-planner");
    let reference = created["reference"].as_str().unwrap().replace('#', "%23");
    let path = format!("/v1/tasks/{reference}");
    let next = caller_request(
        api,
        Method::GET,
        &format!("{path}/next"),
        "alpha-planner",
        Value::Null,
    )
    .await;
    assert_eq!(next.status(), StatusCode::OK);
    let amended = format!("{BRIEF} amended");
    for command in [json!({"amend": amended}), json!({"move": "working"})] {
        let response = caller_request(
            api,
            Method::POST,
            &format!("{path}/commands"),
            "alpha-planner",
            command,
        )
        .await;
        let status = response.status();
        assert_eq!(status, StatusCode::OK, "{}", json_body(response).await);
    }
    let updated = registry.service.task("cross-project").await.unwrap();
    assert_eq!(updated.task.brief().text, amended);
    assert_eq!(updated.task.phase(), Phase::Working);
    let visible = json_body(
        caller_request(api, Method::GET, "/v1/tasks", "alpha-planner", Value::Null).await,
    )
    .await;
    assert_eq!(visible.as_array().expect("both projects' tasks").len(), 3);
    let mint = json_body(
        caller_request(
            api,
            Method::POST,
            "/v1/tasks/first/acp?readOnly=true",
            "alpha-planner",
            json!({}),
        )
        .await,
    )
    .await;
    let file = Path::new(mint["bindingPath"].as_str().expect("binding path"));
    let binding: nucleus_core::acp::Binding =
        serde_json::from_slice(&std::fs::read(file).expect("binding")).expect("ACP session");
    assert_eq!(
        get_as(api, "/v1/tasks/first", &binding.credential)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        get_as(api, "/v1/tasks/second", &binding.credential)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        registry.reads.load(Ordering::Relaxed),
        2,
        "one exact scheduler read per first contact"
    );
}

#[tokio::test]
async fn scratch_thread_dispatches_to_two_projects_and_receives_their_completion_notices() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("beta-planner").await;
    let admit = |project, id| {
        caller_request(
            &registry.api,
            Method::POST,
            project,
            SCRATCH_AGENT,
            json!({"id": id, "brief": BRIEF}),
        )
    };
    let ready = registry
        .inline_command(
            SCRATCH_AGENT,
            admit("/v1/planning/nucleus-fixture/tasks", "scratch-alpha"),
        )
        .await;
    assert_eq!(ready.status(), StatusCode::CREATED);
    assert_eq!(
        admit("/v1/planning/second/tasks", "scratch-beta")
            .await
            .status(),
        StatusCode::CREATED
    );
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

    // Origin delivery survives loss of the process-local controller proof.
    let registry = registry.reopen();
    for (id, repo) in [("scratch-alpha", ALPHA_REPO), ("scratch-beta", BETA_REPO)] {
        settle_phase(&registry.service, id, "cancelled", None).await;
        let row = registry.service.task(id).await.unwrap();
        assert_eq!(row.task.identity().repository, repo);
        assert_eq!(
            row.task.identity().origin_thread.as_deref(),
            Some(SCRATCH_AGENT)
        );
        registry.service.notify_completion(&row).await.unwrap();
        registry.service.notify_completion(&row).await.unwrap();
    }
    let notices = registry.notices.lock().unwrap();
    assert_eq!(notices.sends.len(), 2);
    for send in &notices.sends {
        assert_eq!(send["threadId"], SCRATCH_AGENT);
        assert_eq!(send["dispatchMode"]["type"], "queue_after_active");
        assert!(send["text"].as_str().unwrap().contains("was cancelled"));
    }
}

#[tokio::test]
async fn scratch_thread_must_name_an_active_target_and_cannot_claim_or_edit_settings() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("beta-planner").await;
    claim(&registry, "alpha-planner").await;
    registry.enroll(SCRATCH_AGENT).await;

    for (path, repository, status, error) in [
        (
            "/v1/planning-current/tasks",
            None,
            StatusCode::BAD_REQUEST,
            "name a project",
        ),
        (
            "/v1/planning-current/tasks?project=example%2Funknown",
            None,
            StatusCode::NOT_FOUND,
            "no project named example/unknown",
        ),
        (
            "/v1/planning/second/tasks",
            Some("example/unknown"),
            StatusCode::NOT_FOUND,
            "no project named example/unknown",
        ),
    ] {
        let response = caller_request(
            &registry.api,
            Method::POST,
            path,
            SCRATCH_AGENT,
            json!({"brief": BRIEF, "repository": repository}),
        )
        .await;
        assert_eq!(response.status(), status);
        assert!(
            json_body(response).await["error"]
                .as_str()
                .unwrap()
                .contains(error)
        );
    }
    let claim_refused = caller_request(
        &registry.api,
        Method::POST,
        "/v1/planning/claim",
        SCRATCH_AGENT,
        Value::Null,
    )
    .await;
    assert_eq!(claim_refused.status(), StatusCode::FORBIDDEN);
    let settings_refused = caller_request(
        &registry.api,
        Method::PUT,
        PROJECTS,
        SCRATCH_AGENT,
        json!({"revision":"", "value":{}}),
    )
    .await;
    assert_eq!(settings_refused.status(), StatusCode::FORBIDDEN);

    let settings = &registry.service.settings;
    let current = settings.read::<nucleus_store::Projects>().unwrap();
    let (alpha, beta) = planner_projects(&registry).await;
    assert_eq!(
        current.value.projects[&alpha]
            .planner_claim
            .as_ref()
            .unwrap()
            .thread,
        "alpha-planner"
    );
    assert!(current.value.projects[&beta].planner_claim.is_none());
    let (updated, _) = settings
        .edit(
            &current.revision,
            |projects: &mut nucleus_store::Projects| {
                projects.projects.get_mut(&beta).unwrap().archived = true;
                Ok(())
            },
        )
        .unwrap();
    registry.service.state.lock().await.settings.projects = Some(updated.value);
    let archived = caller_request(
        &registry.api,
        Method::POST,
        "/v1/planning/second/tasks",
        SCRATCH_AGENT,
        json!({"brief": BRIEF}),
    )
    .await;
    assert_eq!(archived.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(archived).await["error"],
        ServiceError::TellArchivedProject(beta).to_string()
    );
}

#[tokio::test]
async fn cold_task_reads_request_one_check_then_return_the_saved_tasks() {
    let registry = registry().await;
    let actor = "alpha-planner";
    registry.enroll(actor).await;
    registry.task(actor, "first").await;
    let registry = registry.reopen();
    let reads = registry.reads.load(Ordering::Relaxed);
    let (tasks, detail) = registry
        .inline_command(actor, async {
            tokio::join!(
                caller_request(&registry.api, Method::GET, "/v1/tasks", actor, Value::Null),
                caller_request(
                    &registry.api,
                    Method::GET,
                    "/v1/tasks/first",
                    actor,
                    Value::Null
                )
            )
        })
        .await;
    assert_eq!(tasks.status(), StatusCode::OK);
    assert_eq!(detail.status(), StatusCode::OK);
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads + 1);
    assert_eq!(json_body(tasks).await[0]["identity"]["id"], "first");
}

#[tokio::test]
async fn planning_uses_the_verified_callers_project_for_reads_and_writes() {
    const PLAN: &str = "/v1/planning-current/plan";
    const ITEMS: &str = "/v1/planning-current/items";

    let registry = registry().await;
    let api = &registry.api;
    let actor = "alpha-planner";
    let item = json!({"kind":"papercut","title":"Own project","body":"A synthetic item."});
    let started = tokio::time::Instant::now();
    let response = caller_request(api, Method::GET, PLAN, actor, Value::Null).await;
    assert!(started.elapsed() >= std::time::Duration::from_secs(3));
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        json_body(response).await["error"],
        "T3 planner and repository verification exceeded the request deadline. Retry the request."
    );
    assert_eq!(registry.reads.load(Ordering::Relaxed), 0);
    assert_eq!(
        registry.service.take_enrollment().await.as_deref(),
        Some(actor)
    );
    assert!(registry.service.take_enrollment().await.is_none());
    registry.service.complete_enrollment(actor).await;
    assert_eq!(registry.reads.load(Ordering::Relaxed), 1);

    let read = |path| caller_request(api, Method::GET, path, actor, Value::Null);
    assert_eq!(json_body(read(PLAN).await).await["version"], 0);
    assert_eq!(json_body(read(ITEMS).await).await, json!([]));
    let added = caller_request(api, Method::POST, ITEMS, actor, item).await;
    assert_eq!(added.status(), StatusCode::CREATED);
    let added = json_body(added).await;
    assert_eq!(added["author"], actor);
    for path in [
        ITEMS,
        "/v1/planning/eXaCt%20T3%20aLpHa/items",
        "/v1/planning-current/items?project=EXACT+t3+ALPHA",
        "/v1/planning/nucleus-fixture/items",
        "/v1/planning-current/items?project=inflatable-cookie%2Fnucleus-fixture",
    ] {
        assert_eq!(json_body(read(path).await).await, json!([added]));
    }
    let id = added["id"].as_str().expect("item ID");
    let history = format!("/v1/planning-current/history/item/{id}");
    assert_eq!(json_body(read(&history).await).await[0]["actor"], actor);

    let task = caller_request(
        api,
        Method::POST,
        "/v1/planning-current/tasks?project=inflatable-cookie%2Fnucleus-fixture",
        actor,
        json!({"id":"by-name","brief":"---\nqueue:\n  complexity: low\n---\nUse the verified repository."}),
    )
    .await;
    assert_eq!(task.status(), StatusCode::CREATED);
    assert_eq!(json_body(task).await["identity"]["repository"], ALPHA_REPO);

    assert_eq!(
        get_as(api, ITEMS, &BOARD_KEY).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(registry.reads.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn cross_project_planning_writes_use_the_named_projects_checkout() {
    let registry = registry().await;
    let api = &registry.api;
    let actor = "alpha-planner";
    registry.enroll(actor).await;
    let read = |path| caller_request(api, Method::GET, path, actor, Value::Null);
    registry.enroll("beta-planner").await;
    let other = "/v1/planning-current/items?project=second";
    assert_eq!(json_body(read(other).await).await, json!([]));
    let written = caller_request(
        api,
        Method::POST,
        other,
        actor,
        json!({
            "kind":"papercut", "title":"Beta item", "body":"Written from Alpha."
        }),
    )
    .await;
    assert_eq!(written.status(), StatusCode::CREATED);
    let written = json_body(written).await;
    assert_eq!(written["author"], actor);
    assert_eq!(
        json_body(get_as(api, other, &BOARD_KEY).await).await,
        json!([written])
    );
    assert_eq!(
        json_body(read("/v1/planning-current/items").await).await,
        json!([])
    );

    // Only Beta's checkout declares affected tests. An Alpha caller's promotion
    // still reads that declaration from Beta's default branch.
    let beta_checkout = {
        let state = registry.service.state.lock().await;
        state
            .settings
            .project_for_origin(BETA_REPO)
            .unwrap()
            .2
            .path
            .clone()
    };
    std::fs::write(
        beta_checkout.join("effigy.toml"),
        "[tasks]\n\"test:affected\" = \"true\"\n",
    )
    .unwrap();
    git(&beta_checkout, &["add", "effigy.toml"]);
    git(
        &beta_checkout,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "Declare affected tests",
        ],
    );
    let promotion = caller_request(
        api,
        Method::POST,
        &format!(
            "/v1/planning/second/items/{}/promote",
            written["id"].as_str().unwrap()
        ),
        actor,
        json!({"complexity":"low"}),
    )
    .await;
    assert_eq!(promotion.status(), StatusCode::CREATED);
    let id = json_body(promotion).await["identity"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let next = json_body(read(&format!("/v1/tasks/{id}/next")).await).await;
    assert_eq!(next["allowance"]["limitMs"], 120 * 60 * 1000, "{next}");
    assert_eq!(registry.reads.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn planning_records_need_a_live_binding_but_not_a_cached_checkout() {
    let registry = registry().await;
    let actor = "alpha-planner";
    registry.enroll(actor).await;
    registry.service.host.fixture_project_shell(
        &json!({"threads":[],"projects":[{"id":"alpha-native","workspaceRoot":registry.home.path()}]}),
        "fixture-acp",
    );
    let api = &registry.api;
    let plan = "/v1/planning-current/plan";
    let written = caller_request(
        api,
        Method::PUT,
        plan,
        actor,
        json!({"version":0,"lanes":[]}),
    )
    .await;
    assert_eq!(written.status(), StatusCode::OK);
    let read = caller_request(api, Method::GET, plan, actor, Value::Null).await;
    assert_eq!(json_body(read).await["version"], 1);
    let task = submit(api, actor, "moved-checkout", None).await;
    assert_eq!(task.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        json_body(task).await["error"],
        "The registered T3 checkout changed or is unavailable. Retry shortly."
    );
    assert_eq!(registry.reads.load(Ordering::Relaxed), 1);

    // A new thread belonging to the registered native project still needs
    // the checkout proof when that project's root moves to a non-Git folder.
    let new_caller = "next-planner";
    let refused = registry
        .inline_command(new_caller, submit(api, new_caller, "new-planner", None))
        .await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        json_body(refused).await["error"],
        "The checkout registered in T3 is not a Git worktree."
    );
}

#[tokio::test]
async fn colliding_repository_names_require_the_owner_for_all_controllers() {
    let registry = registry_with_options("example/nucleus-fixture", false).await;
    registry.enroll("alpha-planner").await;
    registry.enroll("beta-planner").await;
    let api = &registry.api;
    let read = |path| caller_request(api, Method::GET, path, "alpha-planner", Value::Null);
    {
        // A project name has precedence. Give both projects distinct display
        // names so this selector exercises the two repository basenames.
        let mut state = registry.service.state.lock().await;
        let beta = state
            .live_planner_project("beta-planner")
            .unwrap()
            .to_owned();
        state
            .settings
            .projects
            .as_mut()
            .unwrap()
            .projects
            .get_mut(&beta)
            .unwrap()
            .name = "Beta project".into();
    }
    let collision = get_as(api, "/v1/planning/nucleus-fixture/items", &BOARD_KEY).await;
    assert_eq!(collision.status(), StatusCode::BAD_REQUEST);
    assert!(
        json_body(collision).await["error"]
            .as_str()
            .unwrap()
            .contains("ambiguous")
    );
    let foreign = read("/v1/planning-current/items?project=example%2Fnucleus-fixture").await;
    assert_eq!(foreign.status(), StatusCode::OK);
}

#[tokio::test]
async fn public_task_references_default_to_the_callers_project() {
    let registry = registry_with_options("example/nucleus-fixture", false).await;
    let api = &registry.api;
    let alpha = "alpha-planner";
    let beta = "beta-planner";
    registry.enroll(alpha).await;
    registry.enroll(beta).await;
    registry.task(alpha, "first").await;
    registry.task(beta, "second").await;

    let read = |path| caller_request(api, Method::GET, path, alpha, Value::Null);
    let detail = json_body(read("/v1/tasks/first").await).await;
    assert_eq!(detail["identity"]["id"], "first");
    for path in [
        "/v1/tasks/inflatable-cookie%2Fnucleus-fixture%23001",
        "/v1/tasks/%231",
    ] {
        assert_eq!(json_body(read(path).await).await, detail);
    }
    for (by_ref, by_id) in [
        ("/v1/tasks/%231/next", "/v1/tasks/first/next"),
        ("/v1/tasks/%231/history", "/v1/tasks/first/history"),
    ] {
        assert_eq!(
            json_body(read(by_ref).await).await,
            json_body(read(by_id).await).await
        );
    }
    let missing = read("/v1/tasks/nucleus-fixture%2399").await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        json_body(missing).await["error"],
        "task reference was not found"
    );

    let unqualified = "/v1/tasks/nucleus-fixture%231";
    for ambiguous in [
        read(unqualified).await,
        get_as(api, unqualified, &BOARD_KEY).await,
    ] {
        assert_eq!(ambiguous.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            json_body(ambiguous).await["error"],
            ServiceError::TaskReferenceAmbiguous.to_string()
        );
    }
    let qualified = "/v1/tasks/inflatable-cookie%2Fnucleus-fixture%231";
    assert_eq!(
        json_body(get_as(api, qualified, &BOARD_KEY).await).await,
        detail
    );
    let beta_detail = json_body(read("/v1/tasks/example%2Fnucleus-fixture%231").await).await;
    assert_eq!(beta_detail["identity"]["id"], "second");
    assert_eq!(
        caller_request(
            api,
            Method::POST,
            "/v1/tasks/%231/commands",
            alpha,
            json!({"hold": "Settle the fixture first."}),
        )
        .await
        .status(),
        StatusCode::OK
    );
    let first = registry.service.task("first").await.expect("first task");
    let second = registry.service.task("second").await.expect("second task");
    assert!(first.task.hold().is_some());
    assert!(second.task.hold().is_none());

    {
        let mut state = registry.service.state.lock().await;
        let alpha = state
            .live_planner_project(alpha)
            .expect("Alpha project")
            .to_owned();
        let beta = state
            .live_planner_project(beta)
            .expect("Beta project")
            .to_owned();
        let projects = &mut state.settings.projects.as_mut().expect("projects").projects;
        let beta = projects.remove(&beta).expect("Beta settings");
        projects
            .get_mut(&alpha)
            .expect("Alpha settings")
            .repositories
            .extend(beta.repositories);
    }
    let response = read("/v1/tasks/%231").await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(
        json_body(response).await["error"]
            .as_str()
            .expect("error")
            .contains("exactly one repository")
    );
    assert_eq!(registry.reads.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn imported_container_scopes_commands_and_slots_across_exact_native_routes() {
    let registry = registry_with_options(BETA_REPO, true).await;
    registry.enroll("alpha-planner").await;
    let alpha = registry.task("alpha-planner", "first").await;
    let projects = json_body(get_as(&registry.api, PROJECTS, &BOARD_KEY).await).await;
    let product = &projects["settings"]["value"]["projects"]["product"];
    assert_eq!(product["name"], "Imported product");
    assert!(product.get("slots").is_none());
    assert_eq!(product["repositories"][0]["hostProject"], "alpha-native");
    assert!(product["repositories"][1]["hostProject"].is_null());
    let refused = submit(&registry.api, "alpha-planner", "unbound", Some(BETA_REPO)).await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        json_body(refused).await["error"],
        "repository example/second has no verified T3 checkout in project Imported product; open a T3 thread in its checkout and run one planning command"
    );
    let missing = caller_request(&registry.api, Method::POST, "/v1/planning/missing/tasks", "alpha-planner",
        json!({"id": "missing", "repository": BETA_REPO, "brief": "---\nqueue:\n  complexity: low\n---\nTest"})).await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        json_body(missing).await["error"],
        "no project named missing; repository example/second belongs to project Imported product"
    );
    registry.enroll("beta-planner").await;
    let beta = registry.task("beta-planner", "second").await;
    assert_eq!(beta.identity().base, "trunk");
    let projects = json_body(get_as(&registry.api, PROJECTS, &BOARD_KEY).await).await;
    assert_eq!(
        projects["verifiedPlanners"]["product"],
        json!(["beta-planner", "alpha-planner"])
    );
    assert_eq!(
        submit(
            &registry.api,
            "alpha-planner",
            "explicit-member",
            Some(BETA_REPO)
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    assert_workspace_limit(&registry, [&alpha, &beta]).await;
    let route = registry
        .service
        .project_for(alpha.identity())
        .await
        .expect("route");
    let head = registry
        .service
        .verify_route(alpha.identity(), &route)
        .await
        .expect("exact head");
    let mut running = alpha;
    occupy_slot(&mut running, &head);
    let first = registry.service.task("first").await.expect("first");
    registry
        .service
        .save(&first, running, &event("fixture"))
        .await
        .expect("occupied slot");
    assert!(
        !registry
            .service
            .launch_capacity(beta.identity(), false)
            .await
            .expect("shared project limit")
    );
    assert_eq!(
        caller_request(
            &registry.api,
            Method::POST,
            "/v1/tasks/second/commands",
            "alpha-planner",
            json!("cancel")
        )
        .await
        .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn paired_board_gives_verified_planners_access_to_both_projects() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("beta-planner").await;
    let project_id = |actor: &str| {
        let state = registry.service.state.try_lock().unwrap();
        state.live_planner_project(actor).unwrap().to_owned()
    };
    let alpha = project_id("alpha-planner");
    let beta = project_id("beta-planner");
    let api = registry_board_api(&registry);
    let operator = pair_board(&api, &BOARD_KEY).await;
    let link = json_body(
        caller_request(
            &api,
            Method::POST,
            "/v1/board/link",
            "alpha-planner",
            json!({}),
        )
        .await,
    )
    .await;
    let planner = pair_board_link(&api, link["url"].as_str().unwrap()).await;
    let read = |path, cookie| browser_request(&api, Method::GET, path, Some(cookie), None);
    let operator_view = json_body(read("/api/engine/session", &operator).await).await;
    let planner_view = json_body(read("/api/engine/session", &planner).await).await;
    assert_eq!(operator_view["canEditSettings"], true);
    assert_eq!(operator_view["planningProjects"], Value::Null);
    assert_eq!(planner_view["canEditSettings"], false);
    assert_eq!(planner_view["planningProjects"], Value::Null);
    assert_ne!(operator_view["id"], planner_view["id"]);
    assert_eq!(
        planner_view,
        json_body(read("/api/engine/session", &planner).await).await
    );
    for collection in ["plan", "items", "decisions"] {
        for project in [&alpha, &beta] {
            let path = format!("/api/engine/planning/{project}/{collection}");
            assert_eq!(
                browser_request(&api, Method::GET, &path, Some(&planner), None)
                    .await
                    .status(),
                StatusCode::OK,
            );
        }
    }
    for path in [
        "/api/engine/settings/profiles",
        "/api/engine/profiles/usage",
    ] {
        assert_eq!(
            json_body(browser_request(&api, Method::GET, path, Some(&operator), None).await).await,
            json_body(browser_request(&api, Method::GET, path, Some(&planner), None).await).await,
        );
    }
    assert_eq!(registry.reads.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn first_contact_uses_stable_identity_even_while_the_caller_is_active() {
    let registry = registry().await;
    for (actor, closes) in [("active-planner", false), ("closed-during-proof", true)] {
        registry.start_contact(actor).await;
        // Hold the commit until a shell update has arrived during the exact read.
        let write = registry.service.project_writes.write().await;
        let service = Arc::clone(&registry.service);
        let check = tokio::spawn(async move { service.complete_enrollment(actor).await });
        tokio::time::timeout(Duration::from_secs(5), registry.read_started.notified())
            .await
            .expect("exact caller proof started");
        if closes {
            let hint = nucleus_hosts::ThreadHint::fixture(&json!({
                "kind": "thread.removed", "threadId": actor,
            }))
            .expect("closure");
            registry.service.wake_from_host(hint).await;
        }
        let hint = nucleus_hosts::ThreadHint::fixture(&json!({
            "kind": "thread.updated",
            "thread": {
                "id": actor, "projectId": "alpha-native",
                "status": "running", "activeRunId": "still-running",
            },
        }))
        .expect("ordinary activity");
        registry.service.wake_from_host(hint).await;
        drop(write);
        check.await.expect("finished proof");

        let response = submit(&registry.api, actor, actor, None).await;
        if closes {
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert_eq!(
                json_body(response).await["error"],
                "The T3 planner thread is archived or gone."
            );
            assert!(registry.service.task(actor).await.is_err());
        } else {
            assert_eq!(response.status(), StatusCode::CREATED);
        }
    }
    assert_eq!(registry.reads.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn first_contact_refuses_child_closed_task_session_and_missing_checkout() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    for (actor, reason) in [
        ("child", "Submit from a top-level T3 planner thread."),
        ("closed", "The T3 planner thread is archived or gone."),
        ("task-session", "Submit from a top-level T3 planner thread."),
        (
            "missing-root",
            "The checkout registered in T3 is missing or is not a canonical directory.",
        ),
    ] {
        registry.enroll(actor).await;
        let response = submit(&registry.api, actor, actor, None).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(json_body(response).await["error"], reason);
    }
    let settings = json_body(get_as(&registry.api, PROJECTS, &BOARD_KEY).await).await;
    assert_eq!(
        settings["settings"]["value"]["projects"]
            .as_object()
            .expect("projects")
            .len(),
        1
    );
    assert_eq!(registry.reads.load(Ordering::Relaxed), 5);
}

#[tokio::test]
async fn promotion_uses_the_selected_member_and_returns_its_public_reference() {
    let registry = registry_with_options(BETA_REPO, true).await;
    registry.enroll("alpha-planner").await;
    let api = registry_board_api(&registry);
    let operator = pair_board(&api, &BOARD_KEY).await;
    let items = "/api/engine/planning/product/items";
    let add = json!({"kind":"lead", "title":"Fixture idea", "lanes":["delivery","shared"],
        "body":"---\nqueue:\n  complexity: low\n  lanes: [shared, release]\n  laneDocuments: [guide]\n---\nUse the selected repository."});
    let added = browser_request(&api, Method::POST, items, Some(&operator), Some(&add)).await;
    assert_eq!(added.status(), StatusCode::CREATED);
    let item = json_body(added).await;
    let id = item["id"].as_str().unwrap();
    let path = format!("{items}/{id}/promote");
    let selected = json!({"repository": BETA_REPO});
    let rejected =
        browser_request(&api, Method::POST, &path, Some(&operator), Some(&selected)).await;
    assert_eq!(
        rejected.status(),
        StatusCode::BAD_REQUEST,
        "an unbound choice cannot fall back to Alpha"
    );

    registry.enroll("beta-planner").await;
    let promote = || browser_request(&api, Method::POST, &path, Some(&operator), Some(&selected));
    let created = promote().await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created = json_body(created).await;
    assert_eq!(created["reference"], "second#1");
    assert_eq!(created["identity"]["repository"], BETA_REPO);
    assert_eq!(created["identity"]["base"], "trunk");
    let cards = read_paired_task(&api, "/api/engine/tasks", &operator).await;
    let promoted = cards
        .as_array()
        .unwrap()
        .iter()
        .find(|card| card["identity"]["id"] == created["identity"]["id"])
        .unwrap();
    assert_eq!(promoted["lanes"], json!(["delivery", "release", "shared"]));

    let retried = promote().await;
    assert_eq!(retried.status(), StatusCode::OK);
    let retried = json_body(retried).await;
    assert_eq!(retried["identity"]["id"], created["identity"]["id"]);
    assert_eq!(retried["reference"], "second#1");

    let task_id = created["identity"]["id"].as_str().unwrap();
    registry
        .service
        .command(
            task_id,
            &Authority::Operator {
                actor: "fixture".into(),
            },
            Command::Cancel,
        )
        .await
        .unwrap();
    for _ in 0..2 {
        let cards = read_paired_task(&api, "/api/engine/tasks", &operator).await;
        let row = cards
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["identity"]["id"] == task_id)
            .unwrap();
        assert_eq!(row["phase"], "cancelled");
        assert_eq!(row["lanes"], json!(["delivery", "release", "shared"]));
    }

    let (_, promoted) = promote_fixture_papercut(&api, BETA_REPO).await;
    assert_eq!(promoted["identity"]["repository"], BETA_REPO);
    assert_eq!(promoted["reference"], "second#2");
    assert_eq!(promoted["title"], "Fixture issue");
    let detail = read_paired_task(
        &api,
        &format!(
            "/api/engine/tasks/{}",
            promoted["identity"]["id"].as_str().unwrap()
        ),
        &operator,
    )
    .await;
    assert_eq!(detail["title"], "Fixture issue");
    assert!(
        detail["brief"]["text"]
            .as_str()
            .unwrap()
            .ends_with("Use the selected repository.")
    );
}

#[tokio::test]
async fn finished_card_reads_the_updated_source_title() {
    let registry = registry_with_options(BETA_REPO, true).await;
    registry.enroll("alpha-planner").await;
    let api = registry_board_api(&registry);
    let operator = pair_board(&api, &BOARD_KEY).await;
    let (id, promoted) = promote_fixture_papercut(&api, ALPHA_REPO).await;
    let task = promoted["identity"]["id"].as_str().unwrap();
    registry
        .service
        .command(
            task,
            &Authority::Operator {
                actor: "fixture".into(),
            },
            Command::Cancel,
        )
        .await
        .unwrap();
    let card = async || {
        let list = read_paired_task(&api, "/api/engine/tasks", &operator).await;
        list.as_array()
            .unwrap()
            .iter()
            .find(|row| row["identity"]["id"] == task)
            .unwrap()
            .clone()
    };
    let prior = card().await;
    assert_eq!(prior["phase"], "cancelled");
    assert_eq!(prior["title"], "Fixture issue");
    let edit = caller_request(
        &api,
        Method::PUT,
        &format!("/v1/planning/product/items/{id}"),
        "alpha-planner",
        json!({"title":"Renamed issue","body":"Use the selected repository.","lanes":[]}),
    )
    .await;
    assert_eq!(edit.status(), StatusCode::OK);
    let refreshed = card().await;
    let detail = read_paired_task(&api, &format!("/api/engine/tasks/{task}"), &operator).await;
    assert_eq!(refreshed["version"], prior["version"]);
    assert_eq!(detail["title"], "Renamed issue");
    assert_eq!(refreshed["title"], detail["title"]);
}

#[tokio::test]
async fn a_cold_promotion_keeps_imported_items_addressable_after_enrollment() {
    use nucleus_store::planning::{ItemContent, ItemKind, WriteAt};
    use sha2::{Digest, Sha256};

    let registry = registry().await;
    let project = format!("repo-{:x}", Sha256::digest(ALPHA_REPO));
    registry
        .service
        .state
        .lock()
        .await
        .store
        .add_item(
            &project,
            "historic".into(),
            ItemKind::Lead,
            ItemContent {
                title: "Historic idea".into(),
                body: "---\nqueue:\n  complexity: low\n---\nA historic brief.".into(),
                lanes: vec![],
            },
            WriteAt {
                actor: "imported",
                at_ms: 1,
            },
        )
        .expect("seed imported planning item");
    let promote = || {
        caller_request(
            &registry.api,
            Method::POST,
            "/v1/planning/items/historic/promote",
            "alpha-planner",
            json!({}),
        )
    };
    registry.enroll("alpha-planner").await;
    let created = promote().await;
    let status = created.status();
    let task = json_body(created).await;
    assert_eq!(status, StatusCode::CREATED, "{task}");
    let id = task["identity"]["id"].as_str().expect("task ID");
    let detail =
        json_body(get_as(&registry.api, &format!("/v1/tasks/{id}"), &BOARD_KEY).await).await;
    assert_eq!(
        detail["source"],
        json!({"projectId": project, "itemId": "historic"})
    );
    assert_eq!(promote().await.status(), StatusCode::OK);
    assert_eq!(registry.reads.load(Ordering::Relaxed), 1);
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one fixture trace covers a complete lifecycle"
)]
async fn verified_planners_can_answer_across_projects_but_other_credentials_cannot() {
    let registry = registry().await;
    for actor in ["alpha-planner", "beta-planner"] {
        let response = registry
            .inline_command(
                actor,
                caller_request(&registry.api, Method::GET, "/v1/tasks", actor, Value::Null),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    let head = registry.service.fixture().start;
    let forge = Observed::Known(Forge::Merged {
        pr: nucleus_core::PullRequest {
            url: PR.into(),
            head: head.clone(),
        },
        commit: head.clone(),
    });
    for id in ["same-project-answer", "cross-project-answer"] {
        let (reserved, _, _) = reservation(id, Entry::Brief, &head);
        let mut task = Task::new(reserved.identity().clone(), "Synthetic change".into(), None);
        let mut observation = Observation {
            host: Observed::Unknown,
            workspace: Observed::Unknown,
            forge: Observed::Unknown,
        };
        assert_eq!(
            task.reconcile(&observation),
            Action::Advance(Phase::Working)
        );
        observation.forge = forge.clone();
        assert!(matches!(
            task.reconcile(&observation),
            Action::Ask(Question::Accept { .. })
        ));
        assert!(
            task.bind_question_delivery(
                T3::prepare_notice(
                    "alpha-planner".into(),
                    format!("notice-{id}"),
                    "Accept merge"
                )
                .unwrap()
            )
        );
        seed_task(&registry.service, &task).await;
        let row = registry.service.task(id).await.unwrap();
        registry
            .service
            .observe_commands(&row, &forge)
            .await
            .unwrap();
    }
    let (worker, worker_key, _) = reservation("callback-worker", Entry::Brief, &head);
    let (reviewer, reviewer_key, _) = reservation("callback-reviewer", Entry::ReviewEntry, &head);
    seed_task(&registry.service, &worker).await;
    seed_task(&registry.service, &reviewer).await;
    let path = "/v1/tasks/same-project-answer/commands";
    let answer = json!({"answer":{"accept":{"head":head, "reason":"Accepted the observed merge"}}});
    for key in [worker_key.as_bytes(), reviewer_key.as_bytes(), &[0; 32]] {
        assert_eq!(
            post_as(&registry.api, path, key, &answer).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let anonymous = registry
        .api
        .clone()
        .oneshot(
            Request::post(path)
                .header(HOST, LOCAL_HOST)
                .header("content-type", "application/json")
                .body(Body::from(answer.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    let unverified = registry
        .inline_command(
            "unknown-caller",
            caller_request(
                &registry.api,
                Method::POST,
                path,
                "unknown-caller",
                answer.clone(),
            ),
        )
        .await;
    assert_eq!(unverified.status(), StatusCode::FORBIDDEN);
    for (actor, task) in [
        ("alpha-planner", "same-project-answer"),
        ("beta-planner", "cross-project-answer"),
    ] {
        let response = caller_request(
            &registry.api,
            Method::POST,
            &format!("/v1/tasks/{task}/commands"),
            actor,
            answer.clone(),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "{actor}: {}",
            json_body(response).await
        );
        let repeated = caller_request(
            &registry.api,
            Method::POST,
            &format!("/v1/tasks/{task}/commands"),
            actor,
            answer.clone(),
        )
        .await;
        assert_eq!(repeated.status(), StatusCode::CONFLICT);
    }
}

#[tokio::test]
async fn acp_planner_writer_is_fenced_after_its_thread_is_archived() {
    let registry = registry().await;
    let response = registry
        .inline_command(
            "alpha-planner",
            caller_request(
                &registry.api,
                Method::GET,
                "/v1/tasks",
                "alpha-planner",
                Value::Null,
            ),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    seed_planner_task(&registry.service, "handover", "alpha-planner").await;
    let mint = caller_request(
        &registry.api,
        Method::POST,
        "/v1/tasks/handover/acp",
        "alpha-planner",
        json!({}),
    )
    .await;
    assert_eq!(mint.status(), StatusCode::OK);
    let mint = json_body(mint).await;
    let binding: nucleus_core::acp::Binding =
        serde_json::from_slice(&std::fs::read(mint["bindingPath"].as_str().unwrap()).unwrap())
            .unwrap();
    let writer = binding.command_credential.unwrap();
    let path = "/v1/tasks/handover/commands";
    let hold = json!({"hold":"Keep the first plan"});
    let fence = registry.service.fence("handover").await;
    assert_eq!(
        post_json(&registry.api, path, &writer, &hold).await,
        StatusCode::CONFLICT
    );
    drop(fence);
    assert_eq!(
        post_json(&registry.api, path, &writer, &hold).await,
        StatusCode::OK
    );
    registry.archived.store(true, Ordering::Relaxed);
    let archived = json!({"kind":"thread.updated", "sequence":17, "thread":{
        "id":"alpha-planner", "projectId":"alpha-native", "archivedAt":"2026-11-23T18:10:00Z"
    }});
    registry.service.host.fixture_shell_delta(&archived);
    registry
        .service
        .wake_from_host(nucleus_hosts::ThreadHint::fixture(&archived).unwrap())
        .await;
    let response = post_as(&registry.api, path, &writer, &json!("release")).await;
    assert!(matches!(
        response.status(),
        StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED
    ));
    let row = registry.service.task("handover").await.unwrap();
    assert_eq!(row.version, 2);
    assert!(row.task.hold().is_some());
}

#[tokio::test]
async fn reassign_commits_once_and_invalidates_planner_at_publication() {
    let registry = registry().await;
    for actor in ["alpha-planner", "beta-planner"] {
        let response = registry
            .inline_command(
                actor,
                caller_request(&registry.api, Method::GET, "/v1/tasks", actor, Value::Null),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    let (alpha, beta, epoch) = {
        let state = registry.service.state.lock().await;
        (
            state
                .live_planner_project("alpha-planner")
                .unwrap()
                .to_owned(),
            state
                .live_planner_project("beta-planner")
                .unwrap()
                .to_owned(),
            state.planner_authority_epoch,
        )
    };
    let dispatch =
        json_body(get_as(&registry.api, "/v1/settings/dispatch", &BOARD_KEY).await).await;
    let initial = json_body(get_as(&registry.api, "/v1/settings/projects", &BOARD_KEY).await).await;
    let reassign =
        json!({"revision": initial["settings"]["revision"], "origin":REPOSITORY, "toProject":beta});
    let reads = registry.reads.load(Ordering::Relaxed);
    let wake = registry.service.planner_wake.notified();
    let moved = post_as(
        &registry.api,
        "/v1/settings/projects/reassign",
        &BOARD_KEY,
        &reassign,
    )
    .await;
    assert_eq!(moved.status(), StatusCode::OK);
    let moved = json_body(moved).await;
    tokio::time::timeout(std::time::Duration::from_secs(1), wake)
        .await
        .unwrap();
    assert!(
        moved["settings"]["value"]["projects"][&alpha]["repositories"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        moved["settings"]["value"]["projects"][&beta]["repositories"]
            .as_array()
            .unwrap()
            .iter()
            .any(|repo| repo["origin"] == REPOSITORY)
    );
    assert_eq!(
        post_as(
            &registry.api,
            "/v1/settings/projects/reassign",
            &BOARD_KEY,
            &reassign
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        json_body(get_as(&registry.api, "/v1/settings/dispatch", &BOARD_KEY).await).await,
        dispatch
    );
    let state = registry.service.state.lock().await;
    assert_eq!(state.planner_authority_epoch, epoch + 1);
    assert!(state.planner_authority.is_empty());
    assert!(state.live_planner_project("alpha-planner").is_none());
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads);
}
