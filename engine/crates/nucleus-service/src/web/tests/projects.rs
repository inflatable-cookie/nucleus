#[path = "projects/enrollment_cases.rs"]
mod enrollment_cases;
#[path = "projects/planning_cases.rs"]
mod planning_cases;
#[path = "projects/removal_cases.rs"]
mod removal_cases;
#[path = "projects/routing_cases.rs"]
mod routing_cases;

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

#[expect(
    clippy::too_many_lines,
    reason = "one fixture trace covers a complete lifecycle"
)]
async fn registry_with_options(beta_repo: &str, imported: bool) -> Registry {
    let (home, legacy) = fixture(GitHub::new("fixture").expect("client"));
    let alpha_path = legacy.fixture().checkout.clone();
    let beta_path = alpha_path.with_file_name("second");
    create_repository(&beta_path, "trunk", beta_repo);
    set_default(&alpha_path, "main");
    set_default(&beta_path, "trunk");
    let settings = legacy.settings.clone();
    drop(legacy);
    crate::tests::clear_fixture_projects(&settings);
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
                    .create(
                        &serde_json::from_value(completed).unwrap(),
                        &event("fixture"),
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
