use super::*;

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one loopback trace crosses forge, native host, callback, and restart"
)]
async fn conflict_continues_the_bound_worker_once_across_a_lost_reply_and_restart() {
    let (home, mut service) = fixture(GitHub::new("unused-fixture").unwrap());
    let project = service.fixture().clone();
    let old_head = project.start.clone();
    let pr = PullRequest {
        url: format!("https://github.com/{REPOSITORY}/pull/1"),
        head: old_head.clone(),
    };
    let mut task = Task::new(
        nucleus_core::Identity {
            id: "worker".into(),
            reference: "worker".into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        "---\ncomplexity: normal\n---\nResolve the fixture conflict.".into(),
        None,
    );
    let mut observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(Workspace::Clean(old_head.clone())),
    };
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    let worker: nucleus_core::profiles::Profile = serde_json::from_value(
        json!({"id":"fixture", "capability":"worker", "provider":"codex", "model":"fixture"}),
    )
    .unwrap();
    let reviewer: nucleus_core::profiles::Profile = serde_json::from_value(
        json!({"id":"reviewer", "capability":"worker", "provider":"codex", "model":"other"}),
    )
    .unwrap();
    crate::profiles::tests::finish_profile_run(
        &mut task,
        &mut observation,
        (&worker, "worker", "thread:worker"),
        Report::Work(pr.into()),
        Phase::Reviewing,
    );
    let worktrees = service.worktrees();
    let checkout = worktrees
        .checkout(&project.checkout, REPOSITORY, "worker")
        .unwrap();
    checkout.allocate(&old_head).unwrap();
    let binding = service.binding(&checkout).unwrap();
    let reviewer_wire = RunRequest {
        binding: binding.clone(),
        dispatch: Dispatch::Create {
            title: "Reviewer".into(),
            profile: nucleus_hosts::RoleProfile {
                instance_id: "provider".into(),
                model: "other".into(),
                options: vec![],
                runtime_mode: "full-access".into(),
            },
        },
        parent: None,
        text: "Review".into(),
    }
    .inputs(
        &task.next_launch_instance().unwrap(),
        "thread:reviewer".into(),
        1,
    )
    .unwrap()
    .input;
    crate::profiles::tests::finish_profile_run_with_input(
        &mut task,
        &mut observation,
        (&reviewer, "reviewer", "thread:reviewer"),
        Report::Review {
            head: old_head.clone(),
            decision: Review::Approve,
            summary: "Approved the original head".into(),
            finding_titles: vec![],
        },
        Phase::Merging,
        reviewer_wire,
    );

    let owned = checkout.path().to_owned();
    crate::tests::git(
        &owned,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "Resolve the merge conflict",
        ],
    );
    let new_head: Head = crate::tests::git(&owned, &["rev-parse", "HEAD"])
        .parse()
        .unwrap();
    crate::tests::git(&owned, &["reset", "--hard", old_head.as_str()]);

    let published = Arc::new(AtomicBool::new(false));
    let merge_requests = Arc::new(AtomicUsize::new(0));
    let pull = |head| {
        let mut wire = forge_pull(head);
        wire["head"]["ref"] = json!("ns-worker");
        wire
    };
    let checks = {
        let mut wire = forge_checks(&old_head);
        wire["data"]["repository"]["pullRequest"]["mergeable"] = json!("CONFLICTING");
        wire["data"]["repository"]["pullRequest"]["mergeStateStatus"] = json!("DIRTY");
        wire
    };
    let (old_pull, new_pull, new_checks) =
        (pull(&old_head), pull(&new_head), forge_checks(&new_head));
    let (pull_published, checks_published) = (Arc::clone(&published), Arc::clone(&published));
    let writes = Arc::clone(&merge_requests);
    let api = Router::new()
        .route(
            &format!("/repos/{REPOSITORY}/pulls/1"),
            get(move || async move {
                Json(if pull_published.load(Ordering::Relaxed) {
                    new_pull
                } else {
                    old_pull
                })
            }),
        )
        .route(
            "/graphql",
            post(move || async move {
                Json(if checks_published.load(Ordering::Relaxed) {
                    new_checks
                } else {
                    checks
                })
            }),
        )
        .route(
            &format!("/repos/{REPOSITORY}/pulls/1/merge"),
            put(move || async move {
                writes.fetch_add(1, Ordering::Relaxed);
                StatusCode::FORBIDDEN
            }),
        );
    let (forge, forge_server) = serve_forge(api).await;
    service.forge = forge;

    let parent_thread = nucleus_hosts::parent_thread(Path::new(&binding.worktree_path));
    let selection = json!({"instanceId":"provider","model":"fixture"});
    let native_selection = selection.clone();
    let root = project.checkout.clone();
    let instance = task.next_launch_instance().unwrap();
    let accepted = Arc::new(std::sync::Mutex::new(Vec::new()));
    let returns = Arc::new(AtomicBool::new(false));
    let (native_accepted, native_returns) = (Arc::clone(&accepted), Arc::clone(&returns));
    let parent_runs = Arc::new(std::sync::Mutex::new(
        crate::profiles::tests::NativeRuns::default(),
    ));
    let parent_root = root.clone();
    let (host, native_server) = native_fixture(move |request| {
        let payload = &request["payload"];
        if request["tag"] == "orchestration.launchThread"
            || (request["tag"] == "orchestration.subscribeThread" && payload["threadId"] == parent_thread)
        {
            return crate::profiles::tests::native_response(request, &parent_root, &mut parent_runs.lock().unwrap());
        }
        let id = &request["id"];
        let snapshot = match request["tag"].as_str() {
            Some("orchestration.subscribeShell") => json!({"snapshot":{
                "projects":[{"id":binding.project_id,"workspaceRoot":root}]
            }}),
            Some("orchestration.subscribeThread") => {
                let payloads = native_accepted.lock().unwrap();
                let runs = if payloads.is_empty() || payload["threadId"] != "thread:worker" {
                    json!([])
                } else {
                    let status = if native_returns.load(Ordering::Relaxed) { "completed" } else { "running" };
                    json!([{"id":"native-continuation","status":status,"userMessageId":payloads[0]}])
                };
                json!({"projection":{
                    "thread":{"id":payload["threadId"],"projectId":binding.project_id, "parentThreadId":parent_thread,
                        "worktreePath":binding.worktree_path,"branch":binding.branch,
                        "providerInstanceId":"provider","modelSelection":if payload["threadId"] == "thread:reviewer" { json!({"instanceId":"provider","model":"other"}) } else { native_selection.clone() }},
                    "runs":runs,"messages":[],"runtimeRequests":[],"providerThreads":[],"turnItems":[]
                }})
            }
            Some("orchestration.dispatchCommand") => {
                assert_eq!(payload["type"], "message.dispatch");
                assert_eq!(payload["threadId"], "thread:worker");
                assert_eq!(payload["commandId"], instance);
                assert_eq!(payload["modelSelection"], native_selection);
                assert!(payload["text"].as_str().unwrap().contains("resolve the conflicts"));
                native_accepted.lock().unwrap().push(payload["messageId"].clone());
                return serde_json::Value::Null;
            }
            Some("server.getConfig") => {
                return json!({"_tag": "Exit", "requestId": id, "exit": {
                    "_tag": "Success", "value": {
                        "environment": {"orchestrationProtocolVersion": 2},
                        "providers": [{"instanceId": "provider", "driver":"codex", "enabled": true,
                            "status": "ready", "models": [{"slug": "fixture"}, {"slug":"other"}]},
                            {"instanceId":"fixture-acp", "driver":"acpRegistry", "enabled":true, "status":"ready", "models":[{"slug":"nucleus"}]}]
                    }
                }});
            }
            _ => panic!("unexpected native request {request}"),
        };
        let mut snapshot = snapshot;
        snapshot["kind"] = json!("snapshot");
        snapshot["snapshotSequence"] = json!(12);
        json!({"_tag":"Chunk","requestId":id,"values":[snapshot,{"kind":"synchronized"}]})
    }).await;
    service.host = host;
    service
        .state
        .lock()
        .await
        .store
        .create_with_facts(
            &task,
            &event("fixture"),
            nucleus_store::TaskAdmissionFacts::default(),
        )
        .unwrap();
    let advance = async |service: &Service| {
        let row = service.task("worker").await.unwrap();
        Box::pin(service.advance(&row, &service.host.fixture_pass())).await
    };

    assert_eq!(
        advance(&service).await.unwrap(),
        Action::Advance(Phase::Working)
    );
    assert_eq!(
        advance(&service).await.unwrap(),
        Action::Launch {
            via: Launch::Continue {
                thread: "thread:worker".into()
            },
            role: Role::Worker
        }
    );
    let retained = service.task("worker").await.unwrap();
    let launch = retained.task.run().unwrap().launch();
    let wire: serde_json::Value = serde_json::from_str(&launch.input).unwrap();
    assert_eq!(wire["selection"], selection);
    assert_eq!(wire["payload"]["modelSelection"], selection);
    assert!(
        advance(&service).await.is_err(),
        "the accepted send loses its reply"
    );
    assert_eq!(
        *accepted.lock().unwrap(),
        vec![wire["payload"]["messageId"].clone()]
    );
    let sent = service.task("worker").await.unwrap();
    assert!(sent.task.run().unwrap().last_send_at_ms().is_some());

    let host = nucleus_hosts::T3::new(service.host.endpoint(), "fixture").unwrap();
    let forge = std::mem::replace(&mut service.forge, GitHub::new("unused-fixture").unwrap());
    drop(service);
    let settings = nucleus_store::SettingsFile::open(&home.path().canonicalize().unwrap()).unwrap();
    // The continuation is reused under the ACP parent, which is what the recheck guards.
    host.fixture_project_shell(
        &serde_json::json!({
            "projects": [{"id": project.host_project, "workspaceRoot": project.checkout}],
            "threads": []
        }),
        "fixture-acp",
    );
    let service = Service::open_projects(
        settings.lock_profile().unwrap(),
        "fixture-acp".into(),
        host,
        forge,
        "127.0.0.1:9".parse().unwrap(),
        std::env::current_exe().unwrap(),
    )
    .unwrap();
    service.state.lock().await.settings.profiles = Some(Arc::new(serde_json::from_value(json!({"profiles":[
        {"name":"Worker", "providerInstanceId":"provider", "selection":{"id":"fixture", "provider":"codex", "model":"fixture"}},
        {"name":"Reviewer", "providerInstanceId":"provider", "selection":{"id":"reviewer", "provider":"codex", "model":"other"}}
    ]})).unwrap()));
    assert_eq!(service.task("worker").await.unwrap().task, sent.task);
    assert_eq!(
        advance(&service).await.unwrap(),
        Action::Wait(WaitReason::Running)
    );

    crate::tests::git(&owned, &["reset", "--hard", new_head.as_str()]);
    published.store(true, Ordering::Relaxed);
    returns.store(true, Ordering::Relaxed);
    let file = ticket::path(service.storage.scratch(), &launch.instance);
    let binding: ticket::ReportTicket =
        serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let new_pr = PullRequest {
        url: task.pull_request().unwrap().url.clone(),
        head: new_head.clone(),
    };
    service
        .report(
            "worker",
            &launch.instance,
            &binding.credential,
            Report::Work(new_pr.into()),
        )
        .await
        .unwrap();
    assert_eq!(
        advance(&service).await.unwrap(),
        Action::Advance(Phase::Reviewing)
    );
    let review = service.task("worker").await.unwrap();
    assert_eq!(review.task.pull_request().unwrap().head, new_head);
    assert!(review.task.verdict().is_none());
    assert_eq!(
        advance(&service).await.unwrap(),
        Action::Wait(WaitReason::Starting)
    );
    crate::profiles::tests::publish_parent_shell(&service).await;
    assert_eq!(
        advance(&service).await.unwrap(),
        Action::Launch {
            via: Launch::Continue {
                thread: "thread:reviewer".into()
            },
            role: Role::Reviewer
        }
    );
    assert_eq!(accepted.lock().unwrap().len(), 1);
    assert_eq!(merge_requests.load(Ordering::Relaxed), 0);

    native_server.abort();
    forge_server.abort();
}

#[tokio::test]
async fn stopped_dispatch_waits_then_merges_the_approved_head() {
    let (_home, mut service) = registry_fixture(GitHub::new("unused-fixture").unwrap());
    let head = service.fixture().start.clone();
    let (task, _) = code_task_at_merge("worker", &head);
    service
        .state
        .lock()
        .await
        .store
        .create_with_facts(
            &task,
            &event("fixture"),
            nucleus_store::TaskAdmissionFacts::default(),
        )
        .unwrap();
    let merged = Arc::new(AtomicBool::new(false));
    let puts = Arc::new(AtomicUsize::new(0));
    let read_merged = Arc::clone(&merged);
    let write_merged = Arc::clone(&merged);
    let writes = Arc::clone(&puts);
    let mut pull = forge_pull(&head);
    pull["head"]["ref"] = json!("ns-worker");
    let checks = forge_checks(&head);
    let app = Router::new()
        .route(
            &format!("/repos/{REPOSITORY}/pulls/1"),
            get(move || async move {
                let mut pull = pull;
                if read_merged.load(Ordering::Relaxed) {
                    pull["merged"] = json!(true);
                    pull["state"] = json!("closed");
                    pull["merge_commit_sha"] = json!("f".repeat(40));
                }
                Json(pull)
            }),
        )
        .route("/graphql", post(move || async move { Json(checks) }))
        .route(
            &format!("/repos/{REPOSITORY}/pulls/1/merge"),
            put(move || async move {
                writes.fetch_add(1, Ordering::Relaxed);
                write_merged.store(true, Ordering::Relaxed);
                Json(json!({"sha": "f".repeat(40), "merged": true, "message": "merged"}))
            }),
        );
    let (forge, server) = serve_forge(app).await;
    service.forge = forge;
    service.state.lock().await.settings.dispatch = Some(nucleus_store::DispatchSettings {
        mode: DispatchMode::Stopped,
        ..Default::default()
    });
    let host = service.host.fixture_pass();
    let row = service.task("worker").await.unwrap();
    let result = Box::pin(service.advance(&row, &host)).await;
    assert!(matches!(result, Err(ServiceError::MergeDispatchStopped)));
    assert_eq!(puts.load(Ordering::Relaxed), 0);
    let (wait, detail) = crate::task_wait(&row, &result);
    assert_eq!(wait, Some(WaitReason::Capacity));
    assert!(
        matches!(detail, Some(crate::WaitDetail::Observation(cause)) if cause.contains("Dispatch"))
    );
    assert_eq!(
        service.task("worker").await.unwrap().task.phase(),
        Phase::Merging
    );

    service
        .state
        .lock()
        .await
        .settings
        .dispatch
        .as_mut()
        .unwrap()
        .mode = DispatchMode::Running;
    let result = Box::pin(service.advance(&row, &host)).await.unwrap();
    assert_eq!(result, Action::Advance(Phase::Closing));
    assert_eq!(puts.load(Ordering::Relaxed), 1);
    server.abort();
}

#[tokio::test]
async fn merge_writes_wait_until_the_forge_confirms_the_next_fact() {
    for status in [StatusCode::CONFLICT, StatusCode::METHOD_NOT_ALLOWED] {
        let (_home, mut service) = registry_fixture(GitHub::new("unused-fixture").expect("client"));
        let head = service.fixture().start.clone();
        let new_head: Head = "b".repeat(40).parse().expect("changed head");
        let next = Arc::new(AtomicBool::new(false));
        let puts = Arc::new(AtomicUsize::new(0));
        let app = merge_fixture(&head, &new_head, status, &next, &puts);
        let (forge, server) = serve_forge(app).await;
        service.forge = forge;
        let (mut task, credential, mut observation) =
            reservation("reviewer", Entry::ReviewEntry, &head);
        let instance = task.run().expect("run").launch().instance.clone();
        task.record_report(
            &instance,
            credential.as_bytes(),
            Report::Review {
                head: head.clone(),
                decision: Review::Approve,
                summary: "Approved exact head".into(),
                finding_titles: Vec::new(),
            },
        )
        .expect("report");
        observation.host = Observed::Known(Host::Current {
            instance,
            state: RunState::Ended,
        });
        assert_eq!(
            task.reconcile(&observation),
            Action::Advance(Phase::Merging)
        );
        service
            .state
            .lock()
            .await
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .expect("seed merge");
        let host = service.host.pass(service.storage.scratch().path());
        let row = service.task("reviewer").await.expect("old approval");
        let first = Box::pin(service.advance(&row, &host)).await;
        let row = service.task("reviewer").await.expect("waiting task");
        assert_eq!(row.task.phase(), Phase::Merging);
        assert!(row.task.question().is_none());
        let second = Box::pin(service.advance(&row, &host)).await;
        assert_eq!(puts.load(Ordering::Relaxed), 1);
        if status == StatusCode::CONFLICT {
            for result in [first, second] {
                assert!(matches!(result, Ok(Action::Wait(WaitReason::ForgeUnknown))));
            }
            assert!(row.task.verdict().is_none());
            assert_eq!(
                row.task.pull_request().expect("keep the bound PR").head,
                head
            );
            next.store(true, Ordering::Relaxed);
            assert_eq!(
                Box::pin(service.advance(&row, &host))
                    .await
                    .expect("fresh head"),
                Action::Advance(Phase::Reviewing)
            );
            let updated = service.task("reviewer").await.expect("new head bound");
            assert_eq!(updated.task.pull_request().expect("PR").head, new_head);
        } else {
            for result in [first, second] {
                assert!(matches!(
                    result,
                    Err(ServiceError::Forge(ForgeError::Deferred { .. }))
                ));
            }
            assert!(service.forge_until.load(Ordering::Relaxed) > now_ms());
        }
        server.abort();
    }
}

#[tokio::test]
async fn external_merge_at_the_refused_head_requires_verified_source_acceptance() {
    for merged_during_readback in [false, true] {
        let (_home, mut service) = registry_fixture(GitHub::new("unused-fixture").unwrap());
        let head = service.fixture().start.clone();
        let (task, _) = code_task_at_merge("worker", &head);
        service
            .state
            .lock()
            .await
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();

        let merged = Arc::new(AtomicBool::new(false));
        let published = Arc::new(AtomicBool::new(false));
        let puts = Arc::new(AtomicUsize::new(0));
        let (read_merge, write_merge) = (merged.clone(), merged.clone());
        let (read_base, writes) = (published.clone(), puts.clone());
        let checks = forge_checks(&head);
        let mut pull = forge_pull(&head);
        pull["head"]["ref"] = json!("ns-worker");
        let path = format!("/repos/{REPOSITORY}/pulls/1");
        let commit = "f".repeat(40);
        let tip = "b".repeat(40);
        let comparison = format!("/repos/{REPOSITORY}/compare/{commit}...{tip}");
        let app = Router::new()
            .route(&path, get(move || async move {
                let mut pull = pull;
                if read_merge.load(Ordering::Relaxed) {
                    pull["merged"] = json!(true);
                    pull["state"] = json!("closed");
                    pull["merge_commit_sha"] = json!(commit);
                }
                Json(pull)
            }))
            .route("/graphql", post(move || async move { Json(checks) }))
            .route(&format!("{path}/merge"), put(move || async move {
                writes.fetch_add(1, Ordering::Relaxed);
                write_merge.store(merged_during_readback, Ordering::Relaxed);
                StatusCode::CONFLICT
            }))
            .route(&format!("/repos/{REPOSITORY}/branches/main"), get(move || async move {
                Json(json!({"name":"main", "commit":{"sha":tip}}))
            }))
            .route(&comparison, get(move || async move {
                Json(json!({"status": if read_base.load(Ordering::Relaxed) { "ahead" } else { "diverged" }}))
            }));
        let (forge, server) = serve_forge(app).await;
        service.forge = forge;
        let host = service.host.fixture_pass();
        let approved = service.task("worker").await.unwrap();
        assert!(matches!(
            Box::pin(service.advance(&approved, &host)).await,
            Ok(Action::Wait(WaitReason::ForgeUnknown))
                | Err(ServiceError::Forge(ForgeError::UnpublishedMerge))
        ));
        let refused = service.task("worker").await.unwrap();
        assert!(refused.task.verdict().is_none());
        assert!(refused.task.question().is_none());

        merged.store(true, Ordering::Relaxed);
        assert!(matches!(
            Box::pin(service.advance(&refused, &host)).await,
            Err(ServiceError::Forge(ForgeError::UnpublishedMerge))
        ));
        assert!(
            service
                .task("worker")
                .await
                .unwrap()
                .task
                .question()
                .is_none()
        );
        published.store(true, Ordering::Relaxed);
        let question = Action::Ask(nucleus_core::Question::Accept { head });
        assert_eq!(
            Box::pin(service.advance(&refused, &host)).await.unwrap(),
            question
        );
        let asked = service.task("worker").await.unwrap();
        assert!(asked.task.verdict().is_none());
        assert!(asked.task.question().is_some());
        assert_eq!(puts.load(Ordering::Relaxed), 1);
        server.abort();
    }
}

#[tokio::test]
async fn a_forge_outage_defers_other_tasks_without_sending_a_request() {
    let requests = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&requests);
    let (forge, server) = serve_forge(Router::new().route(
        &format!("/repos/{}/pulls/1", crate::tests::REPOSITORY),
        get(move || async move {
            count.fetch_add(1, Ordering::Relaxed);
            StatusCode::SERVICE_UNAVAILABLE
        }),
    ))
    .await;
    let (_home, service) = fixture(forge);
    for id in ["first", "second"] {
        let (reserved, _, _) = reservation(id, Entry::ReviewEntry, &service.fixture().start);
        let task = Task::new(
            reserved.identity().clone(),
            reserved.brief().text.clone(),
            reserved.pull_request().cloned(),
        );
        service
            .state
            .lock()
            .await
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .expect("seed");
    }
    let started = tokio::time::Instant::now();
    let outcomes = service.pass().await.expect("process both due tasks");
    assert!(matches!(
        outcomes.as_slice(),
        [
            crate::PassOutcome { task: first, result: Err(ServiceError::Forge(ForgeError::Status(StatusCode::SERVICE_UNAVAILABLE))) },
            crate::PassOutcome { task: second, result: Err(ServiceError::Forge(ForgeError::Deferred { .. })) }
        ] if first == "first" && second == "second"
    ));
    assert_eq!(requests.load(Ordering::Relaxed), 1);
    assert_eq!(service.forge_retry_secs.load(Ordering::Relaxed), 30);
    let state = service.state.lock().await;
    for id in ["first", "second"] {
        assert_eq!(state.wait_reason(id), Some(WaitReason::ForgeUnknown));
        assert!(
            state
                .schedule
                .due(id)
                .is_some_and(|due| { due >= started + Duration::from_secs(30) })
        );
        assert_eq!(
            state
                .store
                .row(id)
                .expect("read unchanged row")
                .expect("task")
                .version,
            1
        );
    }
    server.abort();
}

#[tokio::test]
async fn prepared_and_revoked_reviews_recheck_the_actual_forge_and_checkout() {
    for (revoked, changed_head, dirty, allowed) in [
        (false, false, true, false),
        (true, false, true, false),
        (true, false, false, true),
        (true, true, true, true),
    ] {
        let (_home, mut service) = registry_fixture(GitHub::new("unused-fixture").expect("client"));
        let head = service.fixture().start.clone();
        let latest = if changed_head {
            "b".repeat(40).parse().expect("new head")
        } else {
            head.clone()
        };
        let (forge, reads, server) = forge_fixture(&latest).await;
        service.forge = forge;
        let worktrees = service.worktrees();
        let checkout = worktrees
            .checkout(
                &service.fixture().checkout,
                &service.fixture().repository,
                "reviewer",
            )
            .expect("checkout");
        assert_eq!(
            checkout.allocate(&head).expect("allocate"),
            Workspace::Clean(head.clone())
        );
        let (mut task, _, mut cached) = reservation("reviewer", Entry::ReviewEntry, &head);
        let instance = task.run().expect("run").launch().instance.clone();
        if revoked {
            task.record_send(&instance, 1).expect("prior delivery");
            task.command(
                Command::Cancel,
                &Authority::Operator {
                    actor: "fixture".into(),
                },
                &cached,
            )
            .expect("revoke");
        } else {
            cached.host = Observed::Known(Host::Current {
                instance,
                state: RunState::ReadyToSend,
            });
        }
        if dirty {
            std::fs::write(checkout.path().join("local-edit.txt"), "local changes")
                .expect("edit after observation");
        }
        let host = Due(std::sync::atomic::AtomicUsize::new(0), None);
        service
            .state
            .lock()
            .await
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .expect("fixture row");
        let row = service
            .task(&task.identity().id)
            .await
            .expect("fixture version");
        let result = if revoked {
            Box::pin(service.stop_run(&row, &checkout, cached, &host)).await
        } else {
            service.send_prepared(&row, &checkout, cached, &host).await
        };
        assert_eq!(reads.load(Ordering::Relaxed), 1, "fresh forge read");
        assert_eq!(host.0.load(Ordering::Relaxed), usize::from(allowed));
        if allowed {
            assert!(matches!(
                result,
                Err(ServiceError::Host(nucleus_hosts::HostError::Uncertain))
            ));
        } else if revoked {
            assert_eq!(
                result.expect("dirty current head waits"),
                Action::Wait(WaitReason::Stopping)
            );
        } else {
            assert_eq!(
                result.expect("discard unsent review"),
                Action::Advance(Phase::Reviewing)
            );
            let row = service.task("reviewer").await.expect("cleared reservation");
            assert!(row.task.run().is_none());
            assert_eq!(row.task.attempts(), 0);
        }
        server.abort();
    }
}

#[tokio::test]
async fn merge_gate_uses_only_github_required_checks() {
    let (_home, mut service) = registry_fixture(GitHub::new("unused-fixture").unwrap());
    let project = service.fixture().clone();
    let head = project.start.clone();

    let (task, _) = code_task_at_merge("worker", &head);
    {
        let worktrees = service.worktrees();
        worktrees
            .checkout(&project.checkout, REPOSITORY, "worker")
            .unwrap()
            .allocate(&head)
            .unwrap();
    }
    let mut pull = forge_pull(&head);
    pull["head"]["ref"] = json!("ns-worker");

    let check = |name, conclusion, required| json!({"__typename":"CheckRun","name":name,"conclusion":conclusion,"isRequired":required});
    let rollup = |state, has_next, nodes| json!({"state":state,"contexts":{"pageInfo":{"hasNextPage":has_next,"endCursor":null},"nodes":nodes}});
    let cases = [
        (
            "BLOCKED",
            rollup("FAILURE", false, json!([check("CI", "FAILURE", true)])),
            CheckState::FailedRequired(vec!["CI".into()]),
        ),
        (
            "UNSTABLE",
            rollup(
                "FAILURE",
                false,
                json!([
                    check("CI", "SUCCESS", true),
                    check("optional-lint", "FAILURE", false)
                ]),
            ),
            CheckState::Ready,
        ),
        (
            "CLEAN",
            rollup("SUCCESS", true, json!([])),
            CheckState::Unknown,
        ),
    ];
    for (merge_state, rollup, expected) in cases {
        let mut reply = forge_checks(&head);
        let pr = &mut reply["data"]["repository"]["pullRequest"];
        pr["mergeStateStatus"] = json!(merge_state);
        pr["statusCheckRollup"] = rollup;
        let pr_wire = pull.clone();
        let (forge, server) = serve_forge(
            Router::new()
                .route(
                    &format!("/repos/{REPOSITORY}/pulls/1"),
                    get(move || async move { Json(pr_wire) }),
                )
                .route("/graphql", post(move || async move { Json(reply) })),
        )
        .await;
        service.forge = forge;
        let (observed, _) = {
            let worktrees = service.worktrees();
            let checkout = worktrees
                .checkout(&project.checkout, REPOSITORY, "worker")
                .unwrap();
            service.read_forge(&task, &checkout).await.unwrap()
        };
        assert!(
            matches!(observed, Forge::Open { checks, .. } if checks == expected),
            "expected {expected:?} for {merge_state}"
        );
        server.abort();
    }
}

#[tokio::test]
async fn pre_send_unavailable_restores_reserved_run_and_records_host_send_not_sent() {
    let (_home, mut service) = crate::tests::fixture(GitHub::new("unused-test-forge").unwrap());
    let (row, thread) = {
        let worktrees = service.worktrees();
        let checkout = worktrees
            .checkout(&service.fixture().checkout, REPOSITORY, "role-not-sent")
            .unwrap();
        seed_reserved_role_launch(&service, "role-not-sent", &checkout).await
    };
    let reject_tickets = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (host, server) = crate::tests::native_fixture_with_ticket_gate(
        Arc::clone(&reject_tickets),
        move |req| {
            assert_eq!(req["tag"], "orchestration.subscribeThread");
            json!({
                "_tag": "Exit",
                "requestId": req["id"],
                "exit": {
                    "_tag": "Failure",
                    "cause": [{"_tag": "Fail", "error": {
                        "_tag": "OrchestrationV2GetThreadProjectionError",
                        "threadId": thread,
                        "cause": {
                            "name": "ProjectionStoreThreadNotFoundError",
                            "message": format!("No orchestration projection exists for thread {thread}.")
                        }
                    }}]
                }
            })
        },
    )
    .await;
    host.fixture_held_shell(&json!({
        "kind":"snapshot","snapshot":{
            "snapshotSequence":1,
            "projects":[{"id":"local-fixture","workspaceRoot":service.fixture().checkout}],
            "threads":[]
        }
    }));
    service.host = host;
    let worktrees = service.worktrees();
    let checkout = worktrees
        .checkout(&service.fixture().checkout, REPOSITORY, "role-not-sent")
        .unwrap();
    let host = DisconnectingPass {
        host: &service.host,
        pass: service.host.fixture_pass(),
        reject_tickets,
    };
    let err = service.send(&row, &checkout, &host).await.err().unwrap();
    assert!(matches!(err, ServiceError::Host(HostError::Unavailable)));
    let restored = service.task("role-not-sent").await.unwrap();
    assert_eq!(restored.task.run().unwrap().last_send_at_ms(), None);
    let history = service.history("role-not-sent", None, 20).await.unwrap();
    assert!(
        history
            .iter()
            .any(|entry| entry.content.kind == "host_send_not_sent")
    );
    server.abort();
}
