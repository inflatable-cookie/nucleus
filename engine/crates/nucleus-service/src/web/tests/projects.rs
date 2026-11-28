use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Mutex as SyncMutex,
    time::Duration,
};

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
const SCRATCH_AGENT: &str = "scratch-agent";
const BRIEF: &str = "---\nqueue:\n  complexity: low\n---\n# Synthetic brief";

#[derive(Default)]
pub(super) struct NoticeFixture {
    pub(super) sends: Vec<Value>,
    pub(super) launches: Vec<Value>,
    controls: Vec<Value>,
    started: bool,
    pub(super) next_reply: NoticeReply,
    settled: bool,
    uncertain_planner: bool,
    /// T3's server config, for the cached model list.
    server_config: Option<Value>,
    archived_threads: BTreeSet<String>,
    missing_threads: BTreeSet<String>,
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
        let launched = self.launches.iter().find(|launch| launch["threadId"] == id);
        let project = launched
            .and_then(|launch| launch["projectId"].as_str())
            .unwrap_or(match id {
                "beta-planner" => "beta-native",
                "missing-root" => "missing-native",
                "standalone-agent" => "external-native",
                SCRATCH_AGENT => "scratch-native",
                _ => "alpha-native",
            });
        let provider = launched
            .and_then(|launch| launch["modelSelection"]["instanceId"].as_str())
            .or((id == "task-session").then_some("fixture-acp"));
        let (messages, runs) = self.projection(id);
        json!({"kind": "snapshot", "snapshotSequence": 16, "projection": {"thread": {
            "id": id, "projectId": project,
            "archivedAt": (id == "closed" || (id == "alpha-planner" && archived) || self.archived_threads.contains(id)).then_some("2026-11-23T18:10:00Z"),
            "parentThreadId": (id == "child" || id == "worker-thread").then_some("parent"),
            "providerInstanceId": provider,
            "settledAt": self.settled.then_some("2026-11-23T18:10:00Z"),
        }, "messages": messages, "runs": runs}})
    }

    pub(super) fn launch(&mut self, request: &Value) -> Value {
        let payload = request["payload"].clone();
        self.launches.push(payload);
        json!({"_tag": "Exit", "requestId": request["id"], "exit": {"_tag": "Success", "value": {"sequence": 17}}})
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
        self.service.enrollment_wake.notified().await;
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
    let scratch = alpha_path.with_file_name("scratch");
    std::fs::create_dir(&scratch).expect("synthetic scratch folder");
    let default_model = json!({"instanceId": "codex", "model": "gpt-5"});
    let snapshot = json!({"projects": [
        {"id": "alpha-native", "workspaceRoot": alpha_path, "title": "Exact T3 Alpha", "defaultModelSelection": default_model},
        {"id": "beta-native", "workspaceRoot": beta_path, "defaultModelSelection": default_model},
        {"id": "missing-native", "workspaceRoot": missing},
        {"id": "scratch-native", "workspaceRoot": scratch},
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
                if id == "unknown-caller" || notices.missing_threads.contains(id) {
                    return json!({"_tag":"Exit", "requestId":request["id"], "exit":{
                        "_tag":"Failure", "cause":[{"_tag":"Fail", "error":{
                            "_tag":"OrchestrationV2GetThreadProjectionError",
                            "threadId": id,
                            "cause": {
                                "name": "ProjectionStoreThreadNotFoundError",
                                "message": format!("No orchestration projection exists for thread {id}.")
                            }
                        }}]
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
                    {"id": "alpha-native", "workspaceRoot": alpha, "title": "Exact T3 Alpha", "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"}},
                    {"id": "beta-native", "workspaceRoot": beta_path, "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"}},
                    {"id": "missing-native", "workspaceRoot": missing},
                    {"id": "scratch-native", "workspaceRoot": scratch},
                ]}})
            }
            Some("server.getConfig") => {
                return json!({"_tag": "Exit", "requestId": request["id"], "exit": {
                    "_tag": "Success", "value": notices.server_config.clone().expect("config")
                }});
            }
            Some("orchestration.dispatchCommand") => return notices.dispatch(request),
            Some("orchestration.launchThread") => return notices.launch(request),
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
            settings.lock_profile().expect("lock fixture profile"),
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
                claimed_planner_threads: Vec::new(),
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

async fn assert_workspace_limit(registry: &Registry, tasks: [&Task; 2]) {
    let service = &registry.service;
    let worktrees = service.worktrees();
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

async fn promote_fixture_papercut(api: &Router, repository: &str) -> (String, Value) {
    let added = caller_request(
        api,
        Method::POST,
        "/v1/planning/product/items",
        "alpha-planner",
        json!({"kind":"papercut","title":"Fixture issue","body":"Use the selected repository.","lanes":[]}),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    let item = json_body(added).await;
    let id = item["id"].as_str().unwrap();
    let promoted = caller_request(
        api,
        Method::POST,
        &format!("/v1/planning/product/items/{id}/promote"),
        "alpha-planner",
        json!({"complexity":"medium","repository":repository}),
    )
    .await;
    assert_eq!(promoted.status(), StatusCode::CREATED);
    let promoted = json_body(promoted).await;
    (id.to_owned(), promoted)
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
        .add_item_with_author_project(
            &project,
            "historic".into(),
            ItemKind::Lead,
            ItemContent {
                title: "Historic idea".into(),
                body: "---\nqueue:\n  complexity: low\n---\nA historic brief.".into(),
                lanes: vec![],
            },
            None,
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
        .reserve_grouped_launch(
            &observation,
            LaunchInputs {
                scratch: None,
                thread: "report-worker".into(),
                started_at: 1,
                input: "fixture".into(),
            },
            &[4; 32],
            None,
            "fixture-group".into(),
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
        .create_with_facts(
            &task,
            &event(kind),
            nucleus_store::TaskAdmissionFacts::default(),
        )
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
    Completion,
}

impl TaskNotice {
    async fn fixture(self) -> Registry {
        let registry = registry().await;
        registry.enroll("alpha-planner").await;
        registry.enroll("next-planner").await;
        match self {
            Self::Report => {
                seed_ready_report(&registry.service, "notice", false).await;
            }
            Self::Prerequisite => {
                seed_ready_report(&registry.service, "notice", true).await;
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
                    .create_with_facts(
                        &serde_json::from_value(completed).unwrap(),
                        &event("fixture"),
                        nucleus_store::TaskAdmissionFacts::default(),
                    )
                    .unwrap();
                drop(state);
                release_notice(&registry).await;
            }
            Self::Completion => {
                let brief = "---\nqueue:\n  complexity: low\n  notifyOriginOnCloseout: true\n---\n# Fix rounding";
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
            }
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
            Self::Completion => service
                .state
                .lock()
                .await
                .store
                .completion_notice("notice")
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
    service.notify_completion(&prior).await.unwrap();
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
    task.reserve_grouped_launch(
        &observation,
        LaunchInputs {
            scratch: None,
            thread: "fixture-worker".into(),
            started_at: 1,
            input: "fixture-only wire".into(),
        },
        &[3; 32],
        None,
        "fixture-group".into(),
    )
    .expect("reserve occupied task");
    let instance = task.run().expect("run").launch().instance.clone();
    task.record_send(&instance, 1).expect("occupy slot");
}

/// Hold `total` slots in the heavy count, which every weight may use.
fn set_global_slots(value: &mut Value, total: u32) {
    value["heavySlots"] = json!(total);
    value["totalSlots"] = json!(total);
}

async fn assert_project_slots(registry: &Registry, beta: &Task) {
    let setting = "/v1/settings/dispatch";
    let dispatch = json_body(get_as(&registry.api, setting, &BOARD_KEY).await).await;
    let mut value = dispatch["value"].clone();
    set_global_slots(&mut value, 2);
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
        set_global_slots(&mut value, global);
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
        let mut due = state.store.archive_due_ids(None, 32, true).unwrap();
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

async fn assert_retirement_history(registry: &Registry, task_path: &str) {
    let response = get_as(&registry.api, &format!("{task_path}/history"), &BOARD_KEY).await;
    assert_eq!(response.status(), StatusCode::OK);
    let history = json_body(response).await;
    let mut kinds = history
        .as_array()
        .unwrap()
        .iter()
        .map(|event| &event["content"]["kind"])
        .filter(|kind| *kind != "phase_transition");
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
    crate::tests::save_row(
        &mut state.store,
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
    let handle = text
        .split_once("Reply: nucleus reply ")
        .unwrap()
        .1
        .split_once(" 'your message'")
        .unwrap()
        .0;
    assert!(
        handle.starts_with('r') && handle.len() == 9,
        "short handle: {handle}"
    );
    (
        sent["threadId"].as_str().unwrap().into(),
        text.into(),
        handle.into(),
    )
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

async fn setup_promoted_queue_fixture(head: &Head) -> Registry {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    registry.enroll("beta-planner").await;
    registry.service.state.lock().await.settings.profiles =
        Some(Arc::new(nucleus_store::Profiles::default()));

    let setting = "/v1/settings/dispatch";
    let dispatch = json_body(get_as(&registry.api, setting, &BOARD_KEY).await).await;
    let mut value = dispatch["value"].clone();
    set_global_slots(&mut value, 2);
    value["projectDefaultSlots"] = json!(1);
    assert_eq!(
        put_settings(
            &registry.api,
            setting,
            &BOARD_KEY,
            &json!({"revision": dispatch["revision"], "value": value})
        )
        .await
        .status(),
        StatusCode::OK
    );

    for (actor, id) in [("alpha-planner", "alpha-run"), ("beta-planner", "beta-run")] {
        let mut task = registry.task(actor, id).await;
        let prior = registry.service.task(id).await.unwrap();
        occupy_slot(&mut task, head);
        registry
            .service
            .save(&prior, task, &event("occupied"))
            .await
            .unwrap();
        registry.service.state.lock().await.schedule.park(id);
    }

    for (actor, id, extra) in [
        ("alpha-planner", "alpha-promoted", "  priority: promoted\n"),
        ("beta-planner", "beta-normal-old", ""),
        ("beta-planner", "beta-promoted-mid", ""),
        (
            "beta-planner",
            "beta-promoted-held",
            "  priority: promoted\n",
        ),
        ("beta-planner", "beta-done-prereq", ""),
        (
            "beta-planner",
            "beta-promoted-parked",
            "  priority: promoted\n  dependsOn: ['beta-done-prereq']\n",
        ),
        (
            "beta-planner",
            "beta-promoted-new",
            "  priority: promoted\n",
        ),
    ] {
        let brief = format!("---\nqueue:\n  complexity: low\n{extra}---\n# {id}");
        let response = caller_request(
            &registry.api,
            Method::POST,
            "/v1/planning/tasks",
            actor,
            json!({"id": id, "reference": id, "brief": brief}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
    }
    registry
}

async fn verify_promote_command_and_holds(registry: &Registry) {
    assert_eq!(
        caller_request(
            &registry.api,
            Method::POST,
            "/v1/tasks/beta-promoted-mid/commands",
            "beta-planner",
            json!({"promote": 99}),
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        caller_request(
            &registry.api,
            Method::POST,
            "/v1/tasks/beta-run/commands",
            "beta-planner",
            json!({"promote": 2}),
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let promoted = caller_request(
        &registry.api,
        Method::POST,
        "/v1/tasks/beta-promoted-mid/commands",
        "beta-planner",
        json!({"promote": 1}),
    )
    .await;
    assert_eq!(promoted.status(), StatusCode::OK);
    assert_eq!(json_body(promoted).await["queuePriority"], "promoted");
    let next = json_body(
        get_as(
            &registry.api,
            "/v1/tasks/beta-promoted-mid/next",
            &BOARD_KEY,
        )
        .await,
    )
    .await;
    assert!(
        next["commands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "demote")
    );
    for (id, reason) in [
        ("beta-done-prereq", "wait"),
        ("beta-promoted-held", "pause"),
    ] {
        assert_eq!(
            post_as(
                &registry.api,
                &format!("/v1/tasks/{id}/commands"),
                &BOARD_KEY,
                &json!({"hold": reason})
            )
            .await
            .status(),
            StatusCode::OK
        );
    }
    assert!(!registry.service.pass().await.unwrap().is_empty());
    for id in [
        "alpha-promoted",
        "beta-normal-old",
        "beta-promoted-mid",
        "beta-promoted-new",
    ] {
        assert_eq!(
            registry.service.task(id).await.unwrap().task.phase(),
            Phase::Queued
        );
    }
}

async fn verify_promoted_wakeup_skips_full_project(registry: &Registry, head: &Head) {
    let beta_run = registry.service.task("beta-run").await.unwrap();
    let mut done_beta = serde_json::to_value(&beta_run.task).unwrap();
    done_beta["phase"] = json!("done");
    done_beta["run"] = Value::Null;
    registry
        .service
        .save(
            &beta_run,
            serde_json::from_value(done_beta).unwrap(),
            &event("done"),
        )
        .await
        .unwrap();
    {
        let now = tokio::time::Instant::now();
        let mut state = registry.service.state.lock().await;
        state.schedule.park("beta-run");
        assert!(state.schedule.due("beta-promoted-mid").unwrap() <= now);
        for id in [
            "alpha-promoted",
            "beta-normal-old",
            "beta-promoted-new",
            "beta-promoted-held",
            "beta-promoted-parked",
        ] {
            assert!(
                state.schedule.due(id).is_none_or(|due| due > now),
                "unexpected due schedule for {id}"
            );
        }
    }

    let freed = registry.service.pass().await.unwrap();
    assert_eq!(freed.len(), 1);
    assert_eq!(freed[0].task, "beta-promoted-mid");
    assert!(matches!(
        freed[0].result,
        Ok(Action::Advance(Phase::Working))
    ));
    for id in ["alpha-promoted", "beta-normal-old", "beta-promoted-new"] {
        assert_eq!(
            registry.service.task(id).await.unwrap().task.phase(),
            Phase::Queued
        );
    }

    let mid_row = registry.service.task("beta-promoted-mid").await.unwrap();
    let mut mid_task = mid_row.task.clone();
    occupy_slot(&mut mid_task, head);
    registry
        .service
        .save(&mid_row, mid_task, &event("occupied"))
        .await
        .unwrap();
    registry
        .service
        .state
        .lock()
        .await
        .schedule
        .park("beta-promoted-mid");
}

async fn verify_released_and_unparked_keep_original_order(registry: &Registry) {
    let (held_order, parked_order, new_order, normal_order) = {
        let state = registry.service.state.lock().await;
        (
            state.store.admission_order("beta-promoted-held").unwrap(),
            state.store.admission_order("beta-promoted-parked").unwrap(),
            state.store.admission_order("beta-promoted-new").unwrap(),
            state.store.admission_order("beta-normal-old").unwrap(),
        )
    };
    assert!(held_order < parked_order && parked_order < new_order);

    assert_eq!(
        post_as(
            &registry.api,
            "/v1/tasks/beta-promoted-held/commands",
            &BOARD_KEY,
            &json!("release")
        )
        .await
        .status(),
        StatusCode::OK
    );
    let prereq_row = registry.service.task("beta-done-prereq").await.unwrap();
    let mut prereq_done = serde_json::to_value(&prereq_row.task).unwrap();
    prereq_done["phase"] = json!("done");
    prereq_done["hold"] = Value::Null;
    registry
        .service
        .save(
            &prereq_row,
            serde_json::from_value(prereq_done).unwrap(),
            &event("done"),
        )
        .await
        .unwrap();
    registry
        .service
        .state
        .lock()
        .await
        .schedule
        .park("beta-done-prereq");

    let waiters: Vec<_> = registry
        .service
        .state
        .lock()
        .await
        .capacity_waiters
        .iter()
        .cloned()
        .collect();
    let beta_waiters: Vec<_> = waiters
        .iter()
        .filter(|(_, _, _, id)| id.starts_with("beta-"))
        .map(|(_, priority, order, id)| (*priority, *order, id.as_str()))
        .collect();
    assert_eq!(
        beta_waiters,
        [
            (
                nucleus_core::QueuePriority::Promoted,
                held_order,
                "beta-promoted-held"
            ),
            (
                nucleus_core::QueuePriority::Promoted,
                parked_order,
                "beta-promoted-parked"
            ),
            (
                nucleus_core::QueuePriority::Promoted,
                new_order,
                "beta-promoted-new"
            ),
            (
                nucleus_core::QueuePriority::Normal,
                normal_order,
                "beta-normal-old"
            ),
        ]
    );
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

const REPLY_DAY_MS: i64 = 24 * 3_600_000;

/// Project IDs for the alpha and beta planner threads.
async fn planner_projects(registry: &Registry) -> (String, String) {
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
    )
}

/// Record a delivered message from beta's project to alpha, carrying `handle`
/// as its reply route issued at `issued_at`.
async fn record_delivered_reply_route(registry: &Registry, handle: &str, issued_at: i64) {
    use nucleus_core::QuestionDelivery;
    use nucleus_store::{TellDispatch, TellRows, TellState, TellSubmission};
    let (alpha, beta) = planner_projects(registry).await;
    let id = format!("message-{handle}");
    // Distinct text per handle: identical recent copies are reused as one delivery.
    let text = format!("Earlier question {handle}");
    let mut state = registry.service.state.lock().await;
    state
        .store
        .record_tell(
            &TellSubmission {
                key: &id,
                sender: "beta-planner",
                direct: None,
                from_project: &beta,
                text: &text,
                recorded_at: issued_at,
                no_live_planners: &[],
            },
            &[(alpha, id.clone())],
        )
        .unwrap();
    state
        .store
        .settle_tells(
            TellRows::Receipt(&id),
            TellDispatch::Send {
                notice: QuestionDelivery {
                    thread: "alpha-planner".into(),
                    command: id.clone(),
                    payload: String::new(),
                    last_send_at_ms: None,
                },
                handle: handle.into(),
            },
            issued_at,
        )
        .unwrap();
    state
        .store
        .settle_tells(
            TellRows::Receipt(&id),
            TellDispatch::Advance(TellState::Delivered {
                at_ms: issued_at,
                thread: "alpha-planner".into(),
            }),
            issued_at,
        )
        .unwrap();
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

/// Request bodies shared with the CLI tests, so both sides name the same requests.
fn shared_reply_fixtures() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/tell-replies.json"))
        .expect("shared reply fixtures")
}

fn fixture_body(fixtures: &Value, name: &str) -> Value {
    fixtures[name]["body"].clone()
}

fn fixture_handle(body: &Value) -> String {
    body["to"]["reply"].as_str().expect("handle").to_owned()
}

/// Post a tell body exactly as the CLI sends it.
async fn post_tell(registry: &Registry, actor: &str, body: Value) -> Response {
    caller_request(&registry.api, Method::POST, TELL, actor, body).await
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

async fn item_latest_version(api: &Router, project: &str, id: &str) -> (i64, Vec<Value>) {
    let history = json_body(
        get_as(
            api,
            &format!("/v1/planning/{project}/history/item/{id}"),
            &BOARD_KEY,
        )
        .await,
    )
    .await;
    let entries = history.as_array().expect("history").clone();
    let version = entries.last().expect("entry")["sequence"]
        .as_i64()
        .expect("sequence");
    (version, entries)
}

async fn archive_and_assess_again(
    registry: &Registry,
    items: &str,
    project: &str,
    id: &str,
    version: i64,
    fallback_thread: &str,
) {
    registry.archived.store(true, Ordering::Relaxed);
    registry.notices.lock().expect("notices").started = false;
    let resent = post_as(
        &registry.api,
        &format!("{items}/{id}/assess"),
        &BOARD_KEY,
        &json!({"version": version}),
    )
    .await;
    assert_eq!(resent.status(), StatusCode::OK);
    registry.advance_tell().await.expect("deliver to fallback");
    {
        let fixture = registry.notices.lock().expect("notices");
        assert_eq!(fixture.sends.len(), 2);
        assert_eq!(fixture.sends[1]["threadId"], fallback_thread);
        assert_eq!(
            fixture.sends[1]["dispatchMode"]["type"],
            "queue_after_active"
        );
    }
    let (_, entries) = item_latest_version(&registry.api, project, id).await;
    let last = entries.last().unwrap();
    assert_eq!(last["snapshot"]["recipient"], fallback_thread);
    assert_eq!(last["recipientLabel"], "Agent thread");
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

async fn clear_project_planners(registry: &Registry, project_id: &str, name: &str) {
    let file = registry.service.settings.clone();
    let id = project_id.to_owned();
    let display = name.to_owned();
    let saved = tokio::task::spawn_blocking(move || {
        let before = file.read::<nucleus_store::Projects>()?;
        file.edit(
            &before.revision,
            |projects: &mut nucleus_store::Projects| {
                let project = projects.projects.get_mut(&id).expect("project");
                project.name = display;
                project.planner_claim = None;
                for repo in &mut project.repositories {
                    repo.planner_threads.clear();
                }
                Ok(())
            },
        )
    })
    .await
    .unwrap()
    .unwrap();
    let mut state = registry.service.state.lock().await;
    state.settings.projects = Some(saved.0.value);
    state.enrolled_planners.clear();
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
/// A project row as T3's shell lists it, with the identity it reads from the checkout.
fn t3_project(id: &str, root: &Path, identity: Option<&str>, model: &Value) -> Value {
    let identity = identity.map(|key| {
        let path = key.split_once('/').expect("host and repository path").1;
        let (owner, name) = path.split_once('/').expect("owner and name");
        json!({
            "canonicalKey": key,
            "locator": {"source": "git-remote", "remoteName": "origin",
                "remoteUrl": format!("git@github.com:{path}.git")},
            "rootPath": root, "displayName": path, "provider": "github",
            "owner": owner, "name": name,
        })
    });
    json!({
        "id": id, "title": "Sample Gamma", "workspaceRoot": root, "repositoryIdentity": identity,
        "defaultModelSelection": model, "scripts": [],
        "createdAt": "2026-11-27T09:00:00.000Z", "updatedAt": "2026-11-27T09:00:00.000Z",
        "deletedAt": null,
    })
}

/// A project that no planner thread has ever enrolled, with one item sent to its planner.
struct UnboundProject {
    registry: Registry,
    project: String,
    root: PathBuf,
    items: String,
    item: String,
}

const BETA_KEY: &str = "github.com/example/second";

impl UnboundProject {
    async fn new() -> Self {
        let registry = registry().await;
        registry.enroll("beta-planner").await;
        let project = registry
            .service
            .state
            .lock()
            .await
            .live_planner_project("beta-planner")
            .expect("beta")
            .to_owned();
        clear_project_planners(&registry, &project, "Sample Gamma").await;
        let file = registry.service.settings.clone();
        let before = file.read::<nucleus_store::Projects>().unwrap();
        let mut root = PathBuf::new();
        let saved = file
            .edit(&before.revision, |all: &mut nucleus_store::Projects| {
                let repo = &mut all.projects.get_mut(&project).unwrap().repositories[0];
                repo.host_project = None;
                repo.host_project_title = None;
                root.clone_from(&repo.path);
                Ok(())
            })
            .unwrap();
        registry.service.state.lock().await.settings.projects = Some(saved.0.value);
        let items = format!("/v1/planning/{project}/items");
        let created = json_body(
            post_as(
                &registry.api,
                &items,
                &BOARD_KEY,
                &json!({"kind": "lead", "title": "First assessment", "body": "No planner yet."}),
            )
            .await,
        )
        .await;
        let item = created["id"].as_str().expect("item id").to_owned();
        Self {
            registry,
            project,
            root,
            items,
            item,
        }
    }

    fn shell(&self, projects: &[Value]) {
        self.registry
            .service
            .host
            .fixture_project_shell(&json!({"projects": projects, "threads": []}), "fixture-acp");
    }

    async fn send_to_planner(&self) {
        let response = post_as(
            &self.registry.api,
            &format!("{}/{}/assess", self.items, self.item),
            &BOARD_KEY,
            &json!({}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    /// The recorded progress since the item was filed: action and cause.
    async fn progress(&self) -> Vec<(String, Option<String>)> {
        let (_, entries) = item_latest_version(&self.registry.api, &self.project, &self.item).await;
        entries
            .iter()
            .skip(1)
            .map(|entry| {
                if entry["action"] != "assess" {
                    assert_eq!(entry["actorLabel"], "Nucleus");
                }
                (
                    entry["action"].as_str().unwrap().to_owned(),
                    entry["snapshot"]["cause"].as_str().map(str::to_owned),
                )
            })
            .collect()
    }

    /// Each recorded outcome with the zero-based number of the send it belongs to.
    async fn outcomes(&self) -> Vec<(String, usize)> {
        let (_, entries) = item_latest_version(&self.registry.api, &self.project, &self.item).await;
        let sends: Vec<_> = entries
            .iter()
            .filter(|entry| entry["action"] == "assess")
            .map(|entry| entry["sequence"].clone())
            .collect();
        entries
            .iter()
            .filter(|entry| !entry["snapshot"]["send"].is_null())
            .map(|entry| {
                let send = &entry["snapshot"]["send"];
                (
                    entry["action"].as_str().unwrap().to_owned(),
                    sends.iter().position(|sequence| sequence == send).unwrap(),
                )
            })
            .collect()
    }

    async fn queued(&self) -> bool {
        let state = self.registry.service.state.lock().await;
        state.store.next_tell().unwrap().is_some()
    }

    /// Check the one launch: the matched project, bound and claimed, with the assessment.
    async fn assert_launched(&self, host_project: &str, model: &Value) {
        let thread = {
            let fixture = self.registry.notices.lock().expect("notices");
            assert_eq!(fixture.launches.len(), 1);
            let launch = &fixture.launches[0];
            assert_eq!(launch["projectId"], host_project);
            assert_eq!(launch["title"], "Sample Gamma planner");
            assert_eq!(&launch["modelSelection"], model);
            assert_eq!(launch["workspaceStrategy"]["type"], "root");
            let text = launch["initialMessage"]["text"].as_str().expect("prompt");
            assert!(text.contains("First assessment") && text.contains(&self.item));
            launch["threadId"].as_str().expect("thread id").to_owned()
        };
        let state = self.registry.service.state.lock().await;
        let project = &state.settings.projects.as_ref().unwrap().projects[&self.project];
        assert_eq!(project.planner_claim.as_ref().unwrap().thread, thread);
        let repo = &project.repositories[0];
        assert_eq!(repo.host_project.as_deref(), Some(host_project));
        assert_eq!(repo.host_project_title.as_deref(), Some("Sample Gamma"));
        assert_eq!(repo.planner_threads, std::slice::from_ref(&thread));
        assert_eq!(
            state.live_planner_project(&thread),
            Some(self.project.as_str())
        );
    }
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

async fn watch_via(api: &Router, actor: &str, selector: &str, verb: &str) -> Response {
    let encoded = selector.replace('/', "%2F").replace('#', "%23");
    caller_request(
        api,
        Method::POST,
        &format!("/v1/tasks/{encoded}/{verb}"),
        actor,
        Value::Null,
    )
    .await
}

async fn settle_phase(service: &Service, id: &str, phase: &str, pr: Option<&str>) {
    let row = service.task(id).await.unwrap();
    let mut value = serde_json::to_value(&row.task).unwrap();
    value["phase"] = json!(phase);
    value["run"] = Value::Null;
    if let Some(url) = pr {
        value["pr"] = json!({"url": url, "head": "a".repeat(40)});
    }
    service
        .save(&row, serde_json::from_value(value).unwrap(), &event(phase))
        .await
        .unwrap();
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

async fn board_get(board: &Router, path: &str, cookie: &str) -> Response {
    board
        .clone()
        .oneshot(
            Request::get(path)
                .header(HOST, "127.0.0.1:9")
                .header("x-nucleus-board", "1")
                .header(axum::http::header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn pair_planner_board(board: &Router, actor: &str) -> String {
    let link = caller_request(board, Method::POST, "/v1/board/link", actor, json!({})).await;
    assert_eq!(link.status(), StatusCode::OK);
    let url = json_body(link).await["url"].as_str().unwrap().to_owned();
    let token = url.split("#token=").nth(1).unwrap();
    let paired = board
        .clone()
        .oneshot(
            Request::post("/api/engine/pair")
                .header(HOST, "127.0.0.1:9")
                .header("x-nucleus-board", "1")
                .header(AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(paired.status(), StatusCode::NO_CONTENT);
    paired
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

async fn acp_keys(api: &Router, path: &str, actor: &str) -> (String, String) {
    let res = caller_request(api, Method::POST, path, actor, json!({})).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = json_body(res).await;
    let binding: nucleus_core::acp::Binding = serde_json::from_str(
        &std::fs::read_to_string(body["bindingPath"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    (
        hex::encode(binding.credential),
        hex::encode(binding.command_credential.unwrap()),
    )
}

async fn assert_board_reauthorized(board: &Router, cookie: &str, task_id: &str) {
    let session = board_get(board, "/api/engine/session", cookie).await;
    assert_eq!(session.status(), StatusCode::OK);
    assert_eq!(json_body(session).await["planningProjects"], Value::Null);
    let tasks = board_get(board, "/api/engine/tasks", cookie).await;
    assert_eq!(tasks.status(), StatusCode::OK);
    let list = json_body(tasks).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["identity"]["id"], task_id);
}

fn spawn_enrollments(service: &Arc<Service>) -> tokio::task::JoinHandle<()> {
    let service = Arc::clone(service);
    tokio::spawn(async move { service.watch_enrollments().await })
}

async fn acp_call(
    api: &Router,
    method: Method,
    path: &str,
    key: &str,
    body: Option<Value>,
) -> StatusCode {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header(HOST, "127.0.0.1:9")
        .header(AUTHORIZATION, format!("Bearer {key}"));
    let body = match body {
        Some(value) => {
            req = req.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    api.clone()
        .oneshot(req.body(body).unwrap())
        .await
        .unwrap()
        .status()
}

async fn assert_acp_reauthorized(
    service: &Service,
    api: &Router,
    task_id: &str,
    read_key: &str,
    write_key: &str,
    cmd: Value,
) {
    service.state.lock().await.enrolled_planners.clear();
    assert_eq!(
        acp_call(
            api,
            Method::GET,
            &format!("/v1/tasks/{task_id}"),
            read_key,
            None
        )
        .await,
        StatusCode::OK
    );
    service.state.lock().await.enrolled_planners.clear();
    assert_eq!(
        acp_call(
            api,
            Method::POST,
            &format!("/v1/tasks/{task_id}/commands"),
            write_key,
            Some(cmd),
        )
        .await,
        StatusCode::OK
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

async fn reject_ticket_503_host(repo_root: &Path) -> (T3, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut http, _) = listener.accept().await.unwrap();
        let mut buf = [0; 2048];
        let _ = http.read(&mut buf).await.unwrap();
        http.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
    });
    let host = T3::new(&format!("http://{address}"), "fixture").unwrap();
    host.fixture_held_shell(&json!({
        "kind": "snapshot",
        "snapshot": {
            "snapshotSequence": 1,
            "projects": [{
                "id": "alpha-native",
                "workspaceRoot": repo_root,
                "defaultModelSelection": {"instanceId": "fixture-provider", "model": "fixture-model"}
            }],
            "threads": []
        }
    }));
    (host, server)
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
