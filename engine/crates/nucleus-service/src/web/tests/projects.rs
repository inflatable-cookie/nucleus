use std::{collections::BTreeMap, path::Path, time::Duration};

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
    read_started: Arc<tokio::sync::Notify>,
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
        self.start_contact(actor).await;
        self.service.complete_enrollment(actor).await;
    }

    async fn start_contact(&self, actor: &str) {
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
    let (host, native) = native_fixture(move |request| {
        observed.fetch_add(1, Ordering::Relaxed);
        let snapshot = match request["tag"].as_str() {
            Some("orchestration.subscribeThread") => {
                signal.notify_one();
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
        read_started,
        moved,
        archived,
        native,
    }
}

fn seed_imported_container(settings: &nucleus_store::SettingsFile) {
    let projects = nucleus_store::Projects {
        projects: BTreeMap::from([(
            "product".into(),
            nucleus_store::ProjectSettings {
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
    assert_eq!(
        submit(&registry.api, "alpha-planner", "unbound", Some(BETA_REPO))
            .await
            .status(),
        StatusCode::FORBIDDEN
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
