use crate::tests::registry_fixture;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use axum::{
    body::{Body, BodyDataStream, to_bytes},
    http::Request,
};
use futures_util::StreamExt;
use nucleus_core::{
    Action, CheckState, Entry, Forge, Host, LaunchInputs, Observed, RetainedThread, Review,
    RunState,
};
use nucleus_forge::{ForgeError, GitHub};
use nucleus_hosts::{Binding, RunActivity, T3, TaskHost};
use nucleus_store::EventDraft;
use tower::ServiceExt;

use super::*;
use crate::{
    event,
    tests::{
        REPOSITORY, archived_checkout_rows, code_task_at_merge, empty_archive_fixture, fixture,
        forge_pull, reservation, serve_forge,
    },
};

#[path = "tests/briefs.rs"]
mod briefs;
#[path = "tests/dependencies.rs"]
mod dependencies;
#[path = "tests/github_accounts.rs"]
mod github_accounts;
#[path = "tests/merge_holds.rs"]
mod merge_holds;
#[path = "tests/planning.rs"]
mod planning;
#[path = "tests/projects.rs"]
mod projects;
#[path = "tests/report_only.rs"]
mod report_only;

#[path = "tests/authority.rs"]
mod authority;
#[path = "tests/board_cases.rs"]
mod board_cases;
#[path = "tests/commands.rs"]
mod commands;
#[path = "tests/settings_cases.rs"]
mod settings_cases;

const PR: &str = "https://github.com/inflatable-cookie/nucleus-fixture/pull/1";
const BOARD_KEY: [u8; 32] = [2; 32];
const PLANNER_KEY: [u8; 32] = [5; 32];
const LOCAL_HOST: &str = "127.0.0.1:9";

fn without_transcript(lifecycle: &Value) -> serde_json::Map<String, Value> {
    let mut map = lifecycle.as_object().unwrap().clone();
    map.remove("transcript");
    map
}

fn assert_worker_detail(detail: &Value, list: &Value, thread: &str) {
    let lifecycle = &detail["lifecycle"];
    assert!(list[0]["lifecycle"].get("transcript").is_none());
    assert_eq!(
        list[0]["lifecycle"],
        Value::Object(without_transcript(lifecycle))
    );
    assert_eq!(
        lifecycle["transcript"]["cards"].as_array().unwrap().len(),
        1
    );
    assert_eq!(lifecycle["transcript"]["cards"][0]["role"], "worker");
    assert_eq!(lifecycle["transcript"]["cards"][0]["round"], 1);
    assert_eq!(lifecycle["transcript"]["cards"][0]["elapsedMs"], 831_000);
    assert_eq!(
        lifecycle["transcript"]["cards"][0]["threadUrl"],
        format!("t3-thread://v1/{thread}")
    );
    assert_eq!(lifecycle["steps"][1]["elapsedMs"], 831_000);
    assert!(lifecycle["steps"][1]["activeSinceMs"].is_null());
    assert_eq!(lifecycle["steps"][2]["roundLabel"], "Round 1");
    assert_eq!(detail["stateLabel"], "Waiting for a slot");
    assert_eq!(lifecycle["steps"][2]["note"], detail["stateLabel"]);
    assert_eq!(lifecycle["admittedAtMs"], detail["createdAtMs"]);
    assert!(lifecycle["steps"][2]["activeSinceMs"].is_null());
    assert_eq!(lifecycle["worker"]["thread"], thread);
    assert!(lifecycle["reviewer"].is_null());
}

async fn assert_working_transition(service: &Service) {
    {
        let state = service.state.lock().await;
        let events = state.store.lifecycle_events("worker").unwrap();
        let transition = events
            .iter()
            .find(|event| event.content.kind == "phase_transition")
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&transition.content.detail).unwrap(),
            json!({"from":"working", "to":"reviewing"})
        );
        assert_eq!(
            state.store.get("worker").unwrap().unwrap().phase(),
            Phase::Reviewing
        );
    }
}

fn assert_worker_history(history: &Value, instance: &str, thread: &str, sent_at_ms: u64) {
    assert_eq!(history[0]["content"]["kind"], "phase_transition");
    let history = without_transitions(history);
    assert_eq!(
        history[0]["presentation"],
        json!([
            {"kind":"run_ended","instance":instance}, {"kind":"pull_request","url":PR}
        ])
    );
    assert_eq!(
        history[1]["presentation"],
        json!([{"kind":"run_reported","instance":instance,"sentAtMs":sent_at_ms,
            "outcome":{"kind":"work","url":PR,"summary":"Fixed the synthetic change.","revision":false}}])
    );
    assert_eq!(history[2]["presentation"], json!([]));
    assert_eq!(
        history[3]["presentation"],
        json!([
            {"kind":"run_started","instance":instance,"role":"worker","purpose":"Synthetic change","reviewHead":null,
                "thread":thread,
                "startedAtMs":sent_at_ms - 2_000}
        ])
    );
}

fn without_transitions(history: &Value) -> Vec<&Value> {
    history
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["content"]["kind"] != "phase_transition")
        .collect()
}

async fn reject_foreign_addresses(api: &Router, worker_path: &str, key: &[u8; 32], work: &Value) {
    for (method, path, key, payload) in [
        ("GET", "/v1/tasks", &BOARD_KEY, None),
        ("GET", "/v1/events", &BOARD_KEY, None),
        (
            "POST",
            "/v1/tasks/worker/commands",
            &BOARD_KEY,
            Some(json!("cancel")),
        ),
        ("POST", worker_path, key, Some(work.clone())),
    ] {
        for (host, origin) in [
            (
                "engine.example.invalid:9",
                "http://engine.example.invalid:9",
            ),
            (LOCAL_HOST, "http://engine.example.invalid"),
            (LOCAL_HOST, "http://localhost:9"),
        ] {
            let request = Request::builder()
                .method(method)
                .uri(path)
                .header("host", host)
                .header("origin", origin)
                .header("authorization", format!("Bearer {}", hex::encode(key)))
                .header("content-type", "application/json")
                .body(
                    payload
                        .as_ref()
                        .map_or_else(Body::empty, |json| Body::from(json.to_string())),
                )
                .expect("address probe");
            let response = api.clone().oneshot(request).await.expect("response");
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method} {path}");
        }
    }
    let local_alias = Request::get("/v1/settings")
        .header("host", "localhost:9")
        .header("origin", "http://localhost:9")
        .header(
            "authorization",
            format!("Bearer {}", hex::encode(BOARD_KEY)),
        )
        .body(Body::empty())
        .expect("same origin");
    assert_eq!(
        api.clone()
            .oneshot(local_alias)
            .await
            .expect("response")
            .status(),
        StatusCode::OK
    );
}

fn changed_open_head(head: &nucleus_core::Head) -> Observed<Forge> {
    Observed::Known(Forge::Open {
        pr: PullRequest {
            url: PR.into(),
            head: (if head.as_str().starts_with('a') {
                "b"
            } else {
                "a"
            })
            .repeat(40)
            .parse()
            .expect("new head"),
        },
        checks: nucleus_core::CheckState::Ready,
    })
}

async fn seed_review_work_question(
    service: &Service,
    head: &nucleus_core::Head,
) -> Observed<Forge> {
    let (mut task, key, mut observation) = reservation("reviewer", Entry::ReviewEntry, head);
    let instance = task.run().expect("review run").launch().instance.clone();
    task.record_report(
        &instance,
        key.as_bytes(),
        Report::Question {
            prompt: "Which greeting should this revision use?".into(),
            options: Vec::new(),
        },
    )
    .expect("record review question");
    observation.host = Observed::Known(Host::Current {
        instance,
        state: RunState::Ended,
    });
    assert!(matches!(
        task.reconcile(&observation),
        Action::Ask(Question::Work { .. })
    ));
    let notice =
        T3::prepare_notice("planner".into(), "notice".into(), "Choose a greeting").expect("notice");
    assert!(task.bind_question_delivery(notice));
    seed_task(service, &task).await;
    observation.forge
}

async fn switchable_open_forge(
    head: &nucleus_core::Head,
) -> (GitHub, Arc<AtomicBool>, tokio::task::JoinHandle<()>) {
    let pull = forge_pull(head);
    let checks = crate::tests::forge_checks(head);
    let readable = Arc::new(AtomicBool::new(false));
    let ready = readable.clone();
    let (forge, server) = serve_forge(
        Router::new()
            .route(
                &format!("/repos/{REPOSITORY}/pulls/1"),
                get(move || async move {
                    if ready.load(Ordering::Relaxed) {
                        Json(pull).into_response()
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE.into_response()
                    }
                }),
            )
            .route(
                "/graphql",
                axum::routing::post(move || async move { Json(checks) }),
            ),
    )
    .await;
    (forge, readable, server)
}

async fn serve_merged_forge(
    head: &nucleus_core::Head,
) -> (
    GitHub,
    Arc<AtomicBool>,
    Arc<AtomicBool>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let mut pull = forge_pull(head);
    pull["merged"] = json!(true);
    pull["state"] = json!("closed");
    pull["merge_commit_sha"] = json!(head);
    let readable = Arc::new(AtomicBool::new(false));
    let forge_ready = Arc::clone(&readable);
    let reads = Arc::new(AtomicUsize::new(0));
    let requests = Arc::clone(&reads);
    let published = Arc::new(AtomicBool::new(true));
    let on_base = Arc::clone(&published);
    let tip = "c".repeat(40);
    let descendant = format!("/repos/{REPOSITORY}/compare/{head}...{tip}");
    let other = "b".repeat(40);
    let compare_path = format!("/repos/{REPOSITORY}/compare/{head}...{other}");
    let (forge, server) = serve_forge(
        Router::new()
            .route(
                &format!("/repos/{REPOSITORY}/pulls/1"),
                get(move || async move {
                    requests.fetch_add(1, Ordering::Relaxed);
                    if forge_ready.load(Ordering::Relaxed) {
                        Json(pull).into_response()
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE.into_response()
                    }
                }),
            )
            .route(
                &format!("/repos/{REPOSITORY}/branches/main"),
                get(move || async move {
                    let sha = if on_base.load(Ordering::Relaxed) {
                        tip
                    } else {
                        other
                    };
                    Json(json!({"name":"main","commit":{"sha":sha}}))
                }),
            )
            .route(
                &descendant,
                get(|| async { Json(json!({"status":"ahead"})) }),
            )
            .route(
                &compare_path,
                get(|| async { Json(json!({"status":"diverged"})) }),
            ),
    )
    .await;
    (forge, readable, published, reads, server)
}

fn expect_command(view: &Value, name: &str, phase: Option<&str>, readiness: &str) {
    assert!(
        view["commands"]
            .as_array()
            .expect("commands")
            .iter()
            .any(|option| {
                option["name"] == name
                    && option["phase"].as_str() == phase
                    && option["preflight"] == readiness
            }),
        "expected {name} {phase:?} to be {readiness} in {view}"
    );
}

fn planner_controller(credential: [u8; 32], actor: &str) -> Controller {
    Controller {
        credential,
        authority: Authority::Planner {
            actor: actor.into(),
        },
    }
}

async fn seed_held_acceptance(service: &Service, head: &nucleus_core::Head) {
    let (mut task, _, mut observation) = reservation("reviewer", Entry::ReviewEntry, head);
    observation.host = Observed::Known(Host::Current {
        instance: task.run().expect("review").launch().instance.clone(),
        state: RunState::Ended,
    });
    observation.forge = Observed::Known(Forge::Merged {
        pr: task.pull_request().expect("bound pull request").clone(),
        commit: head.clone(),
    });
    assert!(matches!(
        task.reconcile(&observation),
        Action::Ask(Question::Accept { .. })
    ));
    task.command(
        Command::Hold("Test the command independently of automatic close".into()),
        &Authority::Operator {
            actor: "operator".into(),
        },
        &observation,
    )
    .expect("hold fixture");
    seed_task(service, &task).await;
}

async fn seed_task(service: &Service, task: &Task) {
    service
        .state
        .lock()
        .await
        .store
        .create(task, &event("fixture"))
        .expect("seed task");
}

async fn seed_planner_task(service: &Service, id: &str, planner: &str) {
    let task = Task::new(
        Identity {
            id: id.into(),
            reference: id.into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: Some(planner.into()),
        },
        "Synthetic planner task".into(),
        None,
    );
    seed_task(service, &task).await;
}

pub(crate) async fn json_body(response: Response) -> Value {
    let body = to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("response bytes");
    serde_json::from_slice(&body).expect("response JSON")
}

async fn assert_event(events: &mut BodyDataStream, expected: &[&str]) {
    let chunk = tokio::time::timeout(std::time::Duration::from_secs(2), events.next())
        .await
        .expect("event arrived")
        .expect("stream remains open")
        .expect("event body");
    let message = std::str::from_utf8(&chunk).expect("SSE text");
    for part in expected {
        assert!(message.contains(part), "expected {part} in {message}");
    }
}

fn router(service: Arc<Service>, controllers: impl IntoIterator<Item = Controller>) -> Router {
    let controllers: Vec<_> = controllers.into_iter().collect();
    let t3 = controllers
        .iter()
        .any(|c| matches!(&c.authority, Authority::Planner { .. }));
    crate::router_with_t3_callers(service, controllers, t3.then_some(PLANNER_KEY))
}

fn router_with_board(
    service: Arc<Service>,
    controllers: impl IntoIterator<Item = Controller>,
    assets: &std::path::Path,
) -> std::io::Result<Router> {
    let controllers: Vec<_> = controllers.into_iter().collect();
    let t3 = controllers
        .iter()
        .any(|c| matches!(&c.authority, Authority::Planner { .. }));
    crate::router_with_board_and_t3_callers(service, controllers, assets, t3.then_some(PLANNER_KEY))
}

/// Enroll a T3 caller through the same first-contact API as a planner thread.
async fn enrolled_fixture(
    forge: GitHub,
) -> (tempfile::TempDir, Service, tokio::task::JoinHandle<()>) {
    let (home, mut service) = registry_fixture(forge);
    let checkout = service.fixture().checkout;
    crate::tests::git(
        &checkout,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ],
    );
    let root = checkout.clone();
    let (host, server) = crate::tests::native_fixture(move |request| {
        let value = match request["tag"].as_str() {
            Some("orchestration.subscribeShell") => json!({"kind":"snapshot", "snapshot": {
                "projects":[{"id":"local-fixture", "workspaceRoot":root}], "threads":[]
            }}),
            Some("orchestration.subscribeThread") => json!({"kind":"snapshot", "snapshotSequence":1, "projection": {
                "thread":{"id":request["payload"]["threadId"], "projectId":"local-fixture", "archivedAt":(request["payload"]["threadId"] == "unrelated-planner").then_some("2026-11-24T10:00:00Z")}, "runs":[], "messages":[]
            }}),
            _ => panic!("unexpected planner fixture request: {request}"),
        };
        json!({"_tag":"Chunk", "requestId":request["id"], "values":[value, {"kind":"synchronized"}]})
    }).await;
    host.fixture_project_shell(
        &json!({"projects":[{"id":"local-fixture", "workspaceRoot":checkout}], "threads":[]}),
        "fixture-acp",
    );
    service.host = host;
    let service = Arc::new(service);
    let api = crate::router_with_t3_callers(Arc::clone(&service), [], Some(PLANNER_KEY));
    let request = api.clone().oneshot(
        Request::get("/v1/tasks")
            .header("host", LOCAL_HOST)
            .header(
                "authorization",
                format!("Bearer {}", hex::encode(PLANNER_KEY)),
            )
            .header("x-nucleus-t3-caller", "planner")
            .body(Body::empty())
            .unwrap(),
    );
    tokio::pin!(request);
    tokio::select! {
        biased;
        () = service.enrollment_wake.notified() => {}
        _ = &mut request => panic!("planner request finished before enrollment"),
    }
    assert_eq!(service.take_enrollment().await.as_deref(), Some("planner"));
    service.complete_enrollment("planner").await;
    assert_eq!(request.await.unwrap().status(), StatusCode::OK);
    drop(api);
    let service = Arc::try_unwrap(service)
        .ok()
        .expect("fixture service is unshared");
    (home, service, server)
}

async fn get_as(api: &Router, path: &str, key: &[u8; 32]) -> Response {
    let mut request = Request::get(path)
        .header("host", LOCAL_HOST)
        .header("authorization", format!("Bearer {}", hex::encode(key)));
    if key == &PLANNER_KEY {
        request = request.header("x-nucleus-t3-caller", "planner");
    }
    api.clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn post_json(api: &Router, target: &str, key: &[u8; 32], body: &Value) -> StatusCode {
    post_as(api, target, key, body).await.status()
}

async fn post_as(api: &Router, target: &str, key: &[u8; 32], body: &Value) -> Response {
    let mut request = Request::post(target)
        .header("host", LOCAL_HOST)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {}", hex::encode(key)));
    if key == &PLANNER_KEY {
        request = request.header("x-nucleus-t3-caller", "planner");
    }
    api.clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

async fn planner_roster_fixture(
    old: &'static str,
    new: &'static str,
) -> (
    nucleus_hosts::T3,
    Arc<AtomicBool>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let replaced = Arc::new(AtomicBool::new(false));
    let reads = Arc::new(AtomicUsize::new(0));
    let changed = Arc::clone(&replaced);
    let calls = Arc::clone(&reads);
    let (host, native) = crate::tests::native_fixture(move |request| {
        assert_eq!(request["tag"], "orchestration.subscribeThread");
        assert_eq!(request["payload"]["acceptCompactTurnItems"], true);
        let id = request["payload"]["threadId"].as_str().expect("exact ID");
        assert!(id == old || id == new);
        calls.fetch_add(1, Ordering::Relaxed);
        json!({"_tag":"Chunk","requestId":request["id"],"values":[
            {"kind":"snapshot","hasMoreHistory":true,"historyCursor":"bounded",
                "turnItemsOmitLocalVisible":true,"projection":{"thread":{
                    "id":id,"projectId":"local-fixture",
                    "archivedAt":(id == old && changed.load(Ordering::Relaxed)).then_some("2026-11-23T18:10:00Z")}}},
            {"kind":"synchronized"}
        ]})
    })
    .await;
    (host, replaced, reads, native)
}

async fn mint_binding(api: &Router, task: &str, key: &[u8; 32]) -> nucleus_core::acp::Binding {
    let mint = post_as(api, &format!("/v1/tasks/{task}/acp"), key, &json!({})).await;
    assert_eq!(mint.status(), StatusCode::OK);
    let mint = json_body(mint).await;
    let file = std::path::Path::new(mint["bindingPath"].as_str().expect("binding path"));
    serde_json::from_slice(&std::fs::read(file).expect("binding file")).expect("binding shape")
}

fn seed_cancelled_notice(service: &Service, state: &mut EngineState, done: &Task) {
    let mut cancelled = Task::new(
        nucleus_core::Identity {
            id: "cancelled".into(),
            reference: "cancelled".into(),
            origin_thread: Some("terminal-planner".into()),
            ..done.identity().clone()
        },
        "---\nqueue:\n  notifyOriginOnCloseout: false\n---\n# Synthetic cancelled task".into(),
        None,
    );
    state.store.create(&cancelled, &event("fixture")).unwrap();
    let before = service.lookup(state, "cancelled").unwrap();
    let waiting = state
        .store
        .edit_dependencies(
            "cancelled",
            before.version,
            nucleus_store::DependencyEdit::Wait {
                ids: &["reviewer".into()],
                reason: "Fixture prerequisite",
            },
            &event("fixture_wait"),
            &mut |_| false,
        )
        .unwrap();
    state
        .store
        .edit_dependencies(
            "cancelled",
            waiting,
            nucleus_store::DependencyEdit::ReleaseWait,
            &event("fixture_release"),
            &mut |_| false,
        )
        .unwrap();
    let released = service.lookup(state, "cancelled").unwrap();
    cancelled
        .command(
            Command::Cancel,
            &Authority::Operator {
                actor: "fixture".into(),
            },
            &nucleus_core::Observation {
                host: Observed::Unknown,
                forge: Observed::Unknown,
                workspace: Observed::Unknown,
            },
        )
        .unwrap();
    service
        .commit(
            state,
            &released,
            &cancelled,
            &event("fixture_cancelled"),
            None,
        )
        .unwrap();
    service.request_planner_check(state, &cancelled);
    assert!(!state.planner_requests.contains("cancelled"));
    assert!(
        state
            .store
            .pending_prerequisite_notice("cancelled")
            .unwrap()
            .is_some()
    );
}

async fn fixture_at_done(service: &Service) -> (nucleus_store::TaskRow, Observed<Forge>) {
    let head = service.fixture().start.clone();
    seed_held_acceptance(service, &head).await;
    let actor = Authority::Operator {
        actor: "fixture".into(),
    };
    let first = service.task("reviewer").await.expect("seeded task");
    let forge = Observed::Known(Forge::Merged {
        pr: first.task.pull_request().expect("bound PR").clone(),
        commit: head.clone(),
    });
    for command in [
        Command::Answer(Answer::Accept {
            head,
            reason: "Fixture acceptance".into(),
        }),
        Command::Move(Phase::Done),
    ] {
        let row = service.task("reviewer").await.expect("current row");
        service
            .observe_commands(&row, &forge)
            .await
            .expect("merge observation");
        service
            .command("reviewer", &actor, command)
            .await
            .expect("applied command");
    }
    (service.task("reviewer").await.expect("done task"), forge)
}

async fn assert_paired_pause_clear(
    api: &Router,
    service: &Service,
    cookie: &str,
    now: u64,
    deadline: u64,
) {
    let clear = "/api/engine/profiles/pauses/";
    let click = |group: &str, observed, cookie: &str| {
        let path = format!("{clear}{group}/clear");
        let cookie = cookie.to_owned();
        async move {
            browser_request(
                api,
                Method::POST,
                &path,
                Some(&cookie),
                Some(&json!({"untilMs":observed})),
            )
            .await
            .status()
        }
    };
    assert_eq!(
        click("codex-team", deadline, cookie).await,
        StatusCode::CONFLICT
    );
    let estimate = nucleus_store::SubscriptionPause {
        until_ms: deadline,
        fallback: true,
    };
    service
        .state
        .lock()
        .await
        .store
        .set_subscription_pause("estimated", estimate, now)
        .unwrap();
    let usage = read_paired_task(api, "/api/engine/profiles/usage", cookie).await;
    assert_eq!(usage["fallbackGroups"], json!(["estimated"]));
    let planner = pair_board(api, &PLANNER_KEY).await;
    assert_eq!(
        click("estimated", deadline, &planner).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        click("estimated", deadline - 1, cookie).await,
        StatusCode::CONFLICT
    );
    assert_eq!(click("estimated", deadline, cookie).await, StatusCode::OK);
    let usage = read_paired_task(api, "/api/engine/profiles/usage", cookie).await;
    assert_eq!(usage["limitedGroups"], json!({"codex-team":deadline}));
    assert!(usage.get("fallbackGroups").is_none());
}

fn subscription_catalog_reply(request: &Value) -> Value {
    assert_eq!(request["tag"], "server.getConfig");
    json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":{
        "environment":{"orchestrationProtocolVersion":2},
        "providers":[
            {"instanceId":"codex","enabled":true,"status":"ready","models":[{"slug":"base"}]},
            {"instanceId":"codex-team","driver":"codex","enabled":true,"status":"ready",
             "models":[{"slug":"base"},{"slug":"team-only"}]}
        ]
    }}})
}

fn subscription_launch_task() -> (Task, Observation) {
    let observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(nucleus_core::Workspace::Absent),
    };
    let mut task = Task::new(
        Identity {
            id: "fixture".into(),
            reference: "fixture".into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        "Fixture brief".into(),
        None,
    );
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    (task, observation)
}

fn settings_api(service: &Arc<Service>) -> Router {
    router(
        Arc::clone(service),
        [
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "fixture-operator".into(),
                },
            },
            Controller {
                credential: PLANNER_KEY,
                authority: Authority::Planner {
                    actor: "planner".into(),
                },
            },
        ],
    )
}

async fn put_settings(api: &Router, path: &str, key: &[u8; 32], input: &Value) -> Response {
    let mut request = Request::put(path)
        .header(HOST, LOCAL_HOST)
        .header(AUTHORIZATION, format!("Bearer {}", hex::encode(key)))
        .header("content-type", "application/json");
    if key == &PLANNER_KEY {
        request = request.header("x-nucleus-t3-caller", "planner");
    }
    api.clone()
        .oneshot(request.body(Body::from(input.to_string())).unwrap())
        .await
        .unwrap()
}

fn hold_archived_workspace(service: &Service, task: &Task, checkout: &std::path::Path) {
    let binding = Binding {
        project_id: service.fixture().host_project.clone(),
        branch: checkout.file_name().unwrap().to_str().unwrap().into(),
        worktree_path: checkout.to_str().unwrap().into(),
    };
    service.host.fixture_project_shell(
        &json!({
            "snapshotSequence":1,
            "projects":[{"id":binding.project_id,"workspaceRoot":service.fixture().checkout}],
            "threads":[],
            "archivedThreads":archived_checkout_rows(&binding, task)
        }),
        "fixture-acp",
    );
}

async fn reopen_and_finish_review(
    service: &Service,
    done: &nucleus_store::TaskRow,
    merged: &Observed<Forge>,
) -> nucleus_store::TaskRow {
    let head = service.fixture().start.clone();
    let role = nucleus_core::Role::Reviewer;
    let old_thread = done.task.threads().get(role).expect("prior review");
    let mut observation = Observation {
        forge: Observed::Known(Forge::Open {
            pr: done.task.pull_request().expect("PR").clone(),
            checks: CheckState::Ready,
        }),
        host: Observed::Known(Host::Retained {
            thread: old_thread.into(),
            state: RetainedThread::Gone,
        }),
        workspace: Observed::Known(nucleus_core::Workspace::Clean(head.clone())),
    };
    let mut task = done.task.clone();
    let actor = Authority::Operator {
        actor: "fixture".into(),
    };
    task.command(Command::Move(Phase::Reviewing), &actor, &observation)
        .expect("reopen");
    task.command(Command::Release, &actor, &observation)
        .expect("release hold");
    let reopened = service
        .save(done, task.clone(), &event("command"))
        .await
        .expect("reopened task");
    {
        let state = service.state.lock().await;
        for row in [done, &reopened] {
            let label = crate::titles::task_state_label(&row.task, None, None);
            let lifecycle = crate::presentation::task_lifecycle(
                &row.task,
                &state.store,
                &label,
                None,
                None,
                None,
            )
            .expect("project current finish");
            assert_eq!(
                lifecycle.finished_at_ms.is_some(),
                row.task.phase().is_terminal()
            );
        }
    }
    let instance = task.next_launch_instance().expect("new launch");
    let credential = task
        .reserve_launch(
            &observation,
            LaunchInputs {
                scratch: None,
                thread: format!("thread:delegated-task:{instance}"),
                started_at: 2,
                input: "fixture-only wire".into(),
            },
            &[4; 32],
        )
        .expect("reserve new child");
    task.record_send(&instance, 3).expect("send marker");
    task.record_report(
        &instance,
        credential.as_bytes(),
        Report::Review {
            head,
            decision: Review::Approve,
            summary: "Synthetic review of the reopened task".into(),
            finding_titles: Vec::new(),
        },
    )
    .expect("new review report");
    observation.host = Observed::Known(Host::Current {
        instance,
        state: RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Merging)
    );
    observation.forge = merged.clone();
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Closing)
    );
    observation.workspace = Observed::Known(nucleus_core::Workspace::Absent);
    assert!(task.finish_close(&observation));
    service
        .save(&reopened, task, &event("closed_checkout_absent"))
        .await
        .expect("second Done")
}

async fn archive_shell_fixture(
    service: &Service,
    new_child: &str,
) -> (
    T3,
    String,
    Arc<std::sync::Mutex<Vec<String>>>,
    impl Fn(&T3, Option<&str>) + use<>,
    tokio::task::JoinHandle<()>,
) {
    let worktrees = service.worktrees();
    let checkout = worktrees
        .checkout(
            &service.fixture().checkout,
            &service.fixture().repository,
            "reviewer",
        )
        .expect("reviewer path");
    let parent_id = nucleus_hosts::parent_thread(checkout.path());
    let parent = parent_id.clone();
    let path = checkout.path().to_owned();
    let branch = checkout.branch().to_owned();
    let project_root = service.fixture().checkout.clone();
    let child = new_child.to_owned();
    let archived = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let writes = Arc::clone(&archived);
    let publish_row = {
        let writes = Arc::clone(&archived);
        let (path, branch, parent) = (path.clone(), branch.clone(), parent.clone());
        let child = child.clone();
        let root = project_root.clone();
        move |host: &T3, reopened: Option<&str>| {
            let writes = writes.lock().unwrap();
            let threads: Vec<_> = [parent.as_str(), child.as_str(), "thread:reviewer"]
                .into_iter()
                .filter(|id| reopened == Some(id) || !writes.iter().any(|archived| archived == id))
                .map(|id| {
                json!({"id":id,"projectId":"local-fixture","worktreePath":path,"branch":branch,
                    "parentThreadId":(id != parent).then_some(&parent),
                    "providerInstanceId":"fixture-acp","modelSelection":{"instanceId":"fixture-acp","model":"nucleus"},
                    "status":"idle","latestRunId":null,"pendingBackgroundTasks":[],
                    "updatedAt":if reopened == Some(id) {"2026-11-23T15:01:00Z"} else {"2026-11-23T15:00:00Z"},"activeRunId":null,"pendingRuntimeRequest":null,
                    "deletedAt":(id=="thread:reviewer").then_some("2026-11-23T16:00:00Z")})
            }).collect();
            host.fixture_project_shell(
                &json!({"snapshotSequence":16 + writes.len(),
                "projects":[{"id":"local-fixture","workspaceRoot":root}],"threads":threads}),
                "fixture-acp",
            );
        }
    };
    let (host, native) = crate::tests::native_fixture(move |request| {
        if request["tag"] == "orchestration.getArchivedShellSnapshot" {
            let writes = writes.lock().unwrap();
            let rows: Vec<_> = writes.iter().map(|id| json!({
                "id":id, "projectId":"local-fixture", "worktreePath":path, "branch":branch,
                "archivedAt":"2026-11-23T15:02:00Z", "deletedAt":null, "status":"idle",
                "activeRunId":null, "pendingRuntimeRequest":null, "pendingBackgroundTasks":[]
            })).collect();
            return json!({"_tag":"Exit","requestId":request["id"],"exit":{
                "_tag":"Success","value":{"snapshotSequence":16 + writes.len(),"projects":[],"threads":rows}
            }});
        }
        if request["tag"] == "orchestration.dispatchCommand" {
            let payload = &request["payload"];
            assert_eq!(payload["type"], "thread.archive");
            let target = payload["threadId"].as_str().expect("archive destination");
            let mut archived = writes.lock().expect("archive log");
            archived.push(target.into());
            return json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":{"sequence":16 + archived.len()}}});
        }
        panic!("unexpected archive read: {}", request["tag"]);
    }).await;
    host.use_held_shell();
    (host, parent_id, archived, publish_row, native)
}

// The browser exercises the same paired routes, stored task and command guard as
// the native assertions; the child exits before the fixture server is stopped.

async fn run_mounted_task_board(
    address: std::net::SocketAddr,
    cookie: &str,
) -> std::process::Output {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = tokio::process::Command::new("node");
    child
        .current_dir(root)
        .arg("test/support/mounted-rust-task.mjs")
        .env("BOARD_FIXTURE_ORIGIN", format!("http://{address}"))
        .env("BOARD_FIXTURE_COOKIE", cookie)
        .kill_on_drop(true);
    tokio::time::timeout(std::time::Duration::from_secs(90), child.output())
        .await
        .expect("mounted board timed out")
        .expect("run mounted board fixture")
}

async fn observe_task_wait(service: &Service, wait: WaitReason) {
    let row = service.task("age").await.unwrap();
    service
        .schedule_result(
            &row,
            &Ok(Action::Wait(wait)),
            crate::schedule::Priority::Wake,
        )
        .await
        .unwrap();
}

async fn read_paired_task(api: &Router, path: &str, cookie: &str) -> Value {
    let response = browser_request(api, Method::GET, path, Some(cookie), None).await;
    assert_eq!(response.status(), StatusCode::OK, "{path}");
    json_body(response).await
}

fn reopen_fixture(
    settings: &nucleus_store::SettingsFile,
    project: &crate::Project,
    forge: GitHub,
) -> Service {
    reopen_fixture_at(settings, project, forge, "http://127.0.0.1:9")
}

fn reopen_fixture_at(
    settings: &nucleus_store::SettingsFile,
    project: &crate::Project,
    forge: GitHub,
    endpoint: &str,
) -> Service {
    let host = T3::new(endpoint, "fixture").unwrap();
    host.fixture_project_shell(&json!({"projects": [{"id": project.host_project, "workspaceRoot": project.checkout}], "threads": []}), "fixture-acp");
    Service::open_projects(
        settings.lock_profile().unwrap(),
        "fixture-acp".into(),
        host,
        forge,
        LOCAL_HOST.parse().unwrap(),
        std::env::current_exe().unwrap(),
    )
    .unwrap()
}

async fn assert_browser_lanes(api: &Router, session: &str, events: &mut BodyDataStream) {
    let plan = "/api/engine/planning/fixture-product/plan";
    let lane = "/api/engine/planning/fixture-product/lanes/board";
    let cookie = Some(session);
    let initial = json_body(browser_request(api, Method::GET, plan, cookie, None).await).await;
    assert_eq!(initial["version"], 0);
    let document =
        json!({"title":"Board","aim":"Finish Settings","document":"## Steps","version":0});
    let saved =
        json_body(browser_request(api, Method::PUT, lane, cookie, Some(&document)).await).await;
    assert_eq!(saved["version"], 1);
    assert_event(events, &["event: planning"]).await;
    assert_eq!(
        browser_request(api, Method::PUT, lane, cookie, Some(&document))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let update = json!({"version":0,"lanes":[{"key":"board","horizon":"now","doneWhen":"Tools work","statusNote":"Ready"}]});
    let saved =
        json_body(browser_request(api, Method::PUT, plan, cookie, Some(&update)).await).await;
    assert_eq!(saved["version"], 1);
    assert_event(events, &["event: planning"]).await;
    let updated = json_body(browser_request(api, Method::GET, plan, cookie, None).await).await;
    assert_eq!(updated["lanes"][0]["key"], "board");
    assert_eq!(updated["documents"][0]["document"], "## Steps");
    // The paired board mounts the same planning handlers as the controller API.
    for path in [
        "/api/engine/planning/fixture-product/decisions",
        "/api/engine/planning/fixture-product/items",
    ] {
        let listed = json_body(browser_request(api, Method::GET, path, cookie, None).await).await;
        assert_eq!(listed, json!([]), "{path}");
    }
    let decision = json!({
        "question": "Use the new layout?",
        "options": [{"id": "yes", "label": "Use it"}, {"id": "no", "label": "Keep the current one"}],
    });
    let added = browser_request(
        api,
        Method::POST,
        "/api/engine/planning/fixture-product/decisions",
        cookie,
        Some(&decision),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    assert_event(events, &["event: decisions"]).await;
    assert_browser_item(api, cookie, events).await;
    // The theme is a cache read; a fixture without a host config stream has none yet.
    let theme =
        json_body(browser_request(api, Method::GET, "/api/engine/theme", cookie, None).await).await;
    assert_eq!(theme, json!({"theme": null}));
    let catalog = browser_request(
        api,
        Method::GET,
        "/api/engine/profiles/catalog",
        cookie,
        None,
    )
    .await;
    assert_eq!(
        json_body(catalog).await,
        json!({"providers":null,"readAtMs":null,"status":"pending"})
    );
    let usage = browser_request(api, Method::GET, "/api/engine/profiles/usage", cookie, None).await;
    let window = json!({"counts":{},"groups":{},"sample":0});
    assert_eq!(
        json_body(usage).await,
        json!({"recent":window,"worker":window,"reviewer":window,"totals":{},"groupTotals":{},"limitedGroups":{}})
    );
    let reassign = browser_request(
        api,
        Method::POST,
        "/api/engine/settings/projects/reassign",
        cookie,
        Some(&json!({})),
    )
    .await;
    assert_ne!(reassign.status(), StatusCode::NOT_FOUND);
}

async fn assert_browser_item(api: &Router, cookie: Option<&str>, events: &mut BodyDataStream) {
    let item = json!({"kind":"papercut","title":"Toast lingers","body":"It stays.","lanes":[]});
    let added = browser_request(
        api,
        Method::POST,
        "/api/engine/planning/fixture-product/items",
        cookie,
        Some(&item),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    assert_eq!(json_body(added).await["kind"], "papercut");
    assert_event(events, &["event: planning"]).await;
    let listed = json_body(
        browser_request(
            api,
            Method::GET,
            "/api/engine/planning/fixture-product/items",
            cookie,
            None,
        )
        .await,
    )
    .await;
    let item = &listed[0];
    assert_eq!(item["title"], "Toast lingers");
    assert!(item["createdAtMs"].is_i64());
    assert_eq!(item["updatedAtMs"], item["createdAtMs"]);

    let id = item["id"].as_str().expect("papercut ID");
    let path = format!("/api/engine/planning/fixture-product/items/{id}");
    let wrong_project = format!("/api/engine/planning/other-project/items/{id}");
    let version = item["version"].as_i64().expect("papercut version");
    let edit =
        json!({"version":version,"title":"Toast has lingered","body":"It still stays.","lanes":[]});
    assert_eq!(
        browser_request(api, Method::PUT, &wrong_project, cookie, Some(&edit))
            .await
            .status(),
        StatusCode::NOT_FOUND,
    );
    let response = browser_request(api, Method::PUT, &path, cookie, Some(&edit)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved = json_body(response).await;
    assert_eq!(saved["title"], edit["title"]);
    assert_eq!(saved["body"], edit["body"]);
    assert_eq!(saved["createdAtMs"], item["createdAtMs"]);
    assert!(saved["version"].as_i64().unwrap() > version);
    assert_event(events, &["event: planning"]).await;

    let stale = json!({"version":version,"title":"Stale edit","body":"Old text.","lanes":[]});
    assert_eq!(
        browser_request(api, Method::PUT, &path, cookie, Some(&stale))
            .await
            .status(),
        StatusCode::CONFLICT,
    );
    let listed = json_body(
        browser_request(
            api,
            Method::GET,
            "/api/engine/planning/fixture-product/items",
            cookie,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(listed[0], saved);

    assert_browser_lead_complexity(api, cookie, events).await;
}

/// A lead's list entry carries the complexity its brief declares, flow-style YAML included.
async fn assert_browser_lead_complexity(
    api: &Router,
    cookie: Option<&str>,
    events: &mut BodyDataStream,
) {
    let lead = json!({"kind":"lead","title":"Flow lead","body":"---\nqueue: {complexity: medium, dependsOn: []}\n---\nDo the work.\n","lanes":[]});
    let added = browser_request(
        api,
        Method::POST,
        "/api/engine/planning/fixture-product/items",
        cookie,
        Some(&lead),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    assert_event(events, &["event: planning"]).await;
    let listed_lead = |listed: &Value| {
        listed
            .as_array()
            .expect("items")
            .iter()
            .find(|item| item["kind"] == "lead")
            .expect("lead")
            .clone()
    };
    let items = "/api/engine/planning/fixture-product/items";
    let listed = json_body(browser_request(api, Method::GET, items, cookie, None).await).await;
    let current = listed_lead(&listed);
    assert_eq!(current["complexity"], "medium");
    let papercut = listed
        .as_array()
        .expect("items")
        .iter()
        .find(|item| item["kind"] == "papercut")
        .expect("papercut");
    assert_eq!(
        papercut.get("complexity"),
        None,
        "papercut bodies are not briefs"
    );
}

async fn assert_board_assets(api: &Router) {
    for path in ["/", "/settings", "/app.js"] {
        let response = browser_request(api, Method::GET, path, None, None).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        let bytes = to_bytes(response.into_body(), 1024).await.expect("asset");
        let expected = if path == "/app.js" {
            "Fixture Board"
        } else {
            "/app.js"
        };
        assert!(
            std::str::from_utf8(&bytes)
                .expect("utf8 asset")
                .contains(expected)
        );
    }
}

async fn assert_browser_origin(api: &Router, session: &str) {
    let response = api
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/engine/tasks")
                .header(HOST, LOCAL_HOST)
                .header(ORIGIN, "http://127.0.0.1:10")
                .header("x-nucleus-board", "1")
                .header("cookie", session)
                .body(Body::empty())
                .expect("cross-origin request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = api
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/engine/tasks")
                .header(HOST, LOCAL_HOST)
                .header("cookie", session)
                .body(Body::empty())
                .expect("simple request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

async fn pair_board(api: &Router, key: &[u8; 32]) -> String {
    let link = json_body(post_as(api, "/v1/board/link", key, &json!({})).await).await;
    let url = link["url"].as_str().expect("pairing link");
    assert!(!url.ends_with(&hex::encode(key)));
    pair_board_link(api, url).await
}

pub(crate) async fn pair_board_link(api: &Router, url: &str) -> String {
    let token = url
        .strip_prefix("http://127.0.0.1:9/#token=")
        .expect("token in fragment");
    let pair = || {
        Request::builder()
            .method(Method::POST)
            .uri("/api/engine/pair")
            .header(HOST, LOCAL_HOST)
            .header(ORIGIN, "http://127.0.0.1:9")
            .header("x-nucleus-board", "1")
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .expect("pair request")
    };
    let response = api.clone().oneshot(pair()).await.expect("pair response");
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .expect("session cookie");
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
    assert!(cookie.contains("Path=/api/engine") && cookie.contains("Max-Age=2592000"));
    let session = cookie.split(';').next().expect("cookie value").to_owned();
    assert_eq!(
        api.clone()
            .oneshot(pair())
            .await
            .expect("link replay response")
            .status(),
        StatusCode::UNAUTHORIZED
    );
    session
}

pub(crate) async fn browser_request(
    api: &Router,
    method: Method,
    path: &str,
    cookie: Option<&str>,
    body: Option<&Value>,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(HOST, LOCAL_HOST)
        .header(ORIGIN, "http://127.0.0.1:9")
        .header("x-nucleus-board", "1");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let request = if let Some(body) = body {
        request
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
    } else {
        request.body(Body::empty())
    }
    .expect("browser request");
    api.clone()
        .oneshot(request)
        .await
        .expect("browser response")
}

async fn exhaust_legacy_allowance(service: &Service) -> (nucleus_store::TaskRow, u64) {
    let (task, _, _) = reservation("legacy", Entry::Brief, &service.fixture().start);
    let mut state = service.state.lock().await;
    state.store.create(&task, &event("fixture")).unwrap();
    state.allowance_clock = crate::allowance::Clock::new(3_600_000);
    assert_eq!(state.allowance_view(&task).unwrap().used_ms, 0);
    state
        .observe_task_allowance(&task, Some(nucleus_core::WaitReason::Running))
        .unwrap();
    state.allowance_clock = crate::allowance::Clock::new(3_620_000);
    state
        .observe_task_allowance(&task, Some(nucleus_core::WaitReason::Hold))
        .unwrap();
    state.allowance_clock = crate::allowance::Clock::new(3_680_000);
    assert_eq!(state.allowance_view(&task).unwrap().used_ms, 20_000);
    state
        .observe_task_allowance(&task, Some(nucleus_core::WaitReason::Running))
        .unwrap();

    let limit = 180 * 60_000;
    let first_spend = 3_600_000 + 60_000 + limit;
    state.allowance_clock = crate::allowance::Clock::new(first_spend);
    let row = service.lookup(&state, "legacy").unwrap();
    drop(state);

    let _fence = service.effect(&row).await.unwrap();
    assert_eq!(service.gate_allowance(&row).await.unwrap(), None);
    let mut state = service.state.lock().await;
    assert_eq!(state.allowance_view(&task).unwrap().limit_ms, 2 * limit);
    let second_spend = first_spend + limit + 1_000;
    state.allowance_clock = crate::allowance::Clock::new(second_spend);
    drop(state);
    assert_eq!(
        service.gate_allowance(&row).await.unwrap(),
        Some(Action::Wait(nucleus_core::WaitReason::Question))
    );
    let asked = service.task("legacy").await.unwrap();
    assert!(matches!(
        asked.task.question(),
        Some(Question::Allowance { .. })
    ));
    (asked, limit)
}

fn at_event(kind: &str, time: u64) -> EventDraft {
    EventDraft {
        at: i64::try_from(time).unwrap(),
        ..event(kind)
    }
}

async fn run_routed_report(
    service: &Service,
    mut row: nucleus_store::TaskRow,
    obs: &Observation,
    thread: &str,
    routing: (&str, &str),
    times: (u64, u64, u64),
    (seed, report): (u8, Report),
) -> nucleus_store::TaskRow {
    let mut updated = row.task.clone();
    let key = updated
        .reserve_launch(
            obs,
            LaunchInputs {
                scratch: None,
                thread: thread.into(),
                started_at: times.0 - 500,
                input: format!("input-{seed}"),
            },
            &[seed; 32],
        )
        .unwrap();
    let id = updated.run().unwrap().launch().instance.clone();
    updated.record_send(&id, times.0).unwrap();
    row = service
        .save(&row, updated, &at_event("host_send", times.0))
        .await
        .unwrap();
    service
        .observe_run_routing(
            &row,
            row.task.run().unwrap(),
            &nucleus_hosts::RunRouting {
                provider: routing.0.into(),
                model: routing.1.into(),
            },
        )
        .await
        .unwrap();
    let mut ended_obs = obs.clone();
    if let Report::Work(ref work) = report {
        ended_obs.forge = Observed::Known(Forge::Open {
            pr: work.pull_request.clone(),
            checks: CheckState::Ready,
        });
    }
    let mut updated = row.task.clone();
    updated.record_report(&id, key.as_bytes(), report).unwrap();
    row = service
        .save(&row, updated, &at_event("reported", times.1))
        .await
        .unwrap();
    ended_obs.host = Observed::Known(Host::Current {
        instance: id,
        state: RunState::Ended,
    });
    let mut updated = row.task.clone();
    assert!(matches!(updated.reconcile(&ended_obs), Action::Advance(_)));
    service
        .save(&row, updated, &at_event("phase_reconciled", times.2))
        .await
        .unwrap()
}

async fn start_full_cycle_task(
    service: &Service,
    head1: nucleus_core::Head,
) -> (nucleus_store::TaskRow, PullRequest) {
    let queued = nucleus_core::Task::new(
        nucleus_core::Identity {
            id: "full-cycle".into(),
            reference: "full-cycle".into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        "---\ncomplexity: normal\n---\n\n# Full cycle fixture\n".into(),
        None,
    );
    service
        .state
        .lock()
        .await
        .store
        .create(&queued, &at_event("admitted", 1_000))
        .expect("admit queued");
    let row = service.task("full-cycle").await.unwrap();
    let obs_work = Observation {
        forge: Observed::Known(Forge::Absent),
        host: Observed::Unknown,
        workspace: Observed::Known(nucleus_core::Workspace::Clean(head1.clone())),
    };
    let mut updated = row.task.clone();
    assert_eq!(
        updated.reconcile(&obs_work),
        Action::Advance(Phase::Working)
    );
    let row = service
        .save(&row, updated, &at_event("phase_reconciled", 2_000))
        .await
        .unwrap();
    let pr1 = PullRequest {
        url: PR.into(),
        head: head1.clone(),
    };
    let row = Box::pin(run_routed_report(
        service,
        row,
        &obs_work,
        "thread-w1",
        ("claude-fixture", "claude-model-1"),
        (3_000, 10_000, 11_000),
        (
            1,
            Report::Work(nucleus_core::WorkReport {
                pull_request: pr1.clone(),
                summary: Some("Initial work".into()),
            }),
        ),
    ))
    .await;
    let obs_pr1 = Observation {
        forge: Observed::Known(Forge::Open {
            pr: pr1.clone(),
            checks: CheckState::Ready,
        }),
        host: Observed::Unknown,
        workspace: Observed::Known(nucleus_core::Workspace::Clean(head1.clone())),
    };
    let row = Box::pin(run_routed_report(
        service,
        row,
        &obs_pr1,
        "thread-r1",
        ("codex-fixture", "codex-model-1"),
        (12_000, 20_000, 21_000),
        (
            2,
            Report::Review {
                head: head1,
                decision: Review::Changes,
                summary: "Fix edge case".into(),
                finding_titles: vec!["Missing null guard".into()],
            },
        ),
    ))
    .await;
    (row, pr1)
}

async fn finish_full_cycle_task(
    service: &Service,
    row: nucleus_store::TaskRow,
    pr1: PullRequest,
    head2: nucleus_core::Head,
) {
    let obs_work_two = Observation {
        forge: Observed::Known(Forge::Open {
            pr: pr1,
            checks: CheckState::Ready,
        }),
        host: Observed::Known(Host::Retained {
            thread: "thread-w1".into(),
            state: RetainedThread::Idle,
        }),
        workspace: Observed::Known(nucleus_core::Workspace::Clean(head2.clone())),
    };
    let pr2 = PullRequest {
        url: PR.into(),
        head: head2.clone(),
    };
    let row = run_routed_report(
        service,
        row,
        &obs_work_two,
        "thread-w1",
        ("claude-fixture", "claude-model-2"),
        (22_000, 30_000, 31_000),
        (
            3,
            Report::Work(nucleus_core::WorkReport {
                pull_request: pr2.clone(),
                summary: Some("Addressed review".into()),
            }),
        ),
    )
    .await;
    let obs_review_two = Observation {
        forge: Observed::Known(Forge::Open {
            pr: pr2.clone(),
            checks: CheckState::Ready,
        }),
        host: Observed::Known(Host::Retained {
            thread: "thread-r1".into(),
            state: RetainedThread::Idle,
        }),
        workspace: Observed::Known(nucleus_core::Workspace::Clean(head2.clone())),
    };
    let row = run_routed_report(
        service,
        row,
        &obs_review_two,
        "thread-r1",
        ("codex-fixture", "codex-model-2"),
        (32_000, 40_000, 41_000),
        (
            4,
            Report::Review {
                head: head2.clone(),
                decision: Review::Approve,
                summary: "Looks solid".into(),
                finding_titles: Vec::new(),
            },
        ),
    )
    .await;
    let obs_merged = Observation {
        forge: Observed::Known(Forge::Merged {
            pr: pr2,
            commit: head2,
        }),
        host: Observed::Unknown,
        workspace: Observed::Known(nucleus_core::Workspace::Absent),
    };
    let mut updated = row.task.clone();
    assert_eq!(
        updated.reconcile(&obs_merged),
        Action::Advance(Phase::Closing)
    );
    let mut merge_audit = at_event("phase_reconciled", 42_000);
    crate::presentation::note_merge(&mut merge_audit, &obs_merged.forge);
    let row = service.save(&row, updated, &merge_audit).await.unwrap();
    let mut updated = row.task.clone();
    assert!(updated.finish_close(&obs_merged));
    service
        .save(&row, updated, &at_event("phase_reconciled", 43_000))
        .await
        .unwrap();
}

fn assert_full_cycle_detail(detail: &Value) {
    assert_eq!(detail["phase"], "done");
    let steps = detail["lifecycle"]["steps"].as_array().unwrap();
    let bounds: Vec<_> = steps
        .iter()
        .map(|s| (&s["key"], &s["enteredAtMs"], &s["leftAtMs"]))
        .collect();
    assert_eq!(
        bounds,
        [
            (&json!("queued"), &json!(1_000), &json!(2_000)),
            (&json!("working"), &json!(21_000), &json!(31_000)),
            (&json!("review"), &json!(31_000), &json!(41_000)),
            (&json!("merge"), &json!(41_000), &json!(42_000)),
            (&json!("close"), &json!(42_000), &json!(43_000)),
        ]
    );
    assert_eq!(
        steps[1]["visits"],
        json!([
            { "enteredAtMs": 2_000, "leftAtMs": 11_000 },
            { "enteredAtMs": 21_000, "leftAtMs": 31_000 },
        ])
    );
    assert_eq!(
        steps[2]["visits"],
        json!([
            { "enteredAtMs": 11_000, "leftAtMs": 21_000 },
            { "enteredAtMs": 31_000, "leftAtMs": 41_000 },
        ])
    );
    let transcript = &detail["lifecycle"]["transcript"];
    assert_eq!(transcript["completedReviews"], 2);
    assert_eq!(transcript["merged"], true);
    let cards = transcript["cards"].as_array().unwrap();
    assert_eq!(cards.len(), 4);
    assert_eq!(cards[0]["role"], "worker");
    assert_eq!(cards[0]["round"], 1);
    assert_eq!(cards[0]["startedAtMs"], 3_000);
    assert_eq!(cards[0]["endedAtMs"], 11_000);
    assert_eq!(cards[0]["elapsedMs"], 7_000);
    assert_eq!(cards[0]["model"], "claude-model-1");
    assert_eq!(cards[0]["providerInstance"], "claude-fixture");
    assert_eq!(cards[0]["modelObserved"], true);
    assert_eq!(cards[0]["threadUrl"], "t3-thread://v1/thread-w1");
    assert_eq!(cards[0]["outcome"]["kind"], "work");
    assert_eq!(cards[0]["outcome"]["revision"], false);

    assert_eq!(cards[1]["role"], "reviewer");
    assert_eq!(cards[1]["round"], 1);
    assert_eq!(cards[1]["startedAtMs"], 12_000);
    assert_eq!(cards[1]["endedAtMs"], 21_000);
    assert_eq!(cards[1]["elapsedMs"], 8_000);
    assert_eq!(cards[1]["model"], "codex-model-1");
    assert_eq!(cards[1]["providerInstance"], "codex-fixture");
    assert_eq!(cards[1]["modelObserved"], true);
    assert_eq!(cards[1]["threadUrl"], "t3-thread://v1/thread-r1");
    assert_eq!(cards[1]["outcome"]["kind"], "review");
    assert_eq!(cards[1]["outcome"]["decision"], "changes");
    assert_eq!(
        cards[1]["outcome"]["finding_titles"],
        json!(["Missing null guard"])
    );

    assert_eq!(cards[2]["role"], "worker");
    assert_eq!(cards[2]["round"], 2);
    assert_eq!(cards[2]["startedAtMs"], 22_000);
    assert_eq!(cards[2]["endedAtMs"], 31_000);
    assert_eq!(cards[2]["model"], "claude-model-2");
    assert_eq!(cards[2]["outcome"]["kind"], "work");
    assert_eq!(cards[2]["outcome"]["revision"], true);

    assert_eq!(cards[3]["role"], "reviewer");
    assert_eq!(cards[3]["round"], 2);
    assert_eq!(cards[3]["startedAtMs"], 32_000);
    assert_eq!(cards[3]["endedAtMs"], 41_000);
    assert_eq!(cards[3]["model"], "codex-model-2");
    assert_eq!(cards[3]["outcome"]["kind"], "review");
    assert_eq!(cards[3]["outcome"]["decision"], "approve");
    assert_eq!(cards[3]["outcome"]["finding_titles"], json!([]));
}

async fn seed_pre_1601_task(service: &Service, head: &nucleus_core::Head) {
    let pr = PullRequest {
        url: PR.into(),
        head: head.clone(),
    };
    let (mut legacy, legacy_key, mut obs) = reservation("pre-1601", Entry::Brief, head);
    let legacy_instance = legacy.run().unwrap().launch().instance.clone();
    legacy.record_send(&legacy_instance, 2_000).unwrap();
    legacy
        .record_report(
            &legacy_instance,
            legacy_key.as_bytes(),
            Report::Work(nucleus_core::WorkReport {
                pull_request: pr.clone(),
                summary: Some("Pre-1601 work".into()),
            }),
        )
        .unwrap();
    obs.host = Observed::Known(Host::Current {
        instance: legacy_instance.clone(),
        state: RunState::Ended,
    });
    obs.forge = Observed::Known(Forge::Merged {
        pr,
        commit: head.clone(),
    });
    obs.workspace = Observed::Known(nucleus_core::Workspace::Absent);
    assert!(matches!(
        legacy.reconcile(&obs),
        Action::Ask(Question::Accept { .. })
    ));
    legacy
        .command(
            Command::Answer(nucleus_core::Answer::Accept {
                head: head.clone(),
                reason: "Legacy acceptance".into(),
            }),
            &Authority::Operator {
                actor: "board".into(),
            },
            &obs,
        )
        .unwrap();
    assert_eq!(legacy.reconcile(&obs), Action::Advance(Phase::Closing));
    assert!(legacy.finish_close(&obs));
    service
        .state
        .lock()
        .await
        .store
        .create(&legacy, &at_event("admitted", 1_000))
        .unwrap();
    insert_legacy_events(service, &legacy_instance, head);
}

fn insert_legacy_events(service: &Service, instance: &str, head: &nucleus_core::Head) {
    let connection =
        rusqlite::Connection::open(service.storage.database().path().join("engine.sqlite"))
            .unwrap();
    for (at, kind, detail) in [
        (
            2_000_i64,
            "host_send",
            json!({
                "presentation": [{
                    "kind": "run_started", "instance": instance, "role": "worker",
                    "purpose": "Legacy work", "reviewHead": null, "thread": "thread-legacy",
                    "startedAtMs": 2_000
                }]
            }),
        ),
        (
            5_000,
            "reported",
            json!({
                "presentation": [{
                    "kind": "run_reported", "instance": instance, "sentAtMs": 2_000,
                    "outcome": {
                        "kind": "work", "url": PR, "summary": "Pre-1601 work", "revision": false
                    }
                }]
            }),
        ),
        (
            10_000,
            "phase_reconciled",
            json!({
                "presentation": [
                    { "kind": "run_ended", "instance": instance },
                    { "kind": "pull_request", "url": PR },
                    { "kind": "merged", "commit": head },
                    { "kind": "finished", "phase": "done", "previousPhase": "closing" }
                ]
            }),
        ),
    ] {
        connection
            .execute(
                "INSERT INTO events (task_id, at, kind, detail) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["pre-1601", at, kind, detail.to_string()],
            )
            .unwrap();
    }
}

async fn seed_outcome_runs(service: &Service, head: &nucleus_core::Head) {
    let (mut outcomes_task, _, _) = reservation("outcomes", Entry::Brief, head);
    let r1 = outcomes_task.run().unwrap().launch().instance.clone();
    outcomes_task.record_send(&r1, 20_000).unwrap();
    {
        let mut state = service.state.lock().await;
        state
            .store
            .create(&outcomes_task, &at_event("admitted", 19_000))
            .unwrap();
        let row = service.lookup(&state, "outcomes").unwrap();
        let send_audit = crate::presentation::decorate(
            &nucleus_core::Task::new(
                outcomes_task.identity().clone(),
                outcomes_task.brief().text.clone(),
                None,
            ),
            &outcomes_task,
            &at_event("host_send", 20_000),
            &state.store,
        );
        state
            .store
            .save_row(&row, &outcomes_task, &send_audit)
            .unwrap();
    }
    let row = service.task("outcomes").await.unwrap();
    let limit_obs = Observation {
        forge: Observed::Known(Forge::Absent),
        host: Observed::Known(Host::ProviderLimited {
            instance: r1.clone(),
            cause: "Provider usage limit for subscription group shared. Reset at 90000.".into(),
        }),
        workspace: Observed::Known(nucleus_core::Workspace::Clean(head.clone())),
    };
    let mut after_limit = row.task.clone();
    assert!(matches!(
        after_limit.reconcile(&limit_obs),
        Action::Relaunch(nucleus_core::Role::Worker)
    ));
    let mut limit_event = at_event("provider_limit", 25_000);
    limit_event.detail = json!({
        "cause": after_limit.threads().last_provider_limit,
        "providerLimit": { "instance": r1, "group": "shared", "resetAtMs": 90_000 }
    })
    .to_string();
    let row = service.save(&row, after_limit, &limit_event).await.unwrap();
    Box::pin(seed_question_and_failed_runs(service, head, row)).await;
}

async fn seed_question_and_failed_runs(
    service: &Service,
    head: &nucleus_core::Head,
    row: nucleus_store::TaskRow,
) {
    let mut with_r2 = row.task.clone();
    let r2_key = with_r2
        .reserve_launch(
            &obs_absent_host(head),
            LaunchInputs {
                scratch: None,
                thread: "thread:outcomes".into(),
                started_at: 26_000,
                input: "work-2".into(),
            },
            &[7; 32],
        )
        .unwrap();
    let r2 = with_r2.run().unwrap().launch().instance.clone();
    with_r2.record_send(&r2, 27_000).unwrap();
    let row = service
        .save(&row, with_r2, &at_event("host_send", 27_000))
        .await
        .unwrap();
    let mut reported_q = row.task.clone();
    reported_q
        .record_report(
            &r2,
            r2_key.as_bytes(),
            Report::Question {
                prompt: "Which strategy?".into(),
                options: vec!["First".into(), "Second".into()],
            },
        )
        .unwrap();
    let row = service
        .save(&row, reported_q, &at_event("reported", 28_000))
        .await
        .unwrap();
    let mut asked = row.task.clone();
    assert!(matches!(
        asked.reconcile(&Observation {
            forge: Observed::Known(Forge::Absent),
            host: Observed::Known(Host::Current {
                instance: r2,
                state: RunState::Ended,
            }),
            workspace: Observed::Known(nucleus_core::Workspace::Clean(head.clone())),
        }),
        Action::Ask(Question::Work { .. })
    ));
    let row = service
        .save(&row, asked, &at_event("question_asked", 29_000))
        .await
        .unwrap();
    let mut answered = row.task.clone();
    answered
        .command(
            Command::Answer(nucleus_core::Answer::Work("First".into())),
            &Authority::Planner {
                actor: "planner".into(),
            },
            &obs_absent_host(head),
        )
        .unwrap();
    let row = service
        .save(&row, answered, &at_event("command", 30_000))
        .await
        .unwrap();
    seed_failed_run(service, head, row).await;
}

async fn seed_failed_run(
    service: &Service,
    head: &nucleus_core::Head,
    row: nucleus_store::TaskRow,
) {
    let mut with_r3 = row.task.clone();
    with_r3
        .reserve_launch(
            &obs_absent_host(head),
            LaunchInputs {
                scratch: None,
                thread: "thread:outcomes".into(),
                started_at: 31_000,
                input: "work-3".into(),
            },
            &[8; 32],
        )
        .unwrap();
    let r3 = with_r3.run().unwrap().launch().instance.clone();
    with_r3.record_send(&r3, 32_000).unwrap();
    let row = service
        .save(&row, with_r3, &at_event("host_send", 32_000))
        .await
        .unwrap();
    let mut failed = row.task.clone();
    assert!(matches!(
        failed.reconcile(&Observation {
            forge: Observed::Known(Forge::Absent),
            host: Observed::Known(Host::Current {
                instance: r3,
                state: RunState::Gone,
            }),
            workspace: Observed::Known(nucleus_core::Workspace::Clean(head.clone())),
        }),
        Action::Relaunch(nucleus_core::Role::Worker)
    ));
    service
        .save(&row, failed, &at_event("run_failed", 35_000))
        .await
        .unwrap();
}

fn obs_absent_host(head: &nucleus_core::Head) -> Observation {
    Observation {
        forge: Observed::Known(Forge::Absent),
        host: Observed::Known(Host::Retained {
            thread: "thread:outcomes".into(),
            state: RetainedThread::Idle,
        }),
        workspace: Observed::Known(nucleus_core::Workspace::Clean(head.clone())),
    }
}

/// Settle one pass result and return the delay before the task's next pass.
async fn settle_pass(
    service: &Service,
    id: &str,
    result: &Result<Action, ServiceError>,
) -> (std::time::Duration, std::time::Duration) {
    let row = service.task(id).await.unwrap();
    // A pass takes the task's deadlines before it records a result.
    service.state.lock().await.schedule.park(id);
    let before = tokio::time::Instant::now();
    service
        .schedule_result(&row, result, crate::schedule::Priority::Closeout)
        .await
        .unwrap();
    let after = tokio::time::Instant::now();
    let due = service.state.lock().await.schedule.due(id).expect("retry");
    (due - after, due - before)
}

fn assert_delay((low, high): (std::time::Duration, std::time::Duration), expected: u64) {
    let expected = std::time::Duration::from_secs(expected);
    assert!(
        low <= expected && expected <= high,
        "{low:?}..{high:?} for {expected:?}"
    );
}

async fn board_pair_fixture() -> (
    tempfile::TempDir,
    Arc<Service>,
    Router,
    tokio::task::JoinHandle<()>,
) {
    let (home, service, host) =
        enrolled_fixture(GitHub::new("unused-forge-fixture").expect("client")).await;
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).expect("board assets dir");
    std::fs::write(assets.join("index.html"), "<!doctype html>").expect("index");
    std::fs::write(assets.join("app.js"), "").expect("app");
    let service = Arc::new(service);
    let api = router_with_board(
        service.clone(),
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
    .expect("board router");
    (home, service, api, host)
}

async fn issue_pair_code(api: &Router, cookie: &str) -> String {
    let issued = json_body(
        browser_request(
            api,
            Method::POST,
            "/api/engine/pair/code",
            Some(cookie),
            None,
        )
        .await,
    )
    .await;
    assert!(issued["expiresAtMs"].as_u64().is_some());
    issued["code"].as_str().expect("pair code").to_owned()
}

async fn redeem_code(api: &Router, code: &str) -> Response {
    browser_request(
        api,
        Method::POST,
        "/api/engine/pair/redeem",
        None,
        Some(&json!({"code": code})),
    )
    .await
}
