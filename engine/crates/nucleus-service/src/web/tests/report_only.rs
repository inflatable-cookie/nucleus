use std::sync::Mutex;

use nucleus_core::{CallbackCredential, Head, Observation, Role, Workspace};
use nucleus_hosts::HostError;

use super::{planning::put_as, *};
use crate::tests::{git, native_fixture};

const TASK: &str = "report-cutover";
const PROJECT: &str = "local-fixture";
const WORKER: &str = "worker-report";
const BRIEF: &str = "---\ntitle: Milestone QA\nqueue:\n  complexity: low\n  lanes: [qa, notes]\n  reportOnly: true\n  reportLane: qa\n---\nQualify the pinned commit.";

#[tokio::test]
async fn board_and_worker_lane_edits_both_refresh_paired_planning() {
    let fixture = ReportFixture::new().await;
    fixture.admit().await;
    let turn = fixture.reserve().await;
    let assets = tempfile::tempdir().unwrap();
    std::fs::write(assets.path().join("index.html"), "").unwrap();
    std::fs::write(assets.path().join("app.js"), "").unwrap();
    let api = router_with_board(
        Arc::clone(&fixture.service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "operator".into(),
            },
        }],
        assets.path(),
    )
    .unwrap();
    let cookie = pair_board(&api, &BOARD_KEY).await;
    let cookie = Some(cookie.as_str());
    let mut events = browser_request(&api, Method::GET, "/api/engine/events", cookie, None)
        .await
        .into_body()
        .into_data_stream();
    assert_event(&mut events, &["event: refresh"]).await;
    let settings = fixture.service.settings_changes.subscribe();

    let lane = format!("/api/engine/planning/{PROJECT}/lanes/qa");
    let edit = json!({
        "version": 1, "title": "qa", "aim": "qualification", "document": "board edit",
    });
    let saved = browser_request(&api, Method::PUT, &lane, cookie, Some(&edit)).await;
    assert_eq!(saved.status(), StatusCode::OK);
    assert_event(&mut events, &["event: planning"]).await;

    let saved = fixture.write(&turn, 2, "worker edit").await;
    assert_eq!(saved["version"], 3);
    assert_event(&mut events, &["event: planning"]).await;
    assert!(!settings.has_changed().unwrap());

    let plan = format!("/api/engine/planning/{PROJECT}/plan");
    let projection = json_body(browser_request(&api, Method::GET, &plan, cookie, None).await).await;
    let written = projection["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|document| document["key"] == "qa")
        .unwrap();
    assert_eq!(written["document"], "worker edit");
}

#[tokio::test]
async fn report_only_admits_an_attached_lane_and_proves_the_planning_pin() {
    let fixture = ReportFixture::new().await;
    let tasks = format!("/v1/planning/{PROJECT}/tasks");
    for (brief, refusal) in [
        (BRIEF.replace("  reportLane: qa\n", ""), "multiple lanes"),
        (
            BRIEF.replace("  reportLane: qa", "  reportLane: elsewhere"),
            "must also be attached",
        ),
        (
            BRIEF
                .replace("  lanes: [qa, notes]\n", "")
                .replace("  reportLane: qa\n", ""),
            "requires an attached lane",
        ),
        (
            BRIEF.replace("  reportLane: qa", "  reportLane: qa\n  interactive: true"),
            "queue.interactive",
        ),
    ] {
        let response = post_as(&fixture.api, &tasks, &BOARD_KEY, &json!({"brief":brief})).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{refusal}");
        assert!(
            json_body(response).await["error"]
                .as_str()
                .expect("refusal")
                .contains(refusal)
        );
    }
    let response = post_as(
        &fixture.api,
        &tasks,
        &BOARD_KEY,
        &json!({
            "brief": BRIEF, "planningCommit":"a".repeat(40),
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(
        json_body(response).await["error"]
            .as_str()
            .expect("pin refusal")
            .contains("changed")
    );
    fixture.admit().await;

    let item = json_body(post_as(&fixture.api, &format!("/v1/planning/{PROJECT}/items"), &BOARD_KEY, &json!({
        "kind":"lead","title":"Promoted report","body": BRIEF.replace("  lanes: [qa, notes]\n", "").replace("  reportLane: qa\n", ""),
        "lanes":["qa"],
    })).await).await;
    let id = item["id"].as_str().expect("lead ID");
    let response = post_as(
        &fixture.api,
        &format!("/v1/planning/{PROJECT}/items/{id}/promote"),
        &BOARD_KEY,
        &json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let admitted = json_body(response).await;
    let task = admitted["identity"]["id"].as_str().expect("promoted task");
    assert_eq!(
        fixture
            .service
            .task(task)
            .await
            .expect("promoted")
            .task
            .report_task()
            .expect("report")
            .lane,
        "qa"
    );
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "exercise one durable lifecycle across its real HTTP boundaries"
)]
async fn report_only_ticket_revision_and_historical_owner_acceptance() {
    let fixture = ReportFixture::new().await;
    fixture.admit().await;
    let turn = fixture.reserve().await;
    let lane = turn.lane("qa");
    for refused in [
        turn.lane("notes"),
        lane.replace(PROJECT, "wrong-project"),
        lane.replace(TASK, "unknown-task"),
        lane.replace(&turn.instance, "other-run"),
        format!("/v1/tasks/{TASK}"),
    ] {
        assert_eq!(
            get_as(&fixture.api, &refused, turn.key()).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        get_as(&fixture.api, &lane, &BOARD_KEY).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        put_as(
            &fixture.api,
            &format!("/v1/planning/{PROJECT}/lanes/qa"),
            turn.key(),
            &json!({
                "version": 1, "title": "spoof", "aim": "spoof", "document": "spoof",
            })
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        put_as(
            &fixture.api,
            &turn.lane("notes"),
            turn.key(),
            &json!({
                "version": 1, "document": "foreign write",
            })
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        put_as(
            &fixture.api,
            &lane,
            turn.key(),
            &json!({
                "version": 1, "document": "metadata write", "title": "forged",
            })
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );

    let initial = json_body(get_as(&fixture.api, &lane, turn.key()).await).await;
    assert_eq!(initial["version"], 1);
    let first = fixture.write(&turn, 1, "slice 1").await;
    let latest = fixture.write(&turn, 2, "slice 1 and 2").await;
    assert_eq!(latest["version"], 3);
    assert_eq!(latest["title"], "qa");
    let stale_put = put_as(
        &fixture.api,
        &lane,
        turn.key(),
        &json!({"version":1,"document":"lost"}),
    )
    .await;
    assert_eq!(stale_put.status(), StatusCode::CONFLICT);
    let stale = ReportTurn::report(&first["artifact"], &fixture.head);
    let refused = post_as(&fixture.api, &turn.callback(), turn.key(), &stale).await;
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert!(
        json_body(refused).await["error"]
            .as_str()
            .expect("stale refusal")
            .contains("latest v3")
    );
    let mut wrong_digest = latest["artifact"].clone();
    wrong_digest["digest"] = json!("0".repeat(64));
    let refused = post_as(
        &fixture.api,
        &turn.callback(),
        turn.key(),
        &ReportTurn::report(&wrong_digest, &fixture.head),
    )
    .await;
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert!(
        json_body(refused).await["error"]
            .as_str()
            .expect("digest refusal")
            .contains(
                latest["artifact"]["digest"]
                    .as_str()
                    .expect("latest digest")
            )
    );

    let report = ReportTurn::report(&latest["artifact"], &fixture.head);
    assert_eq!(
        post_json(&fixture.api, &turn.callback(), turn.key(), &report).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        get_as(&fixture.api, &lane, turn.key()).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let ready = fixture.settle(&turn).await;
    assert_eq!(ready.task.phase(), Phase::ReportReady);
    assert_eq!(ready.task.threads().get(Role::Worker), Some(WORKER));
    assert_eq!(ready.task.threads().get(Role::Reviewer), None);
    assert!(ready.task.question().is_none());
    assert_eq!(
        post_json(&fixture.api, &turn.callback(), turn.key(), &report).await,
        StatusCode::NO_CONTENT
    );
    let detail =
        json_body(get_as(&fixture.api, &format!("/v1/tasks/{TASK}"), &BOARD_KEY).await).await;
    assert_eq!(detail["report"]["delivery"]["artifact"], latest["artifact"]);
    assert!(detail["report"].get("receipts").is_none());

    assert_eq!(
        fixture.command(json!({"move":"done"})).await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        fixture
            .command(json!({"move_work":{"instruction":"Re-run the missing slice"}}))
            .await
            .status(),
        StatusCode::OK
    );
    let revising = fixture.service.task(TASK).await.expect("working");
    assert_eq!(revising.task.phase(), Phase::Working);
    assert!(
        revising
            .task
            .report_task()
            .expect("report")
            .delivery
            .is_none()
    );
    assert_eq!(
        revising
            .task
            .report_task()
            .expect("report")
            .instruction
            .as_deref(),
        Some("Re-run the missing slice")
    );
    let revision = fixture.reserve().await;
    assert_ne!(revision.instance, turn.instance);
    assert_eq!(
        get_as(&fixture.api, &lane, turn.key()).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let amended = fixture.write(&revision, 3, "revised qualification").await;
    let amended_artifact = &amended["artifact"];
    let report = ReportTurn::report(amended_artifact, &fixture.head);
    assert_eq!(
        post_json(&fixture.api, &revision.callback(), revision.key(), &report).await,
        StatusCode::NO_CONTENT
    );
    let ready = fixture.settle(&revision).await;
    fixture.planner_write("later unrelated lane edit", 4).await;

    let complete = |version, artifact: &Value| {
        json!({"complete":{
            "version":version, "artifact":artifact, "reason":"Qualification reviewed",
        }})
    };
    assert_eq!(
        fixture
            .command(complete(ready.version, &latest["artifact"]))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        fixture
            .command(complete(ready.version - 1, amended_artifact))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    fixture.open_pr.store(true, Ordering::Relaxed);
    assert_eq!(
        fixture
            .command(complete(ready.version, amended_artifact))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    fixture.open_pr.store(false, Ordering::Relaxed);
    fixture.busy.store(true, Ordering::Relaxed);
    assert_eq!(
        fixture
            .command(complete(ready.version, amended_artifact))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    fixture.busy.store(false, Ordering::Relaxed);
    let accept = complete(ready.version, amended_artifact);
    let done = fixture.command(accept.clone()).await;
    assert_eq!(done.status(), StatusCode::OK);
    assert_eq!(json_body(done).await["phase"], "done");
    assert_eq!(fixture.command(accept).await.status(), StatusCode::OK);
    assert!(
        fixture
            .service
            .task(TASK)
            .await
            .expect("done")
            .task
            .pull_request()
            .is_none()
    );
}

#[tokio::test]
async fn report_only_archive_retains_dirty_or_unpublished_source() {
    let fixture = ReportFixture::new().await;
    fixture.admit().await;
    let turn = fixture.reserve().await;
    let artifact = fixture.write(&turn, 1, "qualification").await["artifact"].clone();
    assert_eq!(
        post_json(
            &fixture.api,
            &turn.callback(),
            turn.key(),
            &ReportTurn::report(&artifact, &fixture.head)
        )
        .await,
        StatusCode::NO_CONTENT
    );
    let ready = fixture.settle(&turn).await;
    let response = fixture
        .command(
            json!({"complete":{"version":ready.version,"artifact":artifact,"reason":"accepted"}}),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let done = fixture.service.task(TASK).await.expect("done");
    std::fs::write(fixture.checkout.join("dirty"), "work").expect("untracked");
    assert!(fixture.service.archive_done(&done).await.is_err());
    std::fs::remove_file(fixture.checkout.join("dirty")).expect("clean fixture");
    *fixture.published.lock().expect("remote refs") = None;
    assert!(fixture.service.archive_done(&done).await.is_err());
    assert!(fixture.checkout.is_dir());
    let root = &fixture.service.fixture().checkout;
    git(
        root,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "advanced main",
        ],
    );
    let next = git(root, &["rev-parse", "HEAD"]).parse().expect("new head");
    *fixture.published.lock().expect("remote refs") = Some(next);
    let parent = nucleus_hosts::parent_thread(&fixture.checkout);
    let host = &fixture.service.host;
    {
        let state = fixture.service.state.lock().await;
        assert_eq!(
            state.store.archive_due_ids(None, 10, false).unwrap(),
            [TASK]
        );
    }
    let before = host.host_calls();
    assert!(matches!(
        fixture.service.archive_done(&done).await,
        Err(ServiceError::Host(HostError::Uncertain))
    ));
    assert!(fixture.checkout.exists());
    for status in ["running", "unknown"] {
        host.fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1,"projects":[],"threads":[
                {"id":"delegated-child","parentThreadId":parent,"status":status}
            ]
        }}));
        assert!(matches!(
            fixture.service.archive_done(&done).await,
            Err(ServiceError::Host(HostError::RowChildBusy))
        ));
        assert!(fixture.checkout.exists());
    }
    host.fixture_held_shell(
        &json!({"kind":"thread.removed","sequence":2,"threadId":"delegated-child"}),
    );
    assert_eq!(
        fixture.service.archive_done(&done).await.expect("closeout"),
        Action::Nothing
    );
    assert!(!fixture.checkout.exists());
    assert_eq!(
        host.host_calls(),
        before,
        "retirement must not read omitted rows"
    );
}

struct ReportFixture {
    _home: tempfile::TempDir,
    service: Arc<Service>,
    api: Router,
    head: Head,
    published: Arc<Mutex<Option<Head>>>,
    open_pr: Arc<AtomicBool>,
    busy: Arc<AtomicBool>,
    checkout: std::path::PathBuf,
    forge: tokio::task::JoinHandle<()>,
    host: tokio::task::JoinHandle<()>,
}

impl ReportFixture {
    async fn new() -> Self {
        let (home, mut service) = fixture(GitHub::new("fixture").expect("forge"));
        let head = service.fixture().start.clone();
        let published = Arc::new(Mutex::new(Some(head.clone())));
        let open_pr = Arc::new(AtomicBool::new(false));
        let busy = Arc::new(AtomicBool::new(false));
        let origin = Arc::clone(&published);
        let branch = Arc::clone(&published);
        let prs = Arc::clone(&open_pr);
        let (forge, forge_server) = serve_forge(Router::new()
            .route(&format!("/repos/{REPOSITORY}/branches/main"), get(move || async move {
                Json(json!({"name":"main","commit":{"sha":branch.lock().expect("branch").as_ref()}}))
            }))
            .route(&format!("/repos/{REPOSITORY}/branches"), get(move || async move {
                let remote = origin.lock().expect("origin");
                Json(remote.iter().map(|head| json!({"name":"main","commit":{"sha":head}})).collect::<Vec<_>>())
            }))
            .route("/graphql", post(move |Json(request): Json<Value>| async move {
                assert_eq!(request["variables"]["head"], format!("ns-{TASK}"));
                assert!(request["query"].as_str().expect("query").contains("headRefName:$head,states:OPEN"));
                Json(json!({"data":{"repository":{"pullRequests":{"totalCount":u8::from(prs.load(Ordering::Relaxed))}}}}))
            }))
        ).await;
        service.forge = forge;

        let checkout = nucleus_work::checkout_path(service.storage.work().path(), REPOSITORY, TASK);
        let path = checkout.clone();
        let running = Arc::clone(&busy);
        let (host, host_server) = native_fixture(move |request| {
            assert_eq!(request["tag"], "orchestration.subscribeThread");
            assert_eq!(request["payload"]["threadId"], WORKER);
            let requests = if running.load(Ordering::Relaxed) {
                json!([{"kind":"permission","status":"pending"}])
            } else { json!([]) };
            json!({"_tag":"Chunk","requestId":request["id"],"values":[
                {"kind":"snapshot","snapshotSequence":1,"projection":{
                    "thread":{"id":WORKER,"projectId":PROJECT,"worktreePath":path,"branch":format!("ns-{TASK}")},
                    "runs":[],"messages":[],"runtimeRequests":requests,"providerThreads":[],"turnItems":[],"subagents":[]
                }},
                {"kind":"synchronized"}
            ]})
        }).await;
        service.host = host;
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
        for key in ["qa", "notes"] {
            let response = put_as(
                &api,
                &format!("/v1/planning/{PROJECT}/lanes/{key}"),
                &BOARD_KEY,
                &json!({
                    "version":0, "title":key, "aim":"qualification", "document":"initial",
                }),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        Self {
            _home: home,
            service,
            api,
            head,
            published,
            open_pr,
            busy,
            checkout,
            forge: forge_server,
            host: host_server,
        }
    }

    async fn admit(&self) {
        let response = post_as(
            &self.api,
            &format!("/v1/planning/{PROJECT}/tasks"),
            &BOARD_KEY,
            &json!({
                "id": TASK, "brief": BRIEF, "planningCommit": self.head,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
    }

    async fn reserve(&self) -> ReportTurn {
        let prior = self.service.task(TASK).await.expect("task");
        let mut task = prior.task.clone();
        let worktrees = self.service.worktrees().expect("worktrees");
        let checkout = worktrees
            .checkout(&self.service.fixture().checkout, REPOSITORY, TASK)
            .expect("checkout");
        assert_eq!(
            checkout.allocate(&self.head).expect("worktree"),
            Workspace::Clean(self.head.clone())
        );
        let observation = Observation {
            host: task
                .threads()
                .get(Role::Worker)
                .map_or(Observed::Unknown, |thread| {
                    Observed::Known(Host::Retained {
                        thread: thread.into(),
                        state: RetainedThread::Idle,
                    })
                }),
            forge: Observed::Unknown,
            workspace: Observed::Known(Workspace::Clean(self.head.clone())),
        };
        if task.phase() == Phase::Queued {
            assert_eq!(
                task.reconcile(&observation),
                Action::Advance(Phase::Working)
            );
        }
        let row = nucleus_store::TaskRow {
            task: task.clone(),
            version: prior.version,
            number: prior.number,
        };
        let instance = task.next_launch_instance().expect("run identity");
        let prompt = crate::prompt::Prompt {
            row: &row,
            role: Role::Worker,
            via: &nucleus_core::Launch::Create,
            replaced_thread: None,
            instance: &instance,
            checkout: checkout.path(),
            scratch: std::path::Path::new("/scratch/run"),
            branch: checkout.branch(),
            checkout_head: Some(&self.head),
            pr: None,
            discovered_skill: None,
            model: "fixture",
            lanes: &crate::prompt::LaneContext::default(),
            dependencies: &crate::DependencyStatus::default(),
            command: std::path::Path::new("/engine"),
            ticket: std::path::Path::new("/scratch/ticket"),
        }
        .render()
        .text;
        assert!(prompt.contains("Report-only delivery"));
        assert!(prompt.contains("lane.put 'local-fixture' 'qa' VERSION --ticket"));
        assert!(prompt.contains("report_ready"));
        assert!(!prompt.contains("Ready for review"));
        if let Some(instruction) = task
            .report_task()
            .and_then(|report| report.instruction.as_deref())
        {
            assert!(prompt.contains(instruction));
        }
        let credential = task
            .reserve_launch(
                &observation,
                LaunchInputs {
                    scratch: None,
                    thread: WORKER.into(),
                    started_at: 1,
                    input: prompt,
                },
                &[42; 32],
            )
            .expect("worker launch");
        let instance = task.run().expect("run").launch().instance.clone();
        task.record_send(&instance, 2).expect("send recorded");
        self.service
            .save(&prior, task, &event("fixture_run"))
            .await
            .expect("save run");
        ReportTurn {
            instance,
            credential,
        }
    }

    async fn settle(&self, turn: &ReportTurn) -> nucleus_store::TaskRow {
        let prior = self.service.task(TASK).await.expect("reported");
        let mut task = prior.task.clone();
        assert_eq!(
            task.reconcile(&Observation {
                host: Observed::Known(Host::Current {
                    instance: turn.instance.clone(),
                    state: RunState::Ended
                }),
                forge: Observed::Unknown,
                workspace: Observed::Known(Workspace::Clean(self.head.clone())),
            }),
            Action::Advance(Phase::ReportReady)
        );
        self.service
            .save(&prior, task, &event("fixture_settled"))
            .await
            .expect("report ready")
    }

    async fn write(&self, turn: &ReportTurn, version: u64, document: &str) -> Value {
        let response = put_as(
            &self.api,
            &turn.lane("qa"),
            turn.key(),
            &json!({"version":version,"document":document}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        json_body(response).await
    }

    async fn planner_write(&self, document: &str, version: u64) {
        let response = put_as(
            &self.api,
            &format!("/v1/planning/{PROJECT}/lanes/qa"),
            &BOARD_KEY,
            &json!({
                "version":version, "title":"qa", "aim":"qualification", "document":document,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    async fn command(&self, command: Value) -> Response {
        post_as(
            &self.api,
            &format!("/v1/tasks/{TASK}/commands"),
            &BOARD_KEY,
            &command,
        )
        .await
    }
}

impl Drop for ReportFixture {
    fn drop(&mut self) {
        self.forge.abort();
        self.host.abort();
    }
}

struct ReportTurn {
    instance: String,
    credential: CallbackCredential,
}

impl ReportTurn {
    fn key(&self) -> &[u8; 32] {
        self.credential.as_bytes()
    }

    fn callback(&self) -> String {
        format!("/v1/runs/{TASK}/{}/report", self.instance)
    }

    fn lane(&self, key: &str) -> String {
        format!("/v1/runs/{TASK}/{}/lanes/{PROJECT}/{key}", self.instance)
    }

    fn report(artifact: &Value, head: &Head) -> Value {
        json!({"report_ready":{"artifact":artifact,"summary":"Qualification settled.","head":head}})
    }
}
