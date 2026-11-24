use std::path::Path;

use nucleus_core::{Observation, Workspace};
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

struct Registry {
    _home: tempfile::TempDir,
    service: Arc<Service>,
    api: Router,
    reads: Arc<AtomicUsize>,
    moved: Arc<AtomicBool>,
    archived: Arc<AtomicBool>,
    native: tokio::task::JoinHandle<()>,
}

impl Drop for Registry {
    fn drop(&mut self) {
        self.native.abort();
    }
}

impl Registry {
    async fn enroll(&self, actor: &str) {
        assert_eq!(
            submit(&self.api, actor, actor, None).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let requested = self
            .service
            .take_enrollment()
            .await
            .expect("one queued proof");
        assert_eq!(requested, actor);
        assert!(self.service.take_enrollment().await.is_none());
        self.service.complete_enrollment(actor).await;
    }

    async fn task(&self, actor: &str, id: &str) -> Task {
        assert_eq!(
            submit(&self.api, actor, id, None).await.status(),
            StatusCode::CREATED
        );
        self.service.task(id).await.expect("admitted task").task
    }
}

async fn registry() -> Registry {
    let (home, legacy) = fixture(GitHub::new("fixture").expect("client"));
    let alpha_path = legacy.fixture().checkout.clone();
    let beta_path = alpha_path.with_file_name("second");
    create_repository(&beta_path, "trunk", BETA_REPO);
    set_default(&alpha_path, "main");
    set_default(&beta_path, "trunk");
    let settings = legacy.settings.clone();
    drop(legacy);

    let reads = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&reads);
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
    let (host, native) = native_fixture(move |request| {
        observed.fetch_add(1, Ordering::Relaxed);
        let snapshot = match request["tag"].as_str() {
            Some("orchestration.subscribeThread") => {
                let id = request["payload"]["threadId"].as_str().expect("exact ID");
                let project = match id {
                    "beta-planner" => "beta-native",
                    "missing-root" => "missing-native",
                    _ => "alpha-native",
                };
                json!({"kind": "snapshot", "projection": {"thread": {
                    "id": id, "projectId": project,
                    "archivedAt": (id == "closed" || id == "alpha-planner" && closed.load(Ordering::Relaxed)).then_some("2026-11-23T18:10:00Z"),
                    "parentThreadId": (id == "child").then_some("parent"),
                    "providerInstanceId": (id == "task-session").then_some("fixture-acp"),
                }}})
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
            _ => panic!("unexpected T3 call"),
        };
        json!({"_tag": "Chunk", "requestId": request["id"], "values": [
            snapshot, {"kind": "synchronized"},
        ]})
    })
    .await;
    host.fixture_project_shell(&snapshot, "fixture-acp");
    let service = Arc::new(
        Service::open_projects(
            &settings,
            "fixture-acp".into(),
            host,
            GitHub::new("fixture").expect("client"),
            LOCAL_HOST.parse().expect("loopback"),
            std::env::current_exe().expect("test binary"),
        )
        .expect("start registry service"),
    );
    let api = router_with_t3_callers(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "fixture-operator".into(),
            },
        }],
        Some(T3_KEY),
    );
    Registry {
        _home: home,
        service,
        api,
        reads,
        moved,
        archived,
        native,
    }
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
            "id": id, "reference": id, "brief": "Use the synthetic repository.", "repository": repo,
        }),
    )
    .await
}

#[tokio::test]
async fn first_contact_enrolls_two_exact_routes_with_local_retries_and_scoped_reads() {
    let registry = registry().await;
    let api = &registry.api;
    for _ in 0..2 {
        assert_eq!(
            submit(api, "alpha-planner", "first", None).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    assert_eq!(registry.reads.load(Ordering::Relaxed), 0);
    assert!(registry.service.task("first").await.is_err());
    assert_eq!(
        registry.service.take_enrollment().await.as_deref(),
        Some("alpha-planner")
    );
    assert!(registry.service.take_enrollment().await.is_none());
    registry.service.complete_enrollment("alpha-planner").await;
    registry.enroll("beta-planner").await;
    let alpha = registry.task("alpha-planner", "first").await;
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
async fn first_contact_refuses_child_closed_task_session_and_missing_checkout() {
    let registry = registry().await;
    registry.enroll("alpha-planner").await;
    for actor in ["child", "closed", "task-session", "missing-root"] {
        registry.enroll(actor).await;
        assert_eq!(
            submit(&registry.api, actor, actor, None).await.status(),
            StatusCode::FORBIDDEN
        );
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
                body: "A historic brief.".into(),
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
            Value::Null,
        )
    };
    assert_eq!(promote().await.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(registry.reads.load(Ordering::Relaxed), 0);
    let actor = registry.service.take_enrollment().await.expect("one proof");
    registry.service.complete_enrollment(&actor).await;
    let created = promote().await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let task = json_body(created).await;
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
            .responsible_planner(&task)
            .await
            .expect("delivery route")
            .as_deref(),
        Some("alpha-planner")
    );
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
    let stale = nucleus_hosts::NoticeTarget {
        thread: "alpha-planner".into(),
        project_id: "alpha-native".into(),
        worktree_path: None,
    };
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
            .responsible_planner(&task)
            .await
            .expect("fallback planner")
            .as_deref(),
        Some("next-planner")
    );
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
    assert!(matches!(
        service
            .dispatch_gate(&alpha, run_target(&alpha_tree, &alpha_binding))
            .await,
        Err(ServiceError::Host(HostError::Binding))
    ));
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
    value["slots"] = json!(2);
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
}
