use std::{collections::BTreeMap, path::Path, sync::Mutex as SyncMutex, time::Duration};

use nucleus_core::{Head, Observation, Report, ReportArtifact, ReportDelivery, Workspace};
use nucleus_hosts::HostError;

use super::*;
use crate::{
    pass::DispatchTarget,
    tests::{git, native_fixture},
};

const ALPHA_REPO: &str = REPOSITORY;
const BETA_REPO: &str = "example/second";
const PROJECTS: &str = "/v1/settings/projects";
const T3_KEY: [u8; 32] = [8; 32];
const TELL: &str = "/v1/planning/tell";

#[derive(Default)]
pub(super) struct NoticeFixture {
    pub(super) sends: Vec<Value>,
    controls: Vec<Value>,
    started: bool,
    pub(super) next_reply: NoticeReply,
    settled: bool,
    uncertain_planner: bool,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum NoticeReply {
    #[default]
    Accepted,
    Rejected,
    WrongCommand,
    Lost,
    Uncertain,
}

impl NoticeFixture {
    fn thread_snapshot(&self, id: &str, archived: bool) -> Value {
        let project = match id {
            "beta-planner" => "beta-native",
            "missing-root" => "missing-native",
            _ => "alpha-native",
        };
        let (messages, runs) = self.projection(id);
        json!({"kind": "snapshot", "snapshotSequence": 16, "projection": {"thread": {
            "id": id, "projectId": project,
            "archivedAt": (id == "closed" || id == "alpha-planner" && archived).then_some("2026-11-23T18:10:00Z"),
            "parentThreadId": (id == "child").then_some("parent"),
            "providerInstanceId": (id == "task-session").then_some("fixture-acp"),
            "settledAt": self.settled.then_some("2026-11-23T18:10:00Z"),
        }, "messages": messages, "runs": runs}})
    }

    fn projection(&self, id: &str) -> (Value, Value) {
        let message = self
            .sends
            .iter()
            .rev()
            .find(|send| send["threadId"] == id && send["accepted"] == true);
        if self.started
            && let Some(message) = message
        {
            let id = &message["messageId"];
            (
                json!([{"id": id, "runId": "notice-run"}]),
                json!([{"id": "notice-run", "userMessageId": id, "status": "running", "startedAt": "2026-11-24T10:00:00Z"}]),
            )
        } else {
            (
                json!(
                    message
                        .map(|send| json!({"id": send["messageId"]}))
                        .into_iter()
                        .collect::<Vec<_>>()
                ),
                json!([]),
            )
        }
    }

    pub(super) fn dispatch(&mut self, request: &Value) -> Value {
        let mut payload = request["payload"].clone();
        let reply = if payload["type"] == "thread.unsettle" {
            self.controls.push(payload);
            self.settled = false;
            json!({"_tag": "Success", "value": {"sequence": 17}})
        } else {
            assert_eq!(payload["type"], "message.dispatch");
            let reply = std::mem::take(&mut self.next_reply);
            payload["accepted"] = json!(matches!(reply, NoticeReply::Accepted | NoticeReply::Lost));
            if reply == NoticeReply::Lost {
                self.sends.push(payload);
                // The native host accepted the write, then the connection dropped.
                return Value::Null;
            }
            if reply == NoticeReply::Accepted {
                self.sends.push(payload);
                json!({"_tag": "Success", "value": {"sequence": 17}})
            } else {
                let command = if reply == NoticeReply::WrongCommand {
                    json!("another-command")
                } else {
                    payload["commandId"].clone()
                };
                self.sends.push(payload);
                json!({"_tag": "Failure", "cause": [{"_tag": "Fail", "error": {
                    "_tag": "OrchestrationV2DispatchCommandError",
                    "commandId": command, "commandType": "message.dispatch",
                    "cause": {
                        "name": if matches!(reply, NoticeReply::Rejected | NoticeReply::WrongCommand) {
                            "OrchestratorCommandPreviouslyRejectedError"
                        } else { "UnknownError" },
                        "commandId": command, "commandType": "message.dispatch",
                        "message": format!("Command {} was previously rejected: fixture", command.as_str().expect("command"))
                    }
                }}]})
            }
        };
        json!({"_tag": "Exit", "requestId": request["id"], "exit": reply})
    }
}

struct Registry {
    home: tempfile::TempDir,
    service: Arc<Service>,
    api: Router,
    reads: Arc<AtomicUsize>,
    read_started: Arc<tokio::sync::Notify>,
    moved: Arc<AtomicBool>,
    archived: Arc<AtomicBool>,
    notices: Arc<SyncMutex<NoticeFixture>>,
    _native: NativeServer,
}

struct NativeServer(tokio::task::JoinHandle<()>);

impl Drop for NativeServer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Registry {
    fn reopen(self) -> Self {
        let Self {
            service,
            api,
            home,
            reads,
            read_started,
            moved,
            archived,
            notices,
            _native: native,
        } = self;
        drop(api);
        let (settings, host) = {
            let previous = Arc::try_unwrap(service)
                .ok()
                .expect("no other service owners");
            (previous.settings, previous.host)
        };
        let service = registry_service(&settings, host);
        let api = registry_api(&service);
        Self {
            home,
            service,
            api,
            reads,
            read_started,
            moved,
            archived,
            notices,
            _native: native,
        }
    }

    async fn enroll(&self, actor: &str) {
        self.start_contact(actor).await;
        self.service.complete_enrollment(actor).await;
    }

    async fn start_contact(&self, actor: &str) {
        let mut state = self.service.state.lock().await;
        assert!(matches!(
            self.service.request_enrollment(&mut state, actor),
            ServiceError::PlannerEnrollmentPending(_)
        ));
        drop(state);
        self.take_requested(actor).await;
    }

    async fn inline_command<F: std::future::Future>(&self, actor: &str, command: F) -> F::Output {
        tokio::pin!(command);
        // Poll the request until it queues proof. Complete the real checkout and
        // host proof before polling the request again, even on a loaded runner.
        tokio::select! {
            biased;
            () = self.service.enrollment_wake.notified() => {}
            _ = &mut command => panic!("cold request completed before it queued enrollment"),
        }
        self.take_requested(actor).await;
        self.service.complete_enrollment(actor).await;
        command.await
    }

    async fn finish_requested(&self, actor: &str) {
        self.service.enrollment_wake.notified().await;
        self.take_requested(actor).await;
        self.service.complete_enrollment(actor).await;
    }

    async fn take_requested(&self, actor: &str) {
        let requested = self
            .service
            .take_enrollment()
            .await
            .expect("one queued proof");
        assert_eq!(requested, actor);
        assert!(self.service.take_enrollment().await.is_none());
    }

    async fn task(&self, actor: &str, id: &str) -> Task {
        assert_eq!(
            submit(&self.api, actor, id, None).await.status(),
            StatusCode::CREATED
        );
        self.service.task(id).await.expect("admitted task").task
    }

    async fn tell(&self, actor: &str, to: Value, text: &str) -> Response {
        caller_request(
            &self.api,
            Method::POST,
            TELL,
            actor,
            json!({"to": to, "text": text}),
        )
        .await
    }

    async fn advance_tell(&self) -> Result<(), ServiceError> {
        let row = self
            .service
            .state
            .lock()
            .await
            .store
            .next_tell()?
            .expect("queued notice");
        self.service.advance_tell(&row).await
    }
}

async fn registry() -> Registry {
    registry_with_options(BETA_REPO, false).await
}

async fn registry_with_options(beta_repo: &str, imported: bool) -> Registry {
    let (home, legacy) = fixture(GitHub::new("fixture").expect("client"));
    let alpha_path = legacy.fixture().checkout.clone();
    let beta_path = alpha_path.with_file_name("second");
    create_repository(&beta_path, "trunk", beta_repo);
    set_default(&alpha_path, "main");
    set_default(&beta_path, "trunk");
    let settings = legacy.settings.clone();
    drop(legacy);
    if imported {
        seed_imported_container(&settings);
    }

    let reads = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&reads);
    let read_started = Arc::new(tokio::sync::Notify::new());
    let signal = Arc::clone(&read_started);
    let moved = Arc::new(AtomicBool::new(false));
    let moved_root = Arc::clone(&moved);
    let missing = alpha_path.with_file_name("missing");
    let snapshot = json!({"projects": [
        {"id": "alpha-native", "workspaceRoot": alpha_path, "title": "Exact T3 Alpha"},
        {"id": "beta-native", "workspaceRoot": beta_path},
        {"id": "missing-native", "workspaceRoot": missing},
    ], "threads": []});
    let archived = Arc::new(AtomicBool::new(false));
    let closed = Arc::clone(&archived);
    let notices = Arc::new(SyncMutex::new(NoticeFixture::default()));
    let delivery = Arc::clone(&notices);
    let (host, native) = native_fixture(move |request| {
        observed.fetch_add(1, Ordering::Relaxed);
        let mut notices = delivery.lock().expect("native notice fixture");
        let snapshot = match request["tag"].as_str() {
            Some("orchestration.subscribeThread") => {
                signal.notify_one();
                let id = request["payload"]["threadId"].as_str().expect("exact ID");
                if id == "alpha-planner" && notices.uncertain_planner {
                    return json!({"_tag":"Exit", "requestId":request["id"], "exit":{
                        "_tag":"Failure", "cause":[{"_tag":"Fail", "error":{"_tag":"ReadUnavailable"}}]
                    }});
                }
                notices.thread_snapshot(id, closed.load(Ordering::Relaxed))
            }
            Some("orchestration.subscribeShell") => {
                let alpha = if moved_root.load(Ordering::Relaxed) {
                    &beta_path
                } else {
                    &alpha_path
                };
                json!({"kind": "snapshot", "snapshot": {"projects": [
                    {"id": "alpha-native", "workspaceRoot": alpha, "title": "Exact T3 Alpha"},
                    {"id": "beta-native", "workspaceRoot": beta_path},
                    {"id": "missing-native", "workspaceRoot": missing},
                ]}})
            }
            Some("orchestration.dispatchCommand") => return notices.dispatch(request),
            _ => panic!("unexpected T3 call"),
        };
        json!({"_tag": "Chunk", "requestId": request["id"], "values": [
            snapshot, {"kind": "synchronized"},
        ]})
    })
    .await;
    host.fixture_project_shell(&snapshot, "fixture-acp");
    let service = registry_service(&settings, host);
    let api = registry_api(&service);
    Registry {
        home,
        service,
        api,
        reads,
        read_started,
        moved,
        archived,
        notices,
        _native: NativeServer(native),
    }
}

fn registry_service(settings: &nucleus_store::SettingsFile, host: T3) -> Arc<Service> {
    Arc::new(
        Service::open_projects(
            settings,
            "fixture-acp".into(),
            host,
            GitHub::new("fixture").expect("client"),
            LOCAL_HOST.parse().expect("loopback"),
            std::env::current_exe().expect("test binary"),
        )
        .expect("start registry service"),
    )
}

fn registry_api(service: &Arc<Service>) -> Router {
    router_with_t3_callers(
        Arc::clone(service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "fixture-operator".into(),
            },
        }],
        Some(T3_KEY),
    )
}

fn registry_board_api(registry: &Registry) -> Router {
    let assets = registry.home.path().join("board");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "").unwrap();
    std::fs::write(assets.join("app.js"), "").unwrap();
    crate::router_with_board_and_t3_callers(
        Arc::clone(&registry.service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "fixture-operator".into(),
            },
        }],
        &assets,
        Some(T3_KEY),
    )
    .unwrap()
}

fn seed_imported_container(settings: &nucleus_store::SettingsFile) {
    let projects = nucleus_store::Projects {
        projects: BTreeMap::from([(
            "product".into(),
            nucleus_store::ProjectSettings {
                planner_claim: None,
                name: "Imported product".into(),
                archived: false,
                repositories: [ALPHA_REPO, BETA_REPO]
                    .into_iter()
                    .map(|origin| nucleus_store::RepositorySettings {
                        origin: origin.into(),
                        path: Path::new("/synthetic/legacy").into(),
                        base: "main".into(),
                        host_project: None,
                        host_project_title: None,
                        planner_threads: Vec::new(),
                        required_checks: Vec::new(),
                        hung_tool_minutes: 30,
                    })
                    .collect(),
            },
        )]),
        ..Default::default()
    };
    let revision = settings
        .read::<nucleus_store::Projects>()
        .expect("project settings")
        .revision;
    settings
        .edit(&revision, |value| {
            *value = projects;
            Ok(())
        })
        .expect("imported project container");
    let dispatch = settings
        .read::<nucleus_store::DispatchSettings>()
        .expect("dispatch settings");
    settings
        .edit::<nucleus_store::DispatchSettings>(&dispatch.revision, |value| {
            value.project_slot_overrides.insert("product".into(), 1);
            Ok(())
        })
        .expect("one shared project slot");
}

fn create_repository(path: &Path, base: &str, origin: &str) {
    std::fs::create_dir(path).expect("synthetic repository root");
    git(path, &["init", "-b", base]);
    git(
        path,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
    );
    git(
        path,
        &[
            "remote",
            "add",
            "origin",
            &format!("https://github.com/{origin}.git"),
        ],
    );
}

fn set_default(path: &Path, base: &str) {
    git(
        path,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            &format!("refs/remotes/origin/{base}"),
        ],
    );
}

async fn caller_request(
    api: &Router,
    method: Method,
    path: &str,
    actor: &str,
    body: Value,
) -> Response {
    api.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header(HOST, LOCAL_HOST)
                .header(AUTHORIZATION, format!("Bearer {}", hex::encode(T3_KEY)))
                .header("x-nucleus-t3-caller", actor)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .expect("caller request"),
        )
        .await
        .expect("response")
}

async fn submit(api: &Router, actor: &str, id: &str, repo: Option<&str>) -> Response {
    caller_request(
        api,
        Method::POST,
        "/v1/planning/tasks",
        actor,
        json!({
            "id": id, "reference": id, "brief": "---\nqueue:\n  complexity: low\n---\nUse the synthetic repository.", "repository": repo,
        }),
    )
    .await
}

#[tokio::test]
async fn first_contact_enrolls_two_exact_routes_inline_and_scoped_reads() {
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
    assert_eq!(
        submit(api, "alpha-planner", "cross-project", Some(BETA_REPO))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let owned = json_body(
        caller_request(api, Method::GET, "/v1/tasks", "alpha-planner", Value::Null).await,
    )
    .await;
    assert_eq!(owned.as_array().expect("Alpha's tasks").len(), 1);
    assert_eq!(owned[0]["identity"]["id"], "first");
    for (method, url) in [
        (Method::GET, "/v1/tasks/second"),
        (Method::POST, "/v1/tasks/second/commands"),
    ] {
        assert_eq!(
            caller_request(api, method, url, "alpha-planner", json!("cancel"))
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }
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
        "Nucleus is verifying this T3 planner and repository. Retry shortly."
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

    registry.enroll("beta-planner").await;
    let other = "/v1/planning-current/items?project=second";
    let forbidden = read(other).await;
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        json_body(forbidden).await["error"],
        ServiceError::ControllerProject.to_string()
    );
    assert_eq!(
        json_body(get_as(api, other, &BOARD_KEY).await).await,
        json!([])
    );
    assert_eq!(
        get_as(api, ITEMS, &BOARD_KEY).await.status(),
        StatusCode::BAD_REQUEST
    );
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
}

#[tokio::test]
async fn colliding_repository_names_require_the_owner_and_preserve_planner_scope() {
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
    assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn public_task_references_follow_the_authenticated_project_scope() {
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
    for path in ["/v1/tasks/nucleus-fixture%23001", "/v1/tasks/%231"] {
        assert_eq!(json_body(read(path).await).await, detail);
    }
    for (by_id, by_reference) in [
        ("/v1/tasks/first/next", "/v1/tasks/nucleus-fixture%231/next"),
        (
            "/v1/tasks/first/history",
            "/v1/tasks/nucleus-fixture%231/history",
        ),
    ] {
        assert_eq!(
            json_body(read(by_reference).await).await,
            json_body(read(by_id).await).await
        );
    }
    for path in [
        "/v1/tasks/nucleus-fixture%2399",
        "/v1/tasks/example%2Fnucleus-fixture%231",
    ] {
        let response = read(path).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            json_body(response).await["error"],
            "task reference was not found"
        );
    }
    let ambiguous = get_as(api, "/v1/tasks/nucleus-fixture%231", &BOARD_KEY).await;
    assert_eq!(ambiguous.status(), StatusCode::BAD_REQUEST);
    assert!(
        json_body(ambiguous).await["error"]
            .as_str()
            .expect("error")
            .contains("ambiguous")
    );
    let qualified = "/v1/tasks/inflatable-cookie%2Fnucleus-fixture%231";
    assert_eq!(
        json_body(get_as(api, qualified, &BOARD_KEY).await).await,
        detail
    );
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
async fn paired_board_reports_the_same_planner_scope_as_planning_routes() {
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
    assert_eq!(planner_view["planningProjects"], json!([alpha]));
    assert_ne!(operator_view["id"], planner_view["id"]);
    assert_eq!(
        planner_view,
        json_body(read("/api/engine/session", &planner).await).await
    );
    for collection in ["plan", "items", "decisions"] {
        let allowed = format!("/api/engine/planning/{alpha}/{collection}");
        let restricted = format!("/api/engine/planning/{beta}/{collection}");
        assert_eq!(
            browser_request(&api, Method::GET, &allowed, Some(&planner), None)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            browser_request(&api, Method::GET, &restricted, Some(&planner), None)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            browser_request(&api, Method::GET, &restricted, Some(&operator), None)
                .await
                .status(),
            StatusCode::OK
        );
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

async fn assert_workspace_limit(registry: &Registry, tasks: [&Task; 2]) {
    let service = &registry.service;
    let worktrees = service.worktrees().expect("synthetic worktree root");
    for task in tasks {
        let identity = task.identity();
        let route = service.project_for(identity).await.expect("member route");
        let head = service
            .verify_route(identity, &route)
            .await
            .expect("base head");
        worktrees
            .checkout(&route.checkout, &identity.repository, &identity.id)
            .expect("member checkout")
            .allocate(&head)
            .expect("allocate candidate");
    }
    service
        .state
        .lock()
        .await
        .schedule
        .park(&tasks[0].identity().id);
    let waiting = service.task("explicit-member").await.expect("third task");
    let identity = waiting.task.identity();
    let route = service.project_for(identity).await.expect("same project");
    assert!(
        !service
            .workspace_capacity(identity, &route, 1)
            .await
            .expect("two in flight")
    );
    assert!(
        service
            .workspace_capacity(identity, &route, 2)
            .await
            .expect("room under four")
    );
    let released = tasks[1].identity();
    let member = service.project_for(released).await.expect("member route");
    let head = service
        .verify_route(released, &member)
        .await
        .expect("base head");
    assert!(matches!(
        worktrees
            .checkout(&member.checkout, &released.repository, &released.id)
            .expect("member checkout")
            .retire(&head)
            .expect("retire the fixture checkout"),
        nucleus_work::Retirement::Removed
    ));
    assert!(
        service
            .workspace_capacity(identity, &route, 1)
            .await
            .expect("retiring an owned checkout frees workspace capacity")
    );
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
    let add = json!({"kind":"lead", "title":"Fixture idea", "lanes":[],
        "body":"---\nqueue:\n  complexity: low\n---\nUse the selected repository."});
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
    let retried = promote().await;
    assert_eq!(retried.status(), StatusCode::OK);
    let retried = json_body(retried).await;
    assert_eq!(retried["identity"]["id"], created["identity"]["id"]);
    assert_eq!(retried["reference"], "second#1");

    let added = caller_request(
        &api,
        Method::POST,
        "/v1/planning/product/items",
        "alpha-planner",
        add,
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    let item = json_body(added).await;
    let id = item["id"].as_str().unwrap();
    let promoted = caller_request(
        &api,
        Method::POST,
        &format!("/v1/planning/product/items/{id}/promote"),
        "alpha-planner",
        selected,
    )
    .await;
    assert_eq!(promoted.status(), StatusCode::CREATED);
    let promoted = json_body(promoted).await;
    assert_eq!(promoted["identity"]["repository"], BETA_REPO);
    assert_eq!(promoted["reference"], "second#2");
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
    let archived = nucleus_hosts::ThreadHint::fixture(&json!({
        "kind": "thread.removed", "threadId": "alpha-planner",
    }))
    .expect("archive event");
    registry.service.wake_from_host(archived).await;
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

async fn seed_ready_report(service: &Service, id: &str, legacy_attempt: bool) {
    let mut state = service.state.lock().await;
    let (project, repo) = state
        .settings
        .planner_route("alpha-planner")
        .expect("registered route");
    let head: Head = git(&repo.path, &["rev-parse", "HEAD"])
        .parse()
        .expect("planning head");
    let mut task = Task::new_report_only(
        nucleus_core::Identity {
            id: id.into(),
            reference: id.into(),
            repository: repo.origin.clone(),
            base: repo.base.clone(),
            entry: Entry::Brief,
            origin_thread: Some("alpha-planner".into()),
        },
        "Qualify the fixture".into(),
        project.into(),
        "qa".into(),
        head.clone(),
    );
    let mut observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(Workspace::Clean(head.clone())),
    };
    task.reconcile(&observation);
    let credential = task
        .reserve_launch(
            &observation,
            LaunchInputs {
                scratch: None,
                thread: "report-worker".into(),
                started_at: 1,
                input: "fixture".into(),
            },
            &[4; 32],
        )
        .expect("worker launch");
    let instance = task.run().expect("worker").launch().instance.clone();
    task.record_send(&instance, 2).expect("record worker send");
    task.record_report(
        &instance,
        credential.as_bytes(),
        Report::ReportReady(ReportDelivery {
            artifact: ReportArtifact {
                key: "qa".into(),
                version: 3,
                digest: "a".repeat(64),
            },
            headline: None,
            summary: "Synthetic qualification passed".into(),
            head: Some(head),
        }),
    )
    .expect("worker report");
    observation.host = Observed::Known(Host::Current {
        instance,
        state: RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::ReportReady)
    );
    let kind = if legacy_attempt {
        task.mark_report_notice_attempted();
        "report_ready_planner_unavailable"
    } else {
        "report_ready"
    };
    state
        .store
        .create(&task, &event(kind))
        .expect("report ready row");
}

async fn notice_pass(service: &Service, task: &str) -> Vec<crate::PassOutcome> {
    {
        let mut state = service.state.lock().await;
        let crate::State {
            store,
            schedule,
            capacity_waiters,
            ..
        } = &mut *state;
        let now = tokio::time::Instant::now();
        // Cold fixtures discover persisted notices through the ordinary scheduler scan.
        schedule
            .seed(
                store,
                now,
                service.acp_provider().is_some(),
                capacity_waiters,
            )
            .expect("seed the notice schedule");
        assert!(
            schedule.due(task).is_some_and(|due| due <= now),
            "notice for {task} is not due"
        );
    }
    service.pass().await.expect("scheduler pass")
}

#[derive(Clone, Copy)]
enum TaskNotice {
    Report,
    Prerequisite,
}

impl TaskNotice {
    async fn fixture(self) -> Registry {
        let registry = registry().await;
        registry.enroll("alpha-planner").await;
        registry.enroll("next-planner").await;
        seed_ready_report(
            &registry.service,
            "notice",
            matches!(self, Self::Prerequisite),
        )
        .await;
        if matches!(self, Self::Prerequisite) {
            let mut state = registry.service.state.lock().await;
            let mut identity = state
                .store
                .row("notice")
                .unwrap()
                .unwrap()
                .task
                .identity()
                .clone();
            "finished".clone_into(&mut identity.id);
            "finished".clone_into(&mut identity.reference);
            let mut completed =
                serde_json::to_value(Task::new(identity, "Fixture".into(), None)).unwrap();
            completed["phase"] = json!("done");
            state
                .store
                .create(
                    &serde_json::from_value(completed).unwrap(),
                    &event("fixture"),
                )
                .unwrap();
            drop(state);
            release_notice(&registry).await;
        }
        registry.reopen()
    }

    async fn pending(self, service: &Service) -> bool {
        match self {
            Self::Report => {
                !service
                    .task("notice")
                    .await
                    .unwrap()
                    .task
                    .report_task()
                    .unwrap()
                    .notice_attempted
            }
            Self::Prerequisite => service
                .state
                .lock()
                .await
                .store
                .pending_prerequisite_notice("notice")
                .unwrap()
                .is_some(),
        }
    }
}

async fn release_notice(registry: &Registry) {
    let row = registry.service.task("notice").await.unwrap();
    assert_eq!(
        post_json(
            &registry.api,
            "/v1/tasks/notice/commands",
            &BOARD_KEY,
            &json!({"set_prerequisite_wait": {
                "version": row.version, "waits_for": ["finished"], "reason": "Frozen fixture reason"
            }}),
        )
        .await,
        StatusCode::OK
    );
    let parked = registry.service.task("notice").await.unwrap();
    assert!(
        registry
            .service
            .reconcile_prerequisites(&parked)
            .await
            .unwrap()
    );
}

async fn assert_idle_notice(registry: &Registry) {
    let service = &registry.service;
    let prior = service.task("notice").await.unwrap();
    let history = service.history("notice", None, 30).await.unwrap();
    let calls = registry.reads.load(Ordering::Relaxed);
    assert_eq!(
        service.notify_report_ready(&prior).await.unwrap(),
        Action::Nothing
    );
    assert!(!service.notify_prerequisite_release(&prior).await.unwrap());
    assert_eq!(registry.reads.load(Ordering::Relaxed), calls);
    assert_eq!(service.task("notice").await.unwrap(), prior);
    assert_eq!(service.history("notice", None, 30).await.unwrap(), history);
}

async fn advance_task_notice(registry: &Registry) -> Result<Action, ServiceError> {
    notice_pass(&registry.service, "notice")
        .await
        .into_iter()
        .find(|outcome| outcome.task == "notice")
        .expect("the scheduler processed the notice")
        .result
}

#[tokio::test]
async fn exact_task_notice_rejection_allows_one_fresh_attempt_after_restart() {
    for kind in [TaskNotice::Report, TaskNotice::Prerequisite] {
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
    for kind in [TaskNotice::Report, TaskNotice::Prerequisite] {
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
            assert!(text.contains(&alpha));
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
async fn project_tell_refuses_unverified_and_ambiguous_requests_without_host_reads() {
    let registry = registry().await;
    let actor = "alpha-planner";
    let reads = registry.reads.load(Ordering::Relaxed);
    let unverified = registry.tell(actor, json!("all"), "test").await;
    assert_eq!(unverified.status(), StatusCode::FORBIDDEN);
    assert_eq!(registry.reads.load(Ordering::Relaxed), reads);
    assert!(registry.service.take_enrollment().await.is_none());
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
    let (response, ()) = tokio::join!(biased; send(), async {
        assert!(registry.service.state.lock().await.store.next_tell().unwrap().is_none());
        registry.finish_requested("alpha-planner").await;
    });
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
    let worktrees = service.worktrees().expect("worktree root");
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

fn push_origin(path: &Path, repository: &str) {
    git(
        path,
        &[
            "remote",
            "set-url",
            "--push",
            "origin",
            &format!("https://github.com/{repository}.git"),
        ],
    );
}

fn run_target<'a>(
    tree: &'a nucleus_work::Checkout<'a>,
    binding: &'a nucleus_hosts::Binding,
) -> DispatchTarget<'a> {
    DispatchTarget::Run {
        checkout: tree,
        frozen: binding,
        launch: false,
    }
}

fn occupy_slot(task: &mut Task, head: &nucleus_core::Head) {
    let observation = Observation {
        forge: Observed::Known(Forge::Absent),
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Clean(head.clone())),
    };
    let _ = task.reconcile(&observation);
    task.reserve_launch(
        &observation,
        LaunchInputs {
            scratch: None,
            thread: "fixture-worker".into(),
            started_at: 1,
            input: "fixture-only wire".into(),
        },
        &[3; 32],
    )
    .expect("reserve occupied task");
    let instance = task.run().expect("run").launch().instance.clone();
    task.record_send(&instance, 1).expect("occupy slot");
}

async fn assert_project_slots(registry: &Registry, beta: &Task) {
    let setting = "/v1/settings/dispatch";
    let dispatch = json_body(get_as(&registry.api, setting, &BOARD_KEY).await).await;
    let mut value = dispatch["value"].clone();
    value["globalSlots"] = json!(2);
    value["projectDefaultSlots"] = json!(1);
    assert_eq!(
        put_settings(
            &registry.api,
            setting,
            &BOARD_KEY,
            &json!({
                "revision": dispatch["revision"], "value": value,
            })
        )
        .await
        .status(),
        StatusCode::OK
    );
    let mut waiting = registry
        .service
        .task("first")
        .await
        .expect("first")
        .task
        .identity()
        .clone();
    waiting.id = "other-first".into();
    assert!(
        !registry
            .service
            .launch_capacity(&waiting, false)
            .await
            .expect("Alpha full")
    );
    assert!(
        registry
            .service
            .launch_capacity(beta.identity(), false)
            .await
            .expect("Beta has capacity")
    );
    let project = registry
        .service
        .project_for(&waiting)
        .await
        .expect("Alpha route")
        .project_id
        .expect("Alpha project");
    for (global, overrides, alpha_allowed, beta_allowed) in [
        (2, json!({&project: 2}), true, true),
        (2, json!({}), false, true),
        (1, json!({&project: 2}), false, false),
    ] {
        let current = json_body(get_as(&registry.api, setting, &BOARD_KEY).await).await;
        let mut value = current["value"].clone();
        value["globalSlots"] = json!(global);
        value["projectSlotOverrides"] = overrides;
        assert_eq!(
            put_settings(
                &registry.api,
                setting,
                &BOARD_KEY,
                &json!({
                    "revision": current["revision"], "value": value,
                })
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            registry
                .service
                .launch_capacity(&waiting, false)
                .await
                .expect("Alpha capacity"),
            alpha_allowed
        );
        assert_eq!(
            registry
                .service
                .launch_capacity(beta.identity(), false)
                .await
                .expect("Beta capacity"),
            beta_allowed
        );
    }
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

async fn assert_retirement_history(registry: &Registry, task_path: &str) {
    let response = get_as(&registry.api, &format!("{task_path}/history"), &BOARD_KEY).await;
    assert_eq!(response.status(), StatusCode::OK);
    let history = json_body(response).await;
    let mut kinds = history
        .as_array()
        .unwrap()
        .iter()
        .map(|event| &event["content"]["kind"]);
    assert_eq!(kinds.next(), Some(&json!("project_removed")));
    assert_eq!(kinds.next(), Some(&json!("fixture_finished")));
    assert!(kinds.all(|kind| kind != "project_removed"));
}

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

fn terminal_removal_worker(registry: &Registry, task: &Task, active: bool) {
    let checkout = nucleus_work::checkout_path(
        registry.service.storage.work().path(),
        &task.identity().repository,
        &task.identity().id,
    );
    registry.service.host.fixture_project_shell(
        &json!({"projects": [], "threads": [{
            "id": "fixture-worker", "worktreePath": checkout,
            "status": if active { "running" } else { "completed" },
            "activeRunId": active.then_some("active-worker"),
            "pendingBackgroundTasks": [],
        }]}),
        "fixture-acp",
    );
}

#[tokio::test]
async fn project_removal_recreates_the_same_project_after_pending_cleanup() {
    assert_removal_restoration(None).await;
}

#[tokio::test]
async fn project_removal_restores_an_origin_under_a_different_project() {
    assert_removal_restoration(Some("restored-project")).await;
}

async fn assert_removal_restoration(destination: Option<&str>) {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.task("alpha-planner", "old-task").await;
    finish_removal_task(&registry, "old-task", None).await;
    let prior_age = restored_task_board_age(&registry).await;
    assert!(prior_age[0].is_some());

    let before = removal_settings(&registry);
    let (old_id, original) = before.value.projects.iter().next().unwrap();
    let mut restored = original.clone();
    let repo = restored.repositories.first_mut().unwrap();
    repo.host_project = None;
    repo.host_project_title = None;
    repo.planner_threads.clear();
    let new_id = destination.unwrap_or(old_id);
    let removal = format!("{PROJECTS}/{old_id}/removal");
    seed_removal_planning(&registry, old_id).await;
    let preview = json_body(get_as(&registry.api, &removal, &BOARD_KEY).await).await;
    let confirmation = json!({"digest":preview["digest"],"reason":"retired test project"});
    let expected = seed_pending_project_removal(&registry, &before, old_id, &confirmation);
    assert_eq!(
        put_restored_project(&registry, new_id, &restored)
            .await
            .status(),
        StatusCode::CONFLICT,
        "the pending receipt must fence re-add",
    );

    let registry = registry.reopen();
    assert!(!removal_settings(&registry).value.removed[old_id].cleanup_pending);
    assert_eq!(
        registry
            .service
            .state
            .lock()
            .await
            .store
            .plan(old_id)
            .unwrap()
            .version,
        0
    );
    assert_eq!(
        put_restored_project(&registry, new_id, &restored)
            .await
            .status(),
        StatusCode::OK
    );
    assert!(!removal_settings(&registry).value.removed_origin(ALPHA_REPO));
    seed_removal_planning(&registry, new_id).await;

    let registry = registry.reopen();
    assert_eq!(
        json_body(post_as(&registry.api, &removal, &BOARD_KEY, &confirmation).await).await,
        expected,
        "an old exact receipt is replayable after re-add",
    );
    assert_eq!(restored_task_board_age(&registry).await, prior_age);
    assert_eq!(
        registry
            .service
            .state
            .lock()
            .await
            .store
            .plan(new_id)
            .unwrap()
            .version,
        1
    );
    registry.enroll("alpha-planner").await;
    registry.task("alpha-planner", "new-task").await;
    finish_removal_task(&registry, "new-task", None).await;
    let operator = Authority::Operator {
        actor: "fixture".into(),
    };
    assert!(matches!(
        registry
            .service
            .command("old-task", &operator, Command::Move(Phase::Working))
            .await,
        Err(ServiceError::Project),
    ));
    assert!(
        registry
            .service
            .command("new-task", &operator, Command::Move(Phase::Working))
            .await
            .is_ok()
    );
}

async fn restored_task_board_age(registry: &Registry) -> [Option<u64>; 4] {
    let api = registry_board_api(registry);
    let cookie = pair_board(&api, &BOARD_KEY).await;
    let tasks = read_paired_task(&api, "/api/engine/tasks", &cookie).await;
    let task = tasks
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["identity"]["id"] == "old-task")
        .expect("finished history is visible on the board after re-add");
    let latest = task["latestEventAtMs"].as_u64();
    let since = task["stateSinceMs"].as_u64();
    let admitted = task["lifecycle"]["admittedAtMs"].as_u64();
    [latest, since, admitted, latest.or(since).or(admitted)]
}

fn removal_settings(
    registry: &Registry,
) -> nucleus_store::SettingsSnapshot<nucleus_store::Projects> {
    registry.service.settings.read().unwrap()
}

fn seed_pending_project_removal(
    registry: &Registry,
    before: &nucleus_store::SettingsSnapshot<nucleus_store::Projects>,
    old_id: &str,
    confirmation: &Value,
) -> Value {
    let repo = &before.value.projects[old_id].repositories[0];
    let expected =
        json!({"repositories":[{"origin":repo.origin,"path":repo.path}],"removedAtMs":42});
    registry
        .service
        .settings
        .edit(
            &before.revision,
            |projects: &mut nucleus_store::Projects| {
                projects.projects.remove(old_id);
                projects.removed.insert(
                    old_id.into(),
                    serde_json::from_value(json!({
                        "repositories": expected["repositories"],
                        "blockedOrigins": [ALPHA_REPO.to_ascii_lowercase()],
                        "cleanupPending": true,
                        "digest": confirmation["digest"],
                        "reason": confirmation["reason"],
                        "removedAtMs": expected["removedAtMs"],
                    }))
                    .unwrap(),
                );
                Ok(())
            },
        )
        .unwrap();
    expected
}

async fn put_restored_project(
    registry: &Registry,
    id: &str,
    project: &nucleus_store::ProjectSettings,
) -> Response {
    let snapshot = removal_settings(registry);
    let mut projects = snapshot.value.projects;
    projects.insert(id.into(), project.clone());
    planning::put_as(
        &registry.api,
        PROJECTS,
        &BOARD_KEY,
        &json!({"revision":snapshot.revision,"value":{"projects":projects}}),
    )
    .await
}

async fn finish_removal_task(registry: &Registry, id: &str, retained: Option<&Head>) {
    let mut state = registry.service.state.lock().await;
    let row = state.store.row(id).unwrap().unwrap();
    let mut task = row.task.clone();
    if let Some(head) = retained {
        occupy_slot(&mut task, head);
        task.revoke_run();
    }
    let mut snapshot = serde_json::to_value(&task).unwrap();
    snapshot["phase"] = json!("done");
    state
        .store
        .save_row(
            &row,
            &serde_json::from_value(snapshot).unwrap(),
            &event("fixture_finished"),
        )
        .unwrap();
}

async fn seed_removal_planning(registry: &Registry, id: &str) {
    let lane = format!("/v1/planning/{id}/lanes/release");
    let plan = format!("/v1/planning/{id}/plan");
    let items = format!("/v1/planning/{id}/items");
    let decisions = format!("/v1/planning/{id}/decisions");

    assert_eq!(
        planning::put_as(&registry.api, &lane, &BOARD_KEY,
            &json!({"version":0,"title":"Release","aim":"Verify release","document":"Fixture notes"})).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        planning::put_as(
            &registry.api,
            &plan,
            &BOARD_KEY,
            &json!({"version":0,"lanes":[{"key":"release","horizon":"now","doneWhen":"Released","statusNote":"Fixture"}]})
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        post_as(&registry.api, &items, &BOARD_KEY,
            &json!({"kind":"papercut","title":"Fixture item","body":"Use the test","lanes":["release"]})).await.status(),
        StatusCode::CREATED
    );
    assert_eq!(
        post_as(&registry.api, &decisions, &BOARD_KEY,
            &json!({"question":"Ship?","options":[{"id":"yes","label":"Ship"},{"id":"no","label":"Wait"}]})).await.status(),
        StatusCode::CREATED
    );
}

async fn claim(registry: &Registry, actor: &str) {
    let response = caller_request(
        &registry.api,
        Method::POST,
        "/v1/planning/claim",
        actor,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
}

fn received_notice(registry: &Registry) -> (String, String, String) {
    let notices = registry.notices.lock().unwrap();
    let sent = notices.sends.last().unwrap();
    let text = sent["text"].as_str().unwrap();
    let route = text
        .split_once("Reply: nucleus tell '")
        .unwrap()
        .1
        .split_once('\'')
        .unwrap()
        .0;
    let value: Value = serde_json::from_str(route).unwrap();
    let handle = value["to"]["reply"].as_str().unwrap();
    assert!(handle.starts_with("nreply_"));
    (
        sent["threadId"].as_str().unwrap().into(),
        text.into(),
        handle.into(),
    )
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
    assert!(!text.contains("Fallback delivery"));
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
        .tell("beta-planner", json!({"reply": next_handle}), "Follow-up")
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
    // An outstanding proof keeps the reply addressed to the original thread.
    {
        let mut state = registry.service.state.lock().await;
        registry
            .service
            .request_enrollment(&mut state, "alpha-planner");
    }
    assert!(registry.advance_tell().await.is_err());
    let actor = registry.service.take_enrollment().await.unwrap();
    assert_eq!(actor, "alpha-planner");
    registry.archived.store(true, Ordering::Relaxed);
    registry.service.complete_enrollment(&actor).await;
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
    assert!(text.contains("Fallback delivery"));
    assert!(text.contains("a planner of project Exact T3 Alpha, is gone"));
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
    assert!(text.contains("Fallback delivery"));
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
async fn done_completion_names_the_pull_and_an_omitted_opt_in_stays_silent() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    for (id, opt) in [("quiet", ""), ("done", "  notifyOriginOnCloseout: true\n")] {
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
                notices.sends[0]["text"],
                format!("#{} Ship correction is done · {PR}", row.number.unwrap())
            );
        }
    }
}
