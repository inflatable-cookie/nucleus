use std::{fs::Permissions, os::unix::fs::PermissionsExt, path::Path};

use crate::{
    Binding, Dispatch, HostError, RoleProfile, RunRequest, SendOutcome, StopProgress, T3, T3Pass,
    TaskHost,
};
use futures_util::{SinkExt, StreamExt};
use nucleus_core::{
    Authority, CheckState, Command, Entry, Forge, Host, Identity, Observation, Observed, Phase,
    PullRequest, RetainedThread, RunState, Task, Workspace,
};
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{
            ErrorResponse, Request as UpgradeRequest, Response as UpgradeResponse,
        },
    },
};

const THREAD: &str = "fixture-thread";

#[test]
fn cached_thread_titles_include_archived_rows_without_a_host_read() {
    let host = T3::new("http://127.0.0.1:1", "fixture-key").expect("fixture host");
    host.rpc.fixture_shell(&json!({
        "kind":"snapshot",
        "snapshot":{
            "threads":[{"id":"current","title":"Current thread"}],
            "archivedThreads":[{"id":"archived","title":"Archived thread"}],
            "projects":[]
        }
    }));

    assert_eq!(
        host.cached_thread_title("current").as_deref(),
        Some("Current thread")
    );
    assert_eq!(
        host.cached_thread_title("archived").as_deref(),
        Some("Archived thread")
    );
    assert_eq!(host.cached_thread_title("unknown"), None);
}
const NATIVE_RUN: &str = "fixture-native-turn";
const LATE_REPLY_MS: u64 = 600_000;

fn quiet_pass(client: &T3) -> T3Pass<'_> {
    client.fixture_pass()
}

fn checkout_fixture() -> tempfile::TempDir {
    tempfile::Builder::new()
        .permissions(Permissions::from_mode(0o700))
        .tempdir()
        .expect("checkout")
}

#[derive(Deserialize)]
struct Request {
    id: String,
    tag: String,
    payload: Box<RawValue>,
}

enum Response {
    Snapshot(Value),
    ParentSnapshot(Value),
    ShellSnapshot(Value),
    ConfigStream(Vec<Value>),
    Success,
    Value(Value),
    Failure(Value),
}

#[allow(clippy::result_large_err)] // This is tungstenite's handshake callback signature.
fn check_upgrade(
    request: &UpgradeRequest,
    response: UpgradeResponse,
) -> Result<UpgradeResponse, ErrorResponse> {
    if request.uri().path_and_query().is_some_and(|target| {
        target.as_str() == "/ws?wsTicket=fixture-ticket&orchestrationProtocol=2"
    }) {
        return Ok(response);
    }
    let mut error = ErrorResponse::new(Some("unexpected WebSocket target".into()));
    *error.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::BAD_REQUEST;
    Err(error)
}

async fn serve_ticket(listener: &TcpListener) {
    let (mut http, _) = listener.accept().await.expect("ticket HTTP");
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        assert!(headers.len() < 8192);
        headers.push(http.read_u8().await.expect("header byte"));
    }
    let headers = String::from_utf8(headers).expect("header text");
    assert!(headers.starts_with("POST /api/auth/websocket-ticket/rpc HTTP/1.1\r\n"));
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("authorization: bearer fixture-key")
    );
    let ticket = r#"{"ticket":"fixture-ticket"}"#;
    http.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{ticket}",
            ticket.len()
        )
        .as_bytes(),
    )
    .await
    .expect("ticket response");
    drop(http);
}

async fn server(steps: Vec<(&'static str, Response)>) -> (T3, JoinHandle<Vec<Request>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("listen");
    let address = listener.local_addr().expect("address");
    let client = T3::new(&format!("http://{address}"), "fixture-key").expect("client");
    let runner = tokio::spawn(async move {
        serve_ticket(&listener).await;
        let (socket, _) = listener.accept().await.expect("websocket");
        let mut socket = accept_hdr_async(socket, check_upgrade)
            .await
            .expect("handshake");

        let mut seen = Vec::new();
        for (tag, response) in steps {
            let frame = socket
                .next()
                .await
                .expect("request")
                .expect("websocket frame");
            let request: Request = serde_json::from_str(frame.to_text().expect("frame text"))
                .expect("request envelope");
            assert_eq!(request.tag, tag);
            let id = &request.id;
            let shell = matches!(&response, Response::ShellSnapshot(_));
            let config = matches!(&response, Response::ConfigStream(_));
            let thread = match &response {
                Response::Snapshot(_) => Some(THREAD.to_owned()),
                Response::ParentSnapshot(value) => Some(
                    value["projection"]["thread"]["id"]
                        .as_str()
                        .expect("parent ID")
                        .to_owned(),
                ),
                _ => None,
            };
            let reply = match response {
                Response::Snapshot(value)
                | Response::ParentSnapshot(value)
                | Response::ShellSnapshot(value) => json!({
                    "_tag": "Chunk", "requestId": id.parse::<u64>().expect("numeric request sequence"),
                    "values": [value, {"kind": "synchronized"}],
                }),
                Response::Success => {
                    json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Success","value":{"sequence":1}}})
                }
                Response::Value(value) => {
                    json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Success","value":value}})
                }
                Response::Failure(cause) => {
                    json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Failure","cause":cause}})
                }
                Response::ConfigStream(values) => {
                    json!({"_tag":"Chunk","requestId":id,"values":values})
                }
            };
            socket
                .send(Message::Text(reply.to_string().into()))
                .await
                .expect("write reply");
            if config {
                let frame = socket.next().await.expect("ack").expect("ack frame");
                let value: Value =
                    serde_json::from_str(frame.to_text().expect("ack text")).expect("ack envelope");
                assert_eq!(value, json!({"_tag":"Ack","requestId":id}));
            }
            if thread.is_some() || shell {
                for expected in ["Ack", "Interrupt"] {
                    let frame = socket
                        .next()
                        .await
                        .expect("control")
                        .expect("control frame");
                    let value: Value = serde_json::from_str(frame.to_text().expect("control text"))
                        .expect("control envelope");
                    assert_eq!(value, json!({"_tag":expected,"requestId":id}));
                }
            }
            if let Some(thread) = thread {
                assert_thread_subscription(&request, &thread);
            }
            seen.push(request);
        }
        seen
    });
    (client, runner)
}

fn assert_thread_subscription(request: &Request, thread: &str) {
    let payload: Value = serde_json::from_str(request.payload.get()).expect("subscribe body");
    assert_eq!(
        payload,
        json!({"threadId":thread,"requestCompletionMarker":true,"acceptBoundedSnapshot":true,
            "acceptCompactTurnItems":true,"acceptDedupedBodies":true})
    );
}

#[tokio::test]
async fn unchanged_rows_reuse_their_snapshots_and_only_one_changed_row_reads() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let rows: Vec<_> = (0..20)
        .map(|index| {
            json!({
                "id": format!("row-{index}"), "projectId": binding.project_id,
                "worktreePath": binding.worktree_path, "branch": binding.branch,
                "status": "idle", "visibleItemCount": 1
            })
        })
        .collect();
    let response = |row: &Value| {
        (
            "orchestration.subscribeThread",
            Response::ParentSnapshot(json!({
                "kind": "snapshot", "snapshotSequence": 16,
                "projection": {
                    "thread": row, "runs": [], "messages": [], "runtimeRequests": [],
                    "providerThreads": [], "turnItems": []
                }
            })),
        )
    };
    let mut changed = rows[7].clone();
    changed["visibleItemCount"] = json!(2);
    let steps = rows
        .iter()
        .map(response)
        .chain(std::iter::once(response(&changed)))
        .collect();
    let (host, server) = server(steps).await;
    host.rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "sequence":1, "threads":rows, "projects":[]
        }}));
    let ((), warm) = T3::count_pass_calls(Box::pin(async {
        for row in &rows {
            host.fixture_pass()
                .observe_retained_role(&binding, row["id"].as_str().unwrap())
                .await
                .expect("initial exact observation");
        }
    }))
    .await;
    assert_eq!(warm["orchestration.subscribeThread"], 20);
    let ((), unchanged) = T3::count_pass_calls(Box::pin(async {
        for row in &rows {
            host.fixture_pass()
                .observe_retained_role(&binding, row["id"].as_str().unwrap())
                .await
                .expect("unchanged observation");
        }
    }))
    .await;
    assert!(
        unchanged.is_empty(),
        "20 unchanged rows made calls: {unchanged:?}"
    );

    host.rpc
        .fixture_shell(&json!({"kind":"thread.updated","sequence":2,"thread":changed}));
    let ((), moved) = T3::count_pass_calls(Box::pin(async {
        for row in &rows {
            host.fixture_pass()
                .observe_retained_role(&binding, row["id"].as_str().unwrap())
                .await
                .expect("observation after one row moved");
        }
    }))
    .await;
    assert_eq!(
        moved.into_iter().collect::<Vec<_>>(),
        [("orchestration.subscribeThread", 1)]
    );
    let requests = server.await.expect("native traffic");
    assert_thread_subscription(&requests[20], "row-7");
}

#[tokio::test]
async fn done_archive_uses_only_the_held_shell_and_skips_a_late_active_row() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let parent = crate::parent_thread(checkout.path());
    let (host, native) = server(vec![
        ("orchestration.dispatchCommand", Response::Success),
        ("orchestration.dispatchCommand", Response::Success),
    ])
    .await;
    let row = |id: &str, status: &str| {
        json!({
            "id":id,"projectId":binding.project_id,"worktreePath":binding.worktree_path,
            "branch":binding.branch,"updatedAt":"2026-11-24T15:50:00Z",
            "status":status,"activeRunId":null,"pendingRuntimeRequest":null,"pendingBackgroundTasks":[]
        })
    };
    let mut archived = row("worker", "running");
    archived["archivedAt"] = json!("2026-11-24T15:55:00Z");
    host.rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":16,"projects":[],"archivedThreads":[archived],
            "threads":[row(&parent,"idle"),row("reviewer","idle"),row("unrelated","idle")]
        }}));
    let mut foreign = binding.clone();
    foreign.project_id = "another-project".into();
    assert!(matches!(
        host.prepare_archive(&foreign, Some("reviewer"), Some("worker")),
        Err(HostError::Binding)
    ));
    let prepare = || {
        host.prepare_archive(&binding, Some("reviewer"), Some("worker"))
            .unwrap()
    };
    let crate::DoneArchive::Write(stale) = prepare() else {
        panic!("the reviewer is eligible for archive");
    };
    host.rpc.fixture_shell(
        &json!({"kind":"thread.updated","sequence":17,"thread":row("reviewer","running")}),
    );
    assert!(!host.write_archive(stale, || true).await.unwrap());
    assert!(host.host_calls().is_empty());

    let crate::DoneArchive::Write(parent_write) = prepare() else {
        panic!("the idle task thread can archive");
    };
    assert!(!host.write_archive(parent_write, || false).await.unwrap());
    let crate::DoneArchive::Write(parent_write) = prepare() else {
        panic!("the parent remains eligible after release");
    };
    assert!(host.write_archive(parent_write, || true).await.unwrap());
    host.rpc
        .fixture_shell(&json!({"kind":"thread.removed","sequence":18,"threadId":parent}));
    let crate::DoneArchive::Wait(cause) = prepare() else {
        panic!("the active reviewer must wait");
    };
    assert_eq!(cause, "The reviewer thread is still active in T3.");
    host.rpc.fixture_shell(
        &json!({"kind":"thread.updated","sequence":19,"thread":row("reviewer","completed")}),
    );
    let crate::DoneArchive::Write(reviewer_write) = prepare() else {
        panic!("the completed reviewer can archive");
    };
    assert!(host.write_archive(reviewer_write, || true).await.unwrap());
    host.rpc
        .fixture_shell(&json!({"kind":"thread.removed","sequence":20,"threadId":"reviewer"}));
    assert!(matches!(prepare(), crate::DoneArchive::Finished));

    let restarted = T3::new("http://127.0.0.1:9", "fixture").unwrap();
    let restart_step = || restarted.prepare_archive(&binding, Some("reviewer"), Some("worker"));
    assert!(matches!(restart_step(), Ok(crate::DoneArchive::Wait(_))));
    let mut deleted = row("reviewer", "idle");
    deleted["deletedAt"] = json!("2026-11-24T15:56:00Z");
    restarted
        .rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":99,"projects":[],"threads":[deleted,row("unrelated","idle")]
        }}));
    assert!(matches!(restart_step(), Ok(crate::DoneArchive::Finished)));
    assert!(restarted.host_calls().is_empty());
    let requests = native.await.unwrap();
    let targets: Vec<Value> = requests
        .iter()
        .map(|request| {
            let payload: Value = serde_json::from_str(request.payload.get()).unwrap();
            assert_eq!(payload["type"], "thread.archive");
            payload["threadId"].clone()
        })
        .collect();
    assert_eq!(targets, [json!(parent), json!("reviewer")]);
}

#[tokio::test]
async fn a_large_planner_thread_uses_compact_bounded_readback_and_keeps_unknown_delivery() {
    let mut delivery = T3::prepare_notice("planner".into(), "notice-42".into(), "Fixture").unwrap();
    delivery.last_send_at_ms = Some(1);
    let bounded = json!({
        "kind":"snapshot", "snapshotSequence":900, "hasMoreHistory":true,
        "historyCursor":"previous-items", "turnItemsOmitLocalVisible":true,
        "projection":{
            "thread":{"id":"planner","projectId":"fixture-project","providerInstanceId":"host",
                "visibleItemCount":50_000},
            "runs":[], "messages":[], "turnItems":[]
        }
    });
    let mut delivered = bounded.clone();
    delivered["projection"]["runs"] = json!([{"id":"run-42","userMessageId":"notice-42-message",
        "status":"running","startedAt":"2026-11-24T15:56:03Z"}]);
    let (client, server) = server(vec![
        (
            "orchestration.subscribeThread",
            Response::ParentSnapshot(bounded),
        ),
        (
            "orchestration.subscribeThread",
            Response::ParentSnapshot(delivered),
        ),
    ])
    .await;
    assert!(matches!(
        client.observe_notice(&delivery).await,
        Err(HostError::Uncertain)
    ));
    assert_eq!(
        client.notice_state(&delivery).await.unwrap(),
        crate::NoticeState::Started
    );
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 2);
    for request in requests {
        assert_thread_subscription(&request, "planner");
    }
}

#[tokio::test]
async fn inbox_favicon_updates_only_the_fixed_project_and_uses_native_null_to_clear() {
    use crate::{InboxTarget, NUCLEUS_RUST_PROVIDER, inbox::PROJECT};

    let root = "/synthetic/rust-inbox";
    let icon = "/synthetic/engine home/nucleus-icon.svg";
    let initial = "2026-11-24T10:00:00Z";
    let installed = "2026-11-24T10:01:00Z";
    let cleared = "2026-11-24T10:02:00Z";
    let snapshot = |favicon: Option<&str>, revision: &str| {
        Response::ShellSnapshot(json!({"kind":"snapshot","snapshot":{"projects":[
            {"id":"project:legacy-inbox","workspaceRoot":"/synthetic/legacy","faviconPath":"old.svg"},
            {"id":PROJECT,"workspaceRoot":root,"faviconPath":favicon,"updatedAt":revision}
        ]}}))
    };
    let (host, requests) = server(vec![
        ("orchestration.subscribeShell", snapshot(None, initial)),
        ("projects.mutate", Response::Success),
        (
            "orchestration.subscribeShell",
            snapshot(Some(icon), installed),
        ),
        (
            "orchestration.subscribeShell",
            snapshot(Some(icon), installed),
        ),
        (
            "orchestration.subscribeShell",
            snapshot(Some(icon), installed),
        ),
        ("projects.mutate", Response::Success),
        ("orchestration.subscribeShell", snapshot(None, cleared)),
        ("orchestration.subscribeShell", snapshot(None, cleared)),
    ])
    .await;
    let target = InboxTarget {
        root,
        provider: NUCLEUS_RUST_PROVIDER,
    };
    let write = host
        .prepare_inbox_favicon(&target, Some(icon))
        .await
        .unwrap()
        .unwrap();
    let set = write.command_id().to_owned();
    host.write_inbox(write).await.unwrap();
    assert_eq!(
        host.inbox_favicon(&target).await.unwrap().as_deref(),
        Some(icon)
    );
    assert!(
        host.prepare_inbox_favicon(&target, Some(icon))
            .await
            .unwrap()
            .is_none()
    );
    let write = host
        .prepare_inbox_favicon(&target, None)
        .await
        .unwrap()
        .unwrap();
    let clear = write.command_id().to_owned();
    host.write_inbox(write).await.unwrap();
    assert_eq!(host.inbox_favicon(&target).await.unwrap(), None);
    let wrong = InboxTarget {
        root: "/synthetic/legacy",
        ..target
    };
    assert!(matches!(
        host.prepare_inbox_favicon(&wrong, Some(icon)).await,
        Err(HostError::Binding)
    ));

    let writes: Vec<Value> = requests
        .await
        .unwrap()
        .into_iter()
        .filter(|request| request.tag == "projects.mutate")
        .map(|request| serde_json::from_str(request.payload.get()).unwrap())
        .collect();
    assert_eq!(
        writes,
        [
            json!({"type":"project.update","commandId":set,"projectId":PROJECT,"faviconPath":icon}),
            json!({"type":"project.update","commandId":clear,"projectId":PROJECT,"faviconPath":null}),
        ]
    );
}

fn binding(path: &Path) -> Binding {
    Binding {
        project_id: "fixture-project".into(),
        worktree_path: path
            .canonicalize()
            .expect("canonical checkout")
            .to_str()
            .expect("UTF-8 checkout")
            .into(),
        branch: "fixture-branch".into(),
    }
}

fn reserve(binding: Binding) -> (Task, Observation, String) {
    reserve_entry(binding, Entry::ReviewEntry)
}

fn reserve_entry(binding: Binding, entry: Entry) -> (Task, Observation, String) {
    reserve_with_parent(binding, entry, None)
}

fn reserve_with_parent(
    binding: Binding,
    entry: Entry,
    parent: Option<crate::ParentRun>,
) -> (Task, Observation, String) {
    let pr = PullRequest {
        url: "https://github.com/example/fixture/pull/1".into(),
        head: "a".repeat(40).parse().expect("head"),
    };
    let mut task = Task::new(
        Identity {
            id: "fixture".into(),
            reference: "fixture".into(),
            repository: "example/fixture".into(),
            base: "main".into(),
            entry,
            origin_thread: None,
        },
        "Synthetic task".into(),
        (entry == Entry::ReviewEntry).then(|| pr.clone()),
    );
    let observation = Observation {
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Clean(pr.head.clone())),
        forge: Observed::Known(if entry == Entry::ReviewEntry {
            Forge::Open {
                pr,
                checks: CheckState::Ready,
            }
        } else {
            Forge::Absent
        }),
    };
    let _ = task.reconcile(&observation);
    let instance = task.next_launch_instance().expect("instance");
    let profile = continuation_profile();
    let title = "fixture".into();
    let parent_thread = parent.as_ref().map(|parent| parent.thread.clone());
    let (dispatch, thread) = if let Some(parent) = parent {
        (
            Dispatch::Delegate {
                title,
                profile,
                parent,
            },
            crate::launch::delegated_child(&instance),
        )
    } else {
        (Dispatch::Create { title, profile }, THREAD.into())
    };
    let inputs = RunRequest {
        parent: parent_thread,
        binding,
        dispatch,
        text: "Frozen prompt".into(),
    }
    .inputs(&instance, thread, 1)
    .expect("inputs");
    let _ = task
        .reserve_launch(&observation, inputs, &[4; 32])
        .expect("reserve");
    (task, observation, instance)
}

#[tokio::test]
async fn a_sibling_helper_needs_a_quiet_bound_shell_row_and_never_hides_other_work() {
    let checkout = checkout_fixture();
    let root = checkout.path().canonicalize().expect("canonical checkout");
    let binding = binding(&root);
    let (mut task, _, instance) = reserve_entry(binding.clone(), Entry::Brief);
    task.record_send(&instance, 1).expect("record worker send");
    assert_eq!(task.threads().get(nucleus_core::Role::Worker), Some(THREAD));
    for (status, unrelated, expected) in [
        ("completed", false, true),
        ("running", false, false),
        ("completed", true, false),
        ("unknown", false, false),
    ] {
        let client = T3::new("http://127.0.0.1:9", "fixture").unwrap();
        let observed = snapshot(&binding, &instance, status, false);
        client
            .rpc
            .fixture_shell(&json!({"kind":"snapshot","snapshot":{
                "snapshotSequence":16, "projects":[], "threads":[shell_row(&observed)]
            }}));
        let mut pass = client.fixture_pass().for_task(&task, None);
        pass.evidence = std::sync::Arc::new(crate::PassEvidence {
            processes: tokio::sync::OnceCell::new_with(Some(Ok(
                crate::Inventory::bound_helper_fixture(&root, THREAD, unrelated),
            ))),
            ..crate::PassEvidence::default()
        });
        assert_eq!(
            pass.quiet(&binding, "fixture-reviewer", None)
                .await
                .unwrap(),
            expected
        );
        assert!(client.host_calls().is_empty());
    }
}

fn snapshot(binding: &Binding, instance: &str, state: &str, archived: bool) -> Value {
    json!({
        "kind": "snapshot",
        "snapshotSequence": 16,
        "projection": {
            "thread": { "id": THREAD, "projectId": binding.project_id, "worktreePath": binding.worktree_path, "branch": binding.branch,
                "archivedAt": archived.then_some("2026-11-23T16:00:00Z"),
                "activeRunId":null,"pendingRuntimeRequest":null },
            "runs": [{ "id": NATIVE_RUN, "status": state, "userMessageId": format!("{instance}-message") }],
            "messages": [],
            "runtimeRequests": [],
            "providerThreads": [],
            "turnItems": [],
        }
    })
}

fn shell_row(view: &Value) -> Value {
    let mut row = view["projection"]["thread"].clone();
    let run = &view["projection"]["runs"][0];
    row["status"] = run["status"].clone();
    row["latestRunId"] = run["id"].clone();
    row["activeRunId"] = Value::Null;
    row["pendingRuntimeRequest"] = Value::Null;
    row["pendingBackgroundTasks"] = json!([]);
    row
}

fn archived_shell_reply(revision: u64, row: &Value) -> (&'static str, Response) {
    (
        "orchestration.getArchivedShellSnapshot",
        Response::Value(json!({
            "snapshotSequence":revision,"projects":[],"threads":[row],
        })),
    )
}

fn hold_shell(client: &T3, view: &Value) {
    client
        .rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":view["snapshotSequence"], "projects":[], "threads":[shell_row(view)]
        }}));
}

#[tokio::test]
async fn missing_or_steered_history_does_not_prove_a_terminal_role_run() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (task, _, instance) = reserve(binding.clone());
    let message = format!("{instance}-message");
    let exact = snapshot(&binding, &instance, "completed", false);
    let mut steered = exact.clone();
    steered["projection"]["runs"][0]["userMessageId"] = json!("other-message");
    steered["projection"]["messages"] = json!([{"id":message,"runId":NATIVE_RUN}]);
    let mut truncated = exact.clone();
    truncated["hasMoreHistory"] = json!(true);
    truncated["historyCursor"] = json!("more");
    truncated["projection"]["runs"] = json!([]);
    let (client, server) = server(
        [exact.clone(), steered, truncated]
            .into_iter()
            .map(|reply| ("orchestration.subscribeThread", Response::Snapshot(reply)))
            .collect(),
    )
    .await;
    let pass = quiet_pass(&client);
    let run = task.run().unwrap();
    let seen = |state| Host::Current {
        instance: instance.clone(),
        state,
    };
    hold_shell(&client, &exact);
    assert_eq!(
        pass.observe_run(run, 2).await.unwrap().host,
        seen(RunState::Ended)
    );
    hold_shell(&client, &exact);
    assert_eq!(
        pass.observe_run(run, 3).await.unwrap().host,
        seen(RunState::IdleWithoutTerminalRun)
    );
    hold_shell(&client, &exact);
    assert!(matches!(
        pass.observe_run(run, 4).await,
        Err(HostError::Uncertain)
    ));
    server.await.unwrap();

    let inputs = T3::prepare_report_reminder(
        task.run().unwrap(),
        &binding,
        "reminder",
        2,
        "Report your earlier work.",
    )
    .unwrap();
    let wire: Value = serde_json::from_str(&inputs.input).unwrap();
    assert_eq!(inputs.thread, THREAD);
    assert_eq!(
        wire["selection"],
        json!({"instanceId":"fixture-provider","model":"fixture-model"})
    );
    assert_eq!(wire["payload"]["commandId"], "reminder");
    assert_eq!(wire["payload"]["messageId"], "reminder-message");
    assert_eq!(wire["payload"]["modelSelection"], wire["selection"]);
    assert_eq!(
        wire["payload"]["dispatchMode"],
        json!({"type":"queue_after_active"})
    );
    assert!(wire["payload"].get("freshContext").is_none());
}

fn absent() -> Response {
    missing_thread(THREAD)
}

fn missing_thread(thread: &str) -> Response {
    Response::Failure(json!([{"_tag":"Fail","error":{
        "_tag":"OrchestrationV2GetThreadProjectionError","threadId":thread,
        "cause":{"name":"ProjectionStoreThreadNotFoundError","message": format!("No orchestration projection exists for thread {thread}.")},
    }}]))
}

#[tokio::test]
async fn an_expired_parent_and_absent_exact_child_settle_without_resending() {
    Box::pin(expired_parent_with_absent_child(true)).await;
    Box::pin(expired_parent_with_absent_child(false)).await;
}

async fn expired_parent_with_absent_child(sent: bool) {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let parent = crate::ParentRun {
        thread: crate::parent_thread(checkout.path()),
        run: NATIVE_RUN.into(),
        node: "parent-root".into(),
    };
    let (mut task, mut observation, instance) =
        reserve_with_parent(binding.clone(), Entry::Brief, Some(parent));
    if sent {
        task.record_send(&instance, 1).expect("previous send");
    }
    let run = task.run().expect("reservation");
    let child = &run.launch().thread;
    let read = "orchestration.subscribeThread";
    let (client, native) = server(vec![
        (read, missing_thread(child)),
        (
            read,
            Response::ParentSnapshot(parent_snapshot(&binding, "completed", false)),
        ),
        (read, missing_thread(child)),
    ])
    .await;
    let observed = if sent {
        quiet_pass(&client).observe_run(run, 2).await
    } else {
        // A reservation with no send intent must be discardable without a process census.
        let pass = client.pass(checkout.path());
        pass.evidence
            .sent
            .store(true, std::sync::atomic::Ordering::Release);
        pass.observe_run(run, 2).await
    }
    .expect("fresh observations");
    assert_eq!(
        observed.host,
        Host::Current {
            instance,
            state: RunState::ParentEnded
        }
    );
    observation.host = Observed::Known(observed.host);
    let _ = task.reconcile(&observation);
    assert!(task.run().is_none());
    assert_eq!(task.phase(), Phase::Working);
    native.await.expect("reads only");
}

fn parent_snapshot(binding: &Binding, state: &str, archived: bool) -> Value {
    let mut reply = snapshot(binding, "parent", state, archived);
    let projection = &mut reply["projection"];
    projection["thread"]["id"] = json!(crate::parent_thread(Path::new(&binding.worktree_path)));
    projection["thread"]["providerInstanceId"] = json!("fixture-acp");
    projection["thread"]["modelSelection"] = json!({"instanceId":"fixture-acp","model":"nucleus"});
    projection["runs"][0]["rootNodeId"] = json!("parent-root");
    projection["runs"][0]["userMessageId"] = json!("fixture-parent-command-message");
    projection["subagents"] = json!([{"id":"child-node","childThreadId":THREAD,"origin":"app_owned","status":"completed"}]);
    reply
}

#[tokio::test]
async fn a_parent_anchors_the_frozen_role_launch_to_its_exact_root_node() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let mut bounded = parent_snapshot(&binding, "running", false);
    bounded["hasMoreHistory"] = json!(true);
    bounded["historyCursor"] = json!("earlier-timeline");
    bounded["turnItemsOmitLocalVisible"] = json!(true);
    bounded["projection"]["messages"] = json!([]);
    bounded["projection"]["turnItems"] = json!([]);
    let (client, native) = server(vec![(
        "orchestration.subscribeThread",
        Response::ParentSnapshot(bounded),
    )])
    .await;
    let parent = client
        .live_parent(&binding, "fixture-acp", "fixture-parent-command")
        .await
        .expect("parent read")
        .expect("live parent and root node");
    let profile = RoleProfile {
        instance_id: "fixture-worker".into(),
        model: "fixture".into(),
        runtime_mode: "full-access".into(),
        options: Vec::new(),
    };
    let inputs = quiet_pass(&client)
        .prepare_launch(crate::LaunchRequest {
            binding,
            parent: Some(parent),
            reuse_parent: false,
            via: &nucleus_core::Launch::Create,
            profile: &profile,
            instance: "task-fixture-run-1",
            title: "Worker".into(),
            started_at: 1,
            text: "Synthetic brief".into(),
        })
        .expect("frozen role wire");
    assert_eq!(inputs.thread, "thread:delegated-task:task-fixture-run-1");
    let wire: Value = serde_json::from_str(&inputs.input).expect("run input");
    assert_eq!(wire["payload"]["type"], "delegated_task.request");
    assert_eq!(wire["payload"]["parentRunId"], NATIVE_RUN);
    assert_eq!(wire["payload"]["parentNodeId"], "parent-root");
    assert!(wire["payload"].get("workspaceStrategy").is_none());
    native.await.expect("native trace");
}

fn hold_checkpoint() -> crate::HoldCheckpoint {
    crate::HoldCheckpoint {
        after_run: None,
        recorded_at_ms: 0,
        short_turns: 0,
        preparing_launch: true,
    }
}

#[tokio::test]
async fn parent_launch_replay_keeps_the_original_wire() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let thread = crate::parent_thread(checkout.path());
    let command = format!("{thread}-launch");
    let launch = "orchestration.launchThread";
    let (host, native) = server(vec![
        (launch, Response::Success),
        (launch, Response::Success),
    ])
    .await;
    let prepare = |title, prompt, prior| {
        crate::T3::prepare_parent_hold(
            &binding,
            "nucleus-rust",
            title,
            prompt,
            crate::ParentShell::Missing,
            prior,
            hold_checkpoint(),
        )
        .unwrap()
    };
    let first = prepare("Original task", "Original prompt", None);
    let expected = first.freeze().prompt().unwrap().to_owned();
    let frozen = serde_json::to_string(first.freeze()).unwrap();
    host.write_parent(first, |_| Ok(())).await.unwrap();

    let mut replay = prepare("Edited task", "Edited prompt", Some((&command, false)));
    replay
        .use_frozen(serde_json::from_str(&frozen).unwrap())
        .unwrap();
    host.write_parent(replay, |_| Ok(())).await.unwrap();
    let sent = native.await.unwrap();
    assert_eq!(sent[0].payload.get(), sent[1].payload.get());
    let payload: Value = serde_json::from_str(sent[1].payload.get()).unwrap();
    assert_eq!(payload["commandId"], command);
    assert_eq!(payload["initialMessage"]["text"], expected);
    assert!(expected.starts_with("Original prompt ["));
}

#[tokio::test]
async fn a_rejected_initial_message_retries_as_a_hold_on_the_created_parent() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let thread = crate::parent_thread(checkout.path());
    let id = format!("{thread}-launch");
    let cause = json!([{"_tag":"Fail","error":{
        "_tag":"OrchestrationV2ThreadLaunchError", "commandId":id, "projectId":binding.project_id,
        "message":"Failed to launch thread", "cause":{
            "name":"ThreadLaunchError",
            "message":format!("Thread launch {id} failed during dispatch-message."),
            "cause":{
                "name":"OrchestratorCommandPreviouslyRejectedError",
                "message":format!("Command {id}:initial-message was previously rejected: fixture.")
            }
        }
    }}]);
    let (host, native) = server(vec![(
        "orchestration.launchThread",
        Response::Failure(cause),
    )])
    .await;
    let write = crate::T3::prepare_parent_hold(
        &binding,
        "fixture-acp",
        "Fixture",
        "Starting work",
        crate::ParentShell::Missing,
        None,
        hold_checkpoint(),
    )
    .unwrap();
    let mut frozen = write.freeze().clone();
    assert!(matches!(
        host.write_parent(write, |_| Ok(())).await,
        Err(crate::ParentSendError::InitialMessageRejected)
    ));
    let command = frozen.replace_rejected_command(true).unwrap();
    let wire = serde_json::to_value(frozen).unwrap();
    assert_ne!(command, id);
    assert_eq!(wire["method"], "continue");
    assert_eq!(wire["payload"]["type"], "message.dispatch");
    assert_eq!(wire["payload"]["threadId"], thread);
    assert_eq!(wire["payload"]["messageId"], crate::message_id(&command));
    native.await.unwrap();
}

#[tokio::test]
async fn a_hold_uses_the_shell_and_rechecks_binding_and_turn_at_the_wire() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let parent = parent_snapshot(&binding, "completed", false);
    let mut row = shell_row(&parent);
    let (host, native) = server(vec![
        ("orchestration.dispatchCommand", Response::Success),
        ("orchestration.dispatchCommand", Response::Success),
    ])
    .await;
    host.rpc.use_held_shell();
    host.rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":16, "threads":[row], "projects":[]
        }}));
    let prepare = |previous| {
        crate::T3::prepare_parent_hold(
            &binding,
            "fixture-acp",
            "Fixture",
            "Preparing the task thread.",
            host.parent_shell(&binding, "fixture-acp").unwrap(),
            previous,
            hold_checkpoint(),
        )
        .unwrap()
    };
    let first = prepare(None);
    let stale = prepare(None);
    let command = first.command_id().unwrap().to_owned();
    row["providerInstanceId"] = json!("other-provider");
    host.rpc
        .fixture_shell(&json!({"kind":"thread.updated","sequence":17,"thread":row}));
    assert!(matches!(
        host.write_parent(stale, |_| Ok(())).await,
        Err(crate::ParentSendError::NotSent(HostError::Binding))
    ));
    row["providerInstanceId"] = json!("fixture-acp");
    row["status"] = json!("queued");
    row["latestRunId"] = json!("queued-native");
    row["latestRunStartedAt"] = Value::Null;
    row["latestRunCompletedAt"] = Value::Null;
    host.rpc
        .fixture_shell(&json!({"kind":"thread.updated","sequence":18,"thread":row}));
    assert!(matches!(
        host.write_parent(first, |_| Ok(())).await,
        Err(crate::ParentSendError::NotSent(HostError::Uncertain))
    ));
    let crate::ParentShell::Listed(turn) = host.parent_shell(&binding, "fixture-acp").unwrap()
    else {
        panic!("expected the queued row");
    };
    assert!(turn.queued);
    assert_eq!(turn.latest_run.as_deref(), Some("queued-native"));
    assert_eq!(turn.finished_ms, None);

    host.write_parent(prepare(Some((&command, false))), |_| Ok(()))
        .await
        .unwrap();
    host.write_parent(prepare(Some((&command, false))), |_| Ok(()))
        .await
        .unwrap();
    let sent = native.await.unwrap();
    assert_eq!(sent[0].payload.get(), sent[1].payload.get());
    let payload: Value = serde_json::from_str(sent[0].payload.get()).unwrap();
    assert_eq!(payload["dispatchMode"]["type"], "queue_after_active");
    assert_eq!(
        payload["modelSelection"],
        json!({"instanceId":"fixture-acp","model":"nucleus"})
    );
}

#[tokio::test]
async fn parent_unarchive_requires_current_archived_shell_evidence() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let archived = parent_snapshot(&binding, "completed", true);
    let row = shell_row(&archived);
    let mut busy = row.clone();
    busy["pendingBackgroundTasks"] = json!([{"kind":"command","taskId":"late-work"}]);
    let mut responses: Vec<_> = [(15, &row), (16, &busy), (17, &row), (18, &row)]
        .into_iter()
        .map(|(revision, row)| archived_shell_reply(revision, row))
        .collect();
    responses.push(("orchestration.dispatchCommand", Response::Success));
    let (host, native) = server(responses).await;
    let shell = |revision| {
        host.rpc
            .fixture_shell(&json!({"kind":"snapshot","snapshot":{
                "snapshotSequence":revision,"projects":[],"threads":[]
            }}));
    };
    shell(16);
    let prepare = || host.prepare_parent_unarchive(&binding, "fixture-acp");
    assert!(prepare().await.unwrap().is_none());
    assert!(prepare().await.unwrap().is_none());
    let stale = prepare()
        .await
        .unwrap()
        .expect("the quiet parent should unarchive");
    host.rpc.clear_shell();
    shell(18);
    assert!(matches!(
        host.write_parent(stale, |_| Ok(())).await,
        Err(crate::ParentSendError::NotSent(HostError::Uncertain))
    ));
    let write = prepare().await.unwrap().expect("the new archive evidence");
    host.write_parent(write, |_| Ok(())).await.unwrap();
    let requests = native.await.unwrap();
    let payload: Value = serde_json::from_str(requests.last().unwrap().payload.get()).unwrap();
    assert_eq!(payload["type"], "thread.unarchive");
    assert_eq!(payload["threadId"], row["id"]);
}

#[tokio::test]
async fn a_retained_read_cannot_infer_absence_when_the_held_shell_lists_the_thread() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (host, native) = server(vec![(
        "orchestration.subscribeThread",
        missing_thread(THREAD),
    )])
    .await;
    host.rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":16, "projects":[], "threads":[
                snapshot(&binding, "worker", "completed", false)["projection"]["thread"]
            ]
        }}));
    assert!(matches!(
        quiet_pass(&host)
            .observe_retained_role(&binding, THREAD)
            .await,
        Err(HostError::HeldThreadMissing { revision: Some(16) })
    ));
    assert_eq!(native.await.unwrap().len(), 1);
}

#[test]
fn native_child_lineage_binds_the_exact_parent_without_another_read() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let parent = crate::parent_thread(checkout.path());
    let parse = |value| crate::Projection::parse(value, &binding, THREAD).expect("exact child");

    let mut child = snapshot(&binding, "child", "running", false);
    assert!(!parse(child.clone()).belongs_to_parent(&parent, false));
    child["projection"]["thread"]["lineage"] = json!({
        "parentThreadId": parent,
        "rootThreadId": parent,
        "relationshipToParent": "subagent",
    });
    assert!(parse(child.clone()).belongs_to_parent(&parent, false));
    child["projection"]["thread"]["lineage"]["parentThreadId"] = json!("other-parent");
    assert!(!parse(child.clone()).belongs_to_parent(&parent, true));
    child["projection"]["thread"]["lineage"]["parentThreadId"] = json!(parent);
    child["projection"]["thread"]["lineage"]["relationshipToParent"] = json!("fork");
    assert!(!parse(child).belongs_to_parent(&parent, false));
}

fn revoke(task: &mut Task, observation: &Observation) {
    task.command(
        Command::Cancel,
        &Authority::Operator {
            actor: "fixture".into(),
        },
        observation,
    )
    .expect("cancel");
}

async fn send(pass: &impl TaskHost, task: &mut Task) -> Result<SendOutcome, HostError> {
    let mut permit = pass
        .authorize_send(task.run().expect("reserved run"))
        .await?;
    if let Some(unarchive) = permit.unarchive() {
        pass.write_control(unarchive).await?;
        permit = pass
            .authorize_send(task.run().expect("reserved run"))
            .await?;
    }
    pass.send(permit.record(task)?).await
}

#[tokio::test]
async fn unrelated_shared_scratch_process_does_not_block_a_worker_send() {
    let checkout = checkout_fixture();
    let scratch = checkout_fixture();
    let root = scratch.path().canonicalize().expect("scratch root");
    let run_scratch = root.join("fixture").join("run-1");
    let unrelated = root.join("other-job");
    std::fs::create_dir_all(&run_scratch).expect("run directory");
    std::fs::set_permissions(&run_scratch, Permissions::from_mode(0o700))
        .expect("private run directory");
    std::fs::create_dir(&unrelated).expect("shared fixture directory");
    let checkout = checkout.path().canonicalize().expect("checkout");
    let (mut task, _, _) = reserve_entry(binding(&checkout), Entry::Brief);
    let (client, server) = server(vec![
        ("orchestration.subscribeThread", absent()),
        ("orchestration.launchThread", Response::Success),
    ])
    .await;
    let mut pass = client.pass(&root).for_task(&task, Some(run_scratch));
    pass.evidence = std::sync::Arc::new(crate::PassEvidence {
        processes: tokio::sync::OnceCell::new_with(Some(Ok(crate::Inventory::cwd_fixture(
            &unrelated,
        )))),
        ..crate::PassEvidence::default()
    });
    assert_eq!(
        send(&pass, &mut task).await.expect("send worker"),
        SendOutcome::Sent
    );
    assert!(task.run().expect("run").last_send_at_ms().is_some());
    assert_eq!(server.await.expect("scripted host").len(), 2);
}

#[tokio::test]
async fn fresh_roles_can_start_while_the_checkout_has_a_writer() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    for (mut task, _, _) in [
        reserve(binding.clone()),
        reserve_entry(binding.clone(), Entry::Brief),
    ] {
        let (client, server) = server(vec![
            ("orchestration.subscribeThread", absent()),
            ("orchestration.launchThread", Response::Success),
        ])
        .await;
        let mut pass = quiet_pass(&client);
        pass.evidence = std::sync::Arc::new(crate::PassEvidence {
            processes: tokio::sync::OnceCell::new_with(Some(Ok(crate::Inventory::cwd_fixture(
                Path::new(&binding.worktree_path),
            )))),
            ..crate::PassEvidence::default()
        });
        assert_eq!(send(&pass, &mut task).await.unwrap(), SendOutcome::Sent);
        assert_eq!(server.await.unwrap().len(), 2);
    }
}

async fn stop(
    pass: &impl TaskHost,
    run: &nucleus_core::Run,
    binding: &Binding,
    now: u64,
    archive: bool,
) -> Result<StopProgress, HostError> {
    match pass.stop(run, binding, now, archive).await? {
        StopProgress::Write(dispatch) => {
            pass.write_control(dispatch).await?;
            Ok(StopProgress::Waiting)
        }
        progress => Ok(progress),
    }
}

async fn ready_notice(
    client: &T3,
    notice: &nucleus_core::QuestionDelivery,
) -> crate::NoticeAuthorization {
    client
        .authorize_notice(notice)
        .await
        .expect("read planner")
        .expect("authorized")
}

#[tokio::test]
async fn terminal_role_requires_a_quiet_bound_row_at_or_after_its_revision() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (task, _, instance) = reserve(binding.clone());
    let mut terminal = snapshot(&binding, &instance, "completed", false);
    terminal["hasMoreHistory"] = json!(true);
    terminal["historyCursor"] = json!("earlier-items");
    let detail = terminal["projection"].as_object_mut().unwrap();
    detail.remove("providerThreads");
    detail.remove("turnItems");
    let row = shell_row(&terminal);
    let probe = "orchestration.subscribeThread";
    let (host, requests) = server(
        (0..5)
            .map(|_| (probe, Response::Snapshot(terminal.clone())))
            .collect(),
    )
    .await;
    let pass = host.fixture_pass();
    let run = task.run().unwrap();
    let observed = |state| Host::Current {
        instance: instance.clone(),
        state,
    };
    host.rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":15, "projects":[], "threads":[row]
        }}));
    host.rpc
        .fixture_shell(&json!({"kind":"thread.updated","sequence":16,"thread":{"id":"unrelated"}}));
    assert_eq!(
        pass.observe_run(run, 2).await.unwrap().host,
        observed(RunState::Running)
    );
    let mut busy = row.clone();
    busy["pendingBackgroundTasks"] = json!([{"kind":"command","taskId":"older-run"}]);
    let mut unknown = row.clone();
    unknown
        .as_object_mut()
        .unwrap()
        .remove("pendingBackgroundTasks");
    let mut foreign = row.clone();
    foreign["branch"] = json!("wrong-branch");
    for (revision, thread) in [(17, busy), (18, unknown), (19, foreign)] {
        host.rpc
            .fixture_shell(&json!({"kind":"thread.updated","sequence":revision,"thread":thread}));
        assert_eq!(
            pass.observe_run(run, 2).await.unwrap().host,
            observed(RunState::Running)
        );
    }
    host.rpc
        .fixture_shell(&json!({"kind":"thread.updated","sequence":20,"thread":row}));
    assert_eq!(
        pass.observe_run(run, 3).await.unwrap().host,
        observed(RunState::Ended)
    );
    assert_eq!(requests.await.unwrap().len(), 5);
}

#[tokio::test]
async fn activity_comes_only_from_the_launchs_own_native_run() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (task, _, instance) = reserve(binding.clone());
    let mut command = snapshot(&binding, &instance, "running", false);
    command["projection"]["turnItems"] = json!([
        {"type":"command_execution","status":"running","runId":"older-turn",
         "input":"git status","startedAt":"2026-11-23T16:01:00Z"},
        {"type":"file_change","status":"completed","runId":NATIVE_RUN,
         "fileName":"finished.rs","startedAt":"2026-11-23T16:01:00Z"},
        {"type":"command_execution","status":"running","runId":NATIVE_RUN,
         "input":"/bin/zsh -lc 'cargo test --token fixture-private-value'","startedAt":"2026-11-23T16:00:00Z"}
    ]);
    let mut file = command.clone();
    file["projection"]["turnItems"][2] = json!({
        "type":"file_change","status":"running","runId":NATIVE_RUN,
        "fileName": format!("{}/src/lib.rs", binding.worktree_path)
    });
    let mut steer = command.clone();
    steer["projection"]["runs"][0]["userMessageId"] = json!("original-message");
    steer["projection"]["messages"] =
        json!([{"id":format!("{instance}-message"),"runId":NATIVE_RUN}]);
    let (client, server) = server(
        [command, file, steer]
            .into_iter()
            .map(|reply| ("orchestration.subscribeThread", Response::Snapshot(reply)))
            .collect(),
    )
    .await;
    let pass = quiet_pass(&client);
    let run = task.run().expect("run");
    let seen = pass.observe_run(run, 2).await.expect("exact activity");
    assert_eq!(
        seen.host,
        Host::Current {
            instance,
            state: RunState::Running
        }
    );
    assert_eq!(
        seen.activity,
        Some(crate::RunActivity {
            label: "Running Rust tests".into(),
            started_at: Some(1_795_449_600_000),
        })
    );
    assert_eq!(
        pass.observe_run(run, 3)
            .await
            .expect("file activity")
            .activity,
        Some(crate::RunActivity {
            label: "Editing src/lib.rs".into(),
            started_at: None
        })
    );
    assert!(
        pass.observe_run(run, 4)
            .await
            .expect("steered message")
            .activity
            .is_none()
    );
    server.await.expect("scripted host");
}

#[tokio::test]
async fn usage_limit_requires_the_latest_failed_root_error_on_the_exact_run() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (task, _, instance) = reserve(binding.clone());
    let mut limited = snapshot(&binding, &instance, "failed", false);
    let run = &mut limited["projection"]["runs"][0];
    run["rootNodeId"] = json!("root");
    run["completedAt"] = json!("2026-11-23T16:00:00Z");
    run["providerInstanceId"] = json!("fixture-provider");
    limited["projection"]["turnItems"] = json!([{
        "id": "error", "type":"error", "status":"failed", "runId":NATIVE_RUN,
        "nodeId":"root", "ordinal":1, "updatedAt":"2026-11-23T16:00:00Z",
        "failure":{"class":"usage_limit","code":"api_error_429","message":"fixture only",
                   "retryable":true,"resetAt":"2026-11-23T16:05:00Z"}
    }]);
    let mut no_reset = limited.clone();
    no_reset["projection"]["turnItems"][0]["failure"]["resetAt"] = Value::Null;
    let mut running = limited.clone();
    running["projection"]["runs"][0]["status"] = json!("running");
    let mut completed = limited.clone();
    completed["projection"]["runs"][0]["status"] = json!("completed");
    let mut older_run = limited.clone();
    older_run["projection"]["turnItems"][0]["runId"] = json!("older-run");
    let mut child_node = limited.clone();
    child_node["projection"]["turnItems"][0]["nodeId"] = json!("child");
    let mut text_only = limited.clone();
    text_only["projection"]["turnItems"][0]["failure"] =
        json!({"class":"provider_error","message":"usage limit reached","code":"api_error_429"});
    let with_error = |message: &str| {
        let mut view = no_reset.clone();
        view["projection"]["turnItems"][0]["failure"] = json!({
            "class":"provider_error", "code":null, "message":message
        });
        view
    };
    let balance = with_error(
        r#"402: {"type":"invalid_request_error","message":"Insufficient balance. Top up at the provider."}"#,
    );
    let quota = with_error(r#"429: {"error":{"code":"insufficient_quota"}}"#);
    let throttle = with_error(r#"429: {"error":{"type":"rate_limit_error"}}"#);
    let mut superseded = limited.clone();
    superseded["projection"]["turnItems"]
        .as_array_mut()
        .expect("items")
        .push(json!({
            "id": "later", "type":"error", "status":"failed", "runId":NATIVE_RUN,
            "nodeId":"root", "ordinal":2, "updatedAt":"2026-11-23T16:00:00Z",
            "failure":{"class":"provider_error","message":"latest terminal error"}
        }));
    let mut steer = limited.clone();
    steer["projection"]["runs"][0]["userMessageId"] = json!("another-message");
    steer["projection"]["messages"] =
        json!([{"id":format!("{instance}-message"),"runId":NATIVE_RUN}]);

    let views = [
        limited, no_reset, balance, quota, throttle, running, completed, older_run, child_node,
        text_only, superseded, steer,
    ];
    let steps = views
        .iter()
        .cloned()
        .map(|reply| ("orchestration.subscribeThread", Response::Snapshot(reply)))
        .collect();
    let (client, server) = server(steps).await;
    let pass = quiet_pass(&client);
    let run = task.run().expect("own launch");
    for (view, (status, evidence)) in views.iter().zip([
        (RunState::UsageLimited, Some(Some(1_795_449_900_000))),
        (RunState::UsageLimited, Some(None)),
        (RunState::UsageLimited, Some(None)),
        (RunState::UsageLimited, Some(None)),
        (RunState::Ended, None),
        (RunState::Running, None),
        (RunState::Ended, None),
        (RunState::Ended, None),
        (RunState::Ended, None),
        (RunState::Ended, None),
        (RunState::Ended, None),
        (RunState::IdleWithoutTerminalRun, None),
    ]) {
        hold_shell(&client, view);
        let seen = pass.observe_run(run, 2).await.expect("native observation");
        assert_eq!(
            seen.host,
            Host::Current {
                instance: instance.clone(),
                state: status
            }
        );
        assert_eq!(
            seen.provider_limit,
            evidence.map(|reset_at_ms| crate::ProviderLimit {
                instance: "fixture-provider".into(),
                ended_at_ms: 1_795_449_600_000,
                reset_at_ms,
            })
        );
    }
    server.await.expect("scripted host");
}

#[tokio::test]
async fn windowed_terminal_limit_uses_the_failed_runs_root_or_its_shell_summary() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (task, _, instance) = reserve(binding.clone());
    let mut view = snapshot(&binding, &instance, "failed", false);
    view["hasMoreHistory"] = json!(true);
    view["historyCursor"] = json!("earlier-items");
    let ended = "2026-11-25T16:00:00Z";
    let reset = "2026-11-28T09:00:00Z";
    let p = &mut view["projection"];
    p["runs"][0]["rootNodeId"] = json!("root");
    p["runs"][0]["completedAt"] = json!(ended);
    p["runs"][0]["providerInstanceId"] = json!("fixture-provider");
    p["turnItems"] = json!([{"id":"last","type":"error","status":"failed","runId":NATIVE_RUN,
        "nodeId":"root","updatedAt":ended,"ordinal":176,
        "failure":{"class":"usage_limit","code":"api_error_429","resetAt":reset}}]);
    let mut shell = p["thread"].clone();
    shell["pendingBackgroundTasks"] = json!([]);
    shell["latestRunId"] = json!(NATIVE_RUN);
    shell["status"] = json!("failed");
    shell["visibleItemCount"] = json!(177);
    shell["lastErrorClass"] = json!("usage_limit");
    shell["usageLimitResetAt"] = json!(reset);
    let msg = format!("{instance}-message");
    let parsed = crate::Projection::parse(view.clone(), &binding, THREAD).unwrap();
    let limit = parsed
        .provider_limit(&msg)
        .expect("terminal error in bounded window");
    view["turnItemsOmitLocalVisible"] = json!(true);
    view["projection"]["turnItems"] = json!([]);
    let mut unmatched = crate::Projection::parse(view.clone(), &binding, THREAD).unwrap();
    let mut wrong = shell.clone();
    wrong["latestRunId"] = json!("unrelated-run");
    unmatched.use_shell_failure(&wrong, true);
    assert_eq!(unmatched.provider_limit(&msg), None);
    let (host, native) = server(vec![(
        "orchestration.subscribeThread",
        Response::Snapshot(view),
    )])
    .await;
    host.rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":16,"projects":[],"threads":[shell]
        }}));
    let seen = quiet_pass(&host)
        .observe_run(task.run().unwrap(), 2)
        .await
        .unwrap();
    assert_eq!(seen.provider_limit, Some(limit));
    assert_eq!(
        seen.host,
        Host::Current {
            instance,
            state: RunState::UsageLimited
        }
    );
    assert_eq!(native.await.unwrap().len(), 1);
}

#[tokio::test]
async fn an_unsent_revoked_reservation_clears_without_contacting_t3() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (mut task, observation, instance) = reserve(binding.clone());
    revoke(&mut task, &observation);
    let client = T3::new("http://127.0.0.1:9", "fixture-key").expect("client");
    assert_eq!(
        quiet_pass(&client)
            .stop(task.run().expect("run"), &binding, 2, true)
            .await
            .expect("unsent settled"),
        StopProgress::Settled(Host::Current {
            instance,
            state: RunState::ReadyToSend
        })
    );
}

#[tokio::test]
async fn same_head_revoked_replay_interrupts_only_the_reserved_run() {
    Box::pin(revoked_replay(false)).await;
}

#[tokio::test]
async fn superseded_review_replay_archives_after_exact_stop() {
    Box::pin(revoked_replay(true)).await;
}

fn retained_reviewer(binding: Binding) -> (Task, Observation, String) {
    let (mut task, mut observation, previous) = reserve(binding);
    revoke(&mut task, &observation);
    observation.host = Observed::Known(Host::Current {
        instance: previous.clone(),
        state: RunState::Ended,
    });
    let _ = task.reconcile(&observation);
    task.command(
        Command::Move(Phase::Reviewing),
        &Authority::Operator {
            actor: "fixture".into(),
        },
        &observation,
    )
    .expect("review again");
    (task, observation, previous)
}

#[tokio::test]
async fn next_review_dispatches_to_its_settled_thread_after_the_operator_snooze() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (mut task, mut observation, previous) = retained_reviewer(binding.clone());

    let archived = snapshot(&binding, &previous, "interrupted", true);
    let mut restored = snapshot(&binding, &previous, "interrupted", false);
    restored["hasMoreHistory"] = json!(true);
    restored["historyCursor"] = json!("50000-earlier-items");
    restored["turnItemsOmitLocalVisible"] = json!(true);
    restored["projection"]["turnItems"] = json!([]);
    restored["projection"]["thread"]["updatedAt"] = json!("2026-11-24T16:42:26Z");
    let mut restored_row = shell_row(&restored);
    restored_row["visibleItemCount"] = json!(50_000);
    let mut operator_snoozed = restored.clone();
    operator_snoozed["projection"]["thread"]["snoozedUntil"] = json!("2099-06-01T12:00:00.000Z");
    let mut settled = restored.clone();
    settled["snapshotSequence"] = json!(17);
    settled["projection"]["thread"]["settledAt"] = json!("2026-11-23T16:00:00Z");
    let settled_row = shell_row(&settled);
    let probe = "orchestration.subscribeThread";
    let command = "orchestration.dispatchCommand";
    let archive_row = shell_row(&archived);
    let (client, server) = server(vec![
        (probe, Response::Snapshot(archived.clone())),
        (probe, Response::Snapshot(archived)),
        archived_shell_reply(16, &archive_row),
        (command, Response::Success),
        (probe, Response::Snapshot(operator_snoozed)),
        (probe, Response::Snapshot(settled)),
        (command, Response::Success),
    ])
    .await;
    client
        .rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":15, "projects":[], "threads":[]
        }}));
    let pass = quiet_pass(&client);
    let retained = pass
        .observe_retained_role(&binding, THREAD)
        .await
        .expect("retained thread");
    assert_eq!(
        retained,
        Host::Retained {
            thread: THREAD.into(),
            state: RetainedThread::Queueable
        }
    );
    observation.host = Observed::Known(retained);
    let instance = task.next_launch_instance().expect("next instance");
    let inputs = RunRequest {
        parent: None,
        binding,
        dispatch: Dispatch::Continue {
            profile: continuation_profile(),
        },
        text: "Fresh review".into(),
    }
    .inputs(&instance, THREAD.into(), 2)
    .expect("continuation inputs");
    let _ = task
        .reserve_launch(&observation, inputs, &[4; 32])
        .expect("reserve continuation");
    let permit = pass
        .authorize_send(task.run().expect("run"))
        .await
        .expect("archived child");
    pass.write_control(permit.unarchive().expect("unarchive"))
        .await
        .expect("unarchived");
    publish_row(&client, 16, &restored_row);
    assert!(
        matches!(
            pass.authorize_send(task.run().expect("run")).await,
            Err(HostError::Uncertain)
        ),
        "a continuation must wait for the operator's snooze"
    );
    // The shell change which ends the snooze also retires the snoozed read.
    publish_row(&client, 17, &settled_row);
    let permit = pass
        .authorize_send(task.run().expect("run"))
        .await
        .expect("settled child");
    let dispatch = permit
        .record(&mut task)
        .expect("record settled continuation");
    assert_eq!(pass.send(dispatch).await.unwrap(), SendOutcome::Sent);
    let sent = server.await.expect("scripted host");
    let unarchive: Value = serde_json::from_str(sent[3].payload.get()).expect("unarchive payload");
    let message: Value = serde_json::from_str(sent[6].payload.get()).expect("continuation payload");
    assert_eq!(
        unarchive,
        json!({"type":"thread.unarchive", "threadId":THREAD, "commandId":format!("{instance}-unarchive")})
    );
    assert_eq!(message["type"], "message.dispatch");
    assert_eq!(message["commandId"], instance);
    assert_eq!(message["threadId"], THREAD);
    assert_eq!(message["messageId"], format!("{instance}-message"));
}

fn publish_row(client: &T3, sequence: u64, row: &Value) {
    client
        .rpc
        .fixture_shell(&json!({"kind":"thread.updated","sequence":sequence,"thread":row}));
}

fn continuation_profile() -> RoleProfile {
    RoleProfile {
        instance_id: "fixture-provider".into(),
        model: "fixture-model".into(),
        runtime_mode: "full-access".into(),
        options: Vec::new(),
    }
}

fn reserved_worker_continuation(
    binding: &Binding,
    stored: impl FnOnce(&mut Value),
) -> (Task, String) {
    let (mut task, mut observation, original) = reserve_entry(binding.clone(), Entry::Brief);
    task.record_send(&original, 2).unwrap();
    task.command(
        Command::Move(Phase::Working),
        &Authority::Operator {
            actor: "fixture".into(),
        },
        &observation,
    )
    .expect("supersede the old assignment");
    observation.host = Observed::Known(Host::Current {
        instance: original,
        state: RunState::Ended,
    });
    let _ = task.reconcile(&observation);
    assert!(task.run().is_none());
    let instance = task.next_launch_instance().unwrap();
    observation.host = Observed::Known(Host::Retained {
        thread: THREAD.into(),
        state: RetainedThread::Queueable,
    });
    let mut inputs = RunRequest {
        parent: None,
        binding: binding.clone(),
        dispatch: Dispatch::Continue {
            profile: continuation_profile(),
        },
        text: "Retained worker".into(),
    }
    .inputs(&instance, THREAD.into(), 3)
    .unwrap();
    let mut wire: Value = serde_json::from_str(&inputs.input).unwrap();
    stored(&mut wire);
    inputs.input = wire.to_string();
    task.reserve_launch(&observation, inputs, &[7; 32]).unwrap();
    (task, instance)
}

#[tokio::test]
async fn pinned_worker_queues_while_busy_and_settled_without_workspace_custody() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (mut task, instance) = reserved_worker_continuation(&binding, |_| {});
    assert!(crate::retained_worker_continuation(task.run().unwrap()));
    let mut busy = snapshot(&binding, "other-message", "running", false);
    busy["projection"]["thread"]["providerInstanceId"] = json!("alternate-provider");
    busy["projection"]["thread"]["modelSelection"] =
        json!({"instanceId":"alternate-provider","model":"alternate-model"});
    busy["projection"]["thread"]["settledOverride"] = json!("settled");
    let mut row = busy["projection"]["thread"].clone();
    let (host, native) = server(vec![
        (
            "orchestration.subscribeThread",
            Response::Snapshot(busy.clone()),
        ),
        ("orchestration.subscribeThread", Response::Snapshot(busy)),
        ("orchestration.dispatchCommand", Response::Success),
    ])
    .await;
    host.rpc.use_held_shell();
    host.rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":16,"threads":[row],"projects":[]
        }}));
    let pass = host.pass(checkout.path());
    assert_eq!(
        pass.observe_retained_role(&binding, THREAD).await.unwrap(),
        Host::Retained {
            thread: THREAD.into(),
            state: RetainedThread::Queueable,
        }
    );
    let mut refused = task.clone();
    let dispatch = pass
        .authorize_send(task.run().unwrap())
        .await
        .unwrap()
        .record(&mut refused)
        .unwrap();
    row["snoozedUntil"] = json!("2099-11-24T17:11:15Z");
    host.rpc
        .fixture_shell(&json!({"kind":"thread.updated","sequence":17,"thread":row}));
    assert!(matches!(
        pass.send(dispatch).await,
        Ok(SendOutcome::NotSent(HostError::OperatorSnoozed { .. }))
    ));
    row["snoozedUntil"] = Value::Null;
    host.rpc
        .fixture_shell(&json!({"kind":"thread.updated","sequence":18,"thread":row}));
    assert_eq!(send(&pass, &mut task).await.unwrap(), SendOutcome::Sent);
    let requests = native.await.unwrap();
    let wire: Value = serde_json::from_str(requests.last().unwrap().payload.get()).unwrap();
    assert_eq!(wire["commandId"], instance);
    assert_eq!(
        wire["modelSelection"],
        json!({"instanceId":"fixture-provider","model":"fixture-model"})
    );
    assert_eq!(wire["dispatchMode"]["type"], "queue_after_active");
}

#[tokio::test]
async fn fresh_role_grace_requires_a_successful_missing_delivery_read() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (mut task, _, instance) = reserve(binding.clone());
    task.record_send(&instance, 4).unwrap();
    let (host, native) = server(vec![
        (
            "orchestration.subscribeThread",
            Response::Failure(json!({"_tag":"FixtureUnavailable"})),
        ),
        ("orchestration.subscribeThread", missing_thread(THREAD)),
        (
            "orchestration.subscribeThread",
            Response::Snapshot(snapshot(&binding, &instance, "running", false)),
        ),
    ])
    .await;
    let pass = host.pass(checkout.path());
    let run = task.run().unwrap();
    assert!(matches!(
        pass.observe_run(run, 5).await,
        Err(HostError::Uncertain)
    ));
    let now = tokio::time::Instant::now();
    assert!(matches!(pass.observe_run(run, 5).await,
        Err(HostError::RoleReplyPending { until }) if until > now + std::time::Duration::from_secs(590)
    ));
    assert!(matches!(
        pass.observe_run(run, 5).await.unwrap().host,
        Host::Current {
            state: RunState::Running,
            ..
        }
    ));
    assert_eq!(native.await.unwrap().len(), 3);
}

#[tokio::test]
async fn pinned_reviewer_can_replay_a_queued_send_without_idle_coverage() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (mut task, mut observation, _) = retained_reviewer(binding.clone());
    observation.host = Observed::Known(Host::Retained {
        thread: THREAD.into(),
        state: RetainedThread::Idle,
    });
    let instance = task.next_launch_instance().unwrap();
    let parent = crate::parent_thread(checkout.path());
    let inputs = RunRequest {
        binding: binding.clone(),
        parent: Some(parent.clone()),
        dispatch: Dispatch::Continue {
            profile: continuation_profile(),
        },
        text: "Review the current head".into(),
    }
    .inputs(&instance, THREAD.into(), 3)
    .unwrap();
    let _ = task.reserve_launch(&observation, inputs, &[7; 32]).unwrap();

    let mut window = snapshot(&binding, "unrelated-running-review", "running", false);
    window["hasMoreHistory"] = json!(true);
    window["historyCursor"] = json!("earlier-items");
    window["projection"]["providerThreads"] = Value::Null;
    window["projection"]["thread"]["lineage"] =
        json!({"rootThreadId":parent,"parentThreadId":parent,"relationshipToParent":"subagent"});
    let child = window["projection"]["thread"].clone();
    let (host, native) = server(vec![
        ("orchestration.subscribeThread", Response::Snapshot(window)),
        ("orchestration.dispatchCommand", Response::Success),
    ])
    .await;
    host.rpc.use_held_shell();
    let until_ms = 4_102_444_800_000;
    host.rpc.fixture_shell(&json!({"kind":"snapshot","snapshot":{
        "snapshotSequence":16,"threads":[child,{"id":parent, "snoozedUntil":"2100-01-01T00:00:00Z"}],"projects":[]
    }}));
    let pass = host.pass(checkout.path());
    let permit = pass.authorize_send(task.run().unwrap()).await.unwrap();
    let refused = pass.send(permit.record(&mut task.clone()).unwrap()).await;
    assert!(
        matches!(
            refused,
            Ok(SendOutcome::NotSent(HostError::RetainedParentSnoozed { until })) if until == until_ms
        ),
        "{refused:?}"
    );
    task.record_send(&instance, 4).unwrap();
    assert_eq!(
        pass.observe_retained_role(&binding, THREAD).await.unwrap(),
        Host::Retained {
            thread: THREAD.into(),
            state: RetainedThread::Queueable,
        }
    );
    assert_eq!(
        pass.observe_run(task.run().unwrap(), 5).await.unwrap().host,
        Host::Current {
            instance: instance.clone(),
            state: RunState::ReadyToSend
        }
    );
    let permit = pass.authorize_send(task.run().unwrap()).await.unwrap();
    let mut dispatch = permit.record(&mut task).unwrap();
    dispatch.allow_owned_parent_snoozes(vec![until_ms]);
    assert_eq!(pass.send(dispatch).await.unwrap(), SendOutcome::Sent);
    let requests = native.await.unwrap();
    let wire: Value = serde_json::from_str(requests.last().unwrap().payload.get()).unwrap();
    assert_eq!(wire["commandId"], instance);
    assert_eq!(
        wire["modelSelection"],
        json!({"instanceId":"fixture-provider","model":"fixture-model"})
    );
    assert_eq!(wire["dispatchMode"]["type"], "queue_after_active");
}

/// Continuations saved before they pinned a provider and model carried neither
/// the payload selection nor the wire's copy.
#[tokio::test]
async fn a_stored_continuation_without_a_model_selection_is_refused_before_any_host_call() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    for keep_wire_copy in [false, true] {
        let (mut task, instance) = reserved_worker_continuation(&binding, |wire| {
            wire["payload"]
                .as_object_mut()
                .unwrap()
                .remove("modelSelection");
            if !keep_wire_copy {
                wire.as_object_mut().unwrap().remove("selection");
            }
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let host = T3::new(&format!("http://{address}"), "fixture-key").unwrap();
        let pass = host.pass(checkout.path());
        let run = task.run().unwrap();
        assert!(!crate::retained_worker_continuation(run));
        assert!(matches!(
            crate::launch_provider_instance(run),
            Err(HostError::Binding)
        ));
        assert!(matches!(
            pass.authorize_send(run).await,
            Err(HostError::Binding)
        ));
        task.record_send(&instance, 4).unwrap();
        assert!(matches!(
            pass.observe_run(task.run().unwrap(), crate::LATE_REPLY_MS + 5)
                .await,
            Err(HostError::Binding)
        ));
        let contacted =
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept()).await;
        assert!(contacted.is_err(), "no host call");
    }
}

fn replay_script(
    binding: &Binding,
    instance: &str,
    archive: bool,
) -> Vec<(&'static str, Response)> {
    let probe = "orchestration.subscribeThread";
    let launch = "orchestration.launchThread";
    let command = "orchestration.dispatchCommand";
    let ended = snapshot(binding, instance, "interrupted", false);
    let mut steps = vec![
        (probe, absent()),
        (launch, Response::Failure(json!([]))),
        (probe, absent()),
        (probe, absent()),
        (probe, absent()),
        (launch, Response::Success),
        (
            probe,
            Response::Snapshot(snapshot(binding, instance, "running", false)),
        ),
        (command, Response::Success),
        (probe, Response::Snapshot(ended)),
    ];
    if archive {
        let archived = snapshot(binding, instance, "interrupted", true);
        let row = shell_row(&archived);
        steps.extend([
            (command, Response::Success),
            (probe, Response::Snapshot(archived)),
            archived_shell_reply(17, &row),
        ]);
    }
    steps
}

async fn revoked_replay(archive: bool) {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (mut task, observation, instance) = reserve(binding.clone());
    let (client, server) = server(replay_script(&binding, &instance, archive)).await;

    assert!(matches!(
        send(&quiet_pass(&client), &mut task).await,
        Err(HostError::Uncertain)
    ));
    let sent_at = task
        .run()
        .expect("run")
        .last_send_at_ms()
        .expect("first send time");
    assert!(matches!(
        client
            .pass(checkout.path())
            .authorize_send(task.run().expect("run"))
            .await,
        Err(HostError::Uncertain)
    ));
    revoke(&mut task, &observation);
    assert_eq!(
        quiet_pass(&client)
            .stop(
                task.run().expect("run"),
                &binding,
                sent_at + LATE_REPLY_MS - 1,
                archive
            )
            .await
            .expect("late reply window"),
        StopProgress::Waiting
    );
    // Restore the same durable reservation after the late-reply window has elapsed.
    let mut stored = serde_json::to_value(&task).expect("persist task");
    stored["run"]["last_send_at_ms"] = json!(sent_at - LATE_REPLY_MS);
    let mut task: Task = serde_json::from_value(stored).expect("restore task");
    let expired = sent_at;
    assert_eq!(
        quiet_pass(&client)
            .stop(task.run().expect("run"), &binding, expired, archive)
            .await
            .expect("expired window"),
        StopProgress::ReplayDue
    );
    let pass = quiet_pass(&client);
    assert_eq!(
        send(&pass, &mut task).await.expect("replay"),
        SendOutcome::Sent
    );
    let run = task.run().expect("run");
    assert_eq!(
        stop(&pass, run, &binding, expired, archive)
            .await
            .expect("interrupt"),
        StopProgress::Waiting
    );
    hold_shell(
        &client,
        &snapshot(&binding, &instance, "interrupted", false),
    );
    if archive {
        assert_eq!(
            stop(&quiet_pass(&client), run, &binding, expired, true)
                .await
                .expect("archive"),
            StopProgress::Waiting
        );
        client.rpc.fixture_shell(
            &json!({"kind":"thread.removed","sequence":17,"location":"active","threadId":THREAD}),
        );
    }
    assert_eq!(
        quiet_pass(&client)
            .stop(run, &binding, expired, archive)
            .await
            .expect("settled"),
        StopProgress::Settled(Host::Current {
            instance: instance.clone(),
            state: RunState::Ended
        })
    );

    let sent = server.await.expect("scripted host");
    assert_eq!(
        sent[1].payload.get().as_bytes(),
        sent[5].payload.get().as_bytes()
    );
    let stop: Value = serde_json::from_str(sent[7].payload.get()).expect("stop payload");
    assert_eq!(
        stop,
        json!({"type":"run.interrupt", "threadId":THREAD, "commandId":format!("{instance}-run.interrupt"), "runId": NATIVE_RUN})
    );
    if archive {
        let archive: Value = serde_json::from_str(sent[9].payload.get()).expect("archive payload");
        assert_eq!(
            archive,
            json!({"type":"thread.archive", "threadId":THREAD, "commandId":format!("{instance}-archive")})
        );
    }
}

#[tokio::test]
async fn a_rejected_superseded_replay_keeps_custody_until_archive_readback() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (mut task, observation, instance) = reserve(binding.clone());
    task.record_send(&instance, 1).expect("possible send");
    revoke(&mut task, &observation);
    task.record_rejected_stop(&instance)
        .expect("durable rejection");
    let probe = "orchestration.subscribeThread";
    let command = "orchestration.dispatchCommand";
    let mut idle = snapshot(&binding, &instance, "interrupted", false);
    let quiet = idle.clone();
    idle["projection"]["runs"] = json!([]);
    let mut archived = idle.clone();
    archived["projection"]["thread"]["archivedAt"] = json!("2026-11-23T16:00:00Z");
    let mut archive_row = shell_row(&quiet);
    archive_row["archivedAt"] = archived["projection"]["thread"]["archivedAt"].clone();
    let (client, server) = server(vec![
        (probe, Response::Snapshot(idle.clone())),
        (command, Response::Success),
        (probe, Response::Snapshot(idle)),
        (probe, Response::Snapshot(archived)),
        archived_shell_reply(17, &archive_row),
    ])
    .await;
    hold_shell(&client, &quiet);
    let run = task.run().expect("revoked reservation");
    assert_eq!(
        stop(&quiet_pass(&client), run, &binding, 2, true)
            .await
            .expect("archive still unconfirmed"),
        StopProgress::Waiting
    );
    let durable = serde_json::to_value(&task).expect("persist rejection");
    let restored: Task = serde_json::from_value(durable).expect("restart");
    let run = restored.run().expect("rejection holds custody");
    let late = LATE_REPLY_MS + 2;
    let pass = quiet_pass(&client);
    assert!(matches!(
        pass.authorize_send(run).await,
        Err(HostError::Uncertain)
    ));
    assert!(matches!(
        pass.stop(run, &binding, late, true)
            .await
            .expect("stale archive readback"),
        StopProgress::Write(_)
    ));
    client.rpc.fixture_shell(
        &json!({"kind":"thread.removed","sequence":17,"location":"active","threadId":THREAD}),
    );
    assert_eq!(
        pass.stop(run, &binding, late, true)
            .await
            .expect("archive confirmed"),
        StopProgress::Settled(Host::Current {
            instance: instance.clone(),
            state: RunState::Rejected
        })
    );
    let requests = server.await.expect("trace");
    let archive: Value = serde_json::from_str(requests[1].payload.get()).expect("archive request");
    assert_eq!(archive["type"], "thread.archive");
    assert_eq!(archive["threadId"], THREAD);
}

#[tokio::test]
async fn planner_notice_obeys_snooze_and_queue_acceptance_is_not_delivery() {
    use crate::{NoticeOutcome, NoticeState};

    let directory = checkout_fixture();
    let binding = binding(directory.path());
    let mut notice = T3::prepare_notice(THREAD.into(), "fixture-question".into(), "Please decide")
        .expect("notice");
    let probe = "orchestration.subscribeThread";
    let command = "orchestration.dispatchCommand";
    let mut queued = snapshot(&binding, &notice.command, "queued", false);
    queued["projection"]["runs"][0]["startedAt"] = Value::Null;
    let mut interrupted = queued.clone();
    interrupted["projection"]["runs"][0]["status"] = json!("interrupted");
    let mut settled = queued.clone();
    settled["projection"]["runs"] = json!([]);
    settled["projection"]["thread"]["settledOverride"] = json!("settled");
    settled["projection"]["thread"]["settledAt"] = json!("2026-11-23T16:00:00Z");
    let mut snoozed = settled.clone();
    snoozed["projection"]["thread"]["snoozedUntil"] = json!("2099-11-25T16:00:00Z");
    queued["projection"]["thread"]["settledAt"] = json!("2026-11-25T16:00:00Z");
    let mut started = interrupted.clone();
    started["projection"]["runs"][0]["startedAt"] = json!("2026-11-23T16:01:00Z");
    let (client, server) = server(vec![
        (probe, Response::Snapshot(snoozed)),
        (probe, Response::Snapshot(settled)),
        (command, Response::Success),
        (probe, Response::Snapshot(queued)),
        (probe, Response::Snapshot(interrupted)),
        (probe, Response::Snapshot(started)),
    ])
    .await;
    assert!(
        client.authorize_notice(&notice).await.unwrap().is_none(),
        "operator snooze"
    );
    let permit = ready_notice(&client, &notice).await;
    assert_eq!(notice.last_send_at_ms, None);
    let dispatch = permit.record(&mut notice).expect("persist native marker");
    assert_eq!(
        client
            .send_notice(dispatch)
            .await
            .expect("queue planner notice"),
        NoticeOutcome::Accepted
    );
    let observed = client.observe_notice(&notice).await.unwrap();
    assert_eq!(observed.state, NoticeState::Queued);
    assert!(
        observed.authorization.is_none(),
        "settling after acceptance permits no write"
    );
    assert_eq!(
        client
            .notice_state(&notice)
            .await
            .expect("interrupted before start"),
        NoticeState::Undelivered
    );
    assert_eq!(
        client.notice_state(&notice).await.expect("started"),
        NoticeState::Started
    );
    let frames = server.await.expect("fixture trace");
    assert_eq!(frames[2].payload.get(), notice.payload.as_str());
    let payload: Value = serde_json::from_str(&notice.payload).expect("message wire");
    assert_eq!(payload["dispatchMode"]["type"], "queue_after_active");
}

#[tokio::test]
async fn a_settled_recipient_gets_only_the_exact_recorded_notice() {
    use crate::NoticeOutcome;

    let directory = checkout_fixture();
    let binding = binding(directory.path());
    let mut notice = T3::prepare_notice(THREAD.into(), "fixture-question".into(), "Please decide")
        .expect("notice");
    let probe = "orchestration.subscribeThread";
    let command = "orchestration.dispatchCommand";
    let mut idle = snapshot(&binding, &notice.command, "queued", false);
    idle["projection"]["runs"] = json!([]);
    let mut first = idle.clone();
    first["projection"]["thread"]["settledAt"] = json!("2026-11-23T16:00:00Z");
    let rejected = json!([{"_tag":"Fail","error":{
        "_tag":"OrchestrationV2DispatchCommandError",
        "commandId":notice.command,
        "commandType":"message.dispatch",
        "cause":{
            "name":"OrchestratorCommandPreviouslyRejectedError",
            "message":format!("Command {} was previously rejected: fixture.", notice.command),
        },
    }}]);
    let (client, server) = server(vec![
        (probe, Response::Snapshot(first.clone())),
        (probe, Response::Snapshot(first)),
        (command, Response::Failure(rejected)),
    ])
    .await;
    let permit = ready_notice(&client, &notice).await;
    let mut edited = T3::prepare_notice(THREAD.into(), notice.command.clone(), "Different text")
        .expect("same ID with different text");
    assert!(matches!(
        permit.record(&mut edited),
        Err(HostError::Binding)
    ));
    assert_eq!(edited.last_send_at_ms, None);
    let permit = ready_notice(&client, &notice).await;
    let dispatch = permit
        .record(&mut notice)
        .expect("record the original bytes");
    assert_eq!(
        client
            .send_notice(dispatch)
            .await
            .expect("confirmed outcome"),
        NoticeOutcome::Rejected
    );
    let frames = server.await.expect("fixture trace");
    assert_eq!(frames[2].payload.get(), notice.payload);
}

#[tokio::test]
async fn a_promoted_steer_needs_delivery_of_its_own_provider_item() {
    use crate::NoticeState;

    let directory = checkout_fixture();
    let binding = binding(directory.path());
    let notice = T3::prepare_notice(THREAD.into(), "fixture-question".into(), "Please decide")
        .expect("notice");
    let probe = "orchestration.subscribeThread";
    let message = format!("{}-message", notice.command);
    let mut pending = snapshot(&binding, &notice.command, "running", false);
    pending["projection"]["messages"] = json!([{"id":message, "runId":NATIVE_RUN}]);
    pending["projection"]["runs"] = json!([
        { "id":"old-queue", "status":"cancelled", "userMessageId":message, "startedAt":null },
        { "id":NATIVE_RUN, "status":"running", "userMessageId":"other-message", "startedAt":"2026-11-23T16:00:00Z" }
    ]);
    let item = |message_id: &str, run_id: &str, status: &str| {
        json!({"type":"user_message", "messageId":message_id, "runId":run_id,
            "inputIntent":"promoted_queued_to_steer", "status": status})
    };
    pending["projection"]["turnItems"] = json!([
        item("other-message", NATIVE_RUN, "completed"),
        item(&message, "old-queue", "completed"),
        item(&message, NATIVE_RUN, "pending")
    ]);
    let mut delivered = pending.clone();
    delivered["projection"]["turnItems"][2]["status"] = json!("completed");
    let (client, server) = server(vec![
        (probe, Response::Snapshot(pending)),
        (probe, Response::Snapshot(delivered)),
    ])
    .await;
    assert_eq!(
        client.notice_state(&notice).await.expect("unread steer"),
        NoticeState::Queued
    );
    assert_eq!(
        client.notice_state(&notice).await.expect("delivered steer"),
        NoticeState::Started
    );
    server.await.expect("fixture trace");
}

const RUST_LAUNCHER: &str = "/synthetic/engine/bin/nucleus-rust-acp";

fn setup_instance(command_path: &str) -> Value {
    json!({
        "driver": "acpRegistry",
        "displayName": "Nucleus Rust",
        "enabled": true,
        "config": {"source": "local", "commandPath": command_path},
    })
}

fn setup_config(instance: Option<Value>, ready: bool) -> Response {
    let mut settings = json!({
        "nucleus": {"driver":"acpRegistry","config":{"source":"local","commandPath":"/synthetic/ts"}},
        "fixture-codex": {"driver":"codex"},
    });
    if let Some(instance) = instance {
        settings["nucleus-rust"] = instance;
    }
    let providers = if ready {
        json!([{"instanceId":"nucleus-rust","driver":"acpRegistry","enabled":true,
            "status":"ready","models":[{"slug":"nucleus"}]}])
    } else {
        json!([])
    };
    Response::Value(json!({
        "environment":{"orchestrationProtocolVersion":2},
        "settings":{"providerInstances":settings},
        "providers":providers,
    }))
}

#[tokio::test]
async fn catalog_cache_uses_config_revision_across_passes() {
    let initial = setup_config(Some(setup_instance(RUST_LAUNCHER)), true);
    let (host, native) = server(vec![("server.getConfig", initial)]).await;
    assert_eq!(host.board_catalog()["status"], "pending");
    assert!(host.host_calls().is_empty());
    for _ in 0..3 {
        assert!(
            host.fixture_pass()
                .profile_catalog()
                .await
                .unwrap()
                .supports_parent("nucleus-rust")
        );
    }
    assert_eq!(native.await.unwrap().len(), 1);
}

#[tokio::test]
async fn held_config_updates_the_board_catalog_and_keeps_choices_after_disconnect() {
    let providers = json!([{
        "instanceId":"codex", "enabled":true, "status":"ready", "driver":"codex",
        "models":[{"slug":"first","name":"First"}],
    }]);
    let first = json!({"type":"snapshot", "config":{
        "environment":{"orchestrationProtocolVersion":2},
        "providers":providers,
    }});
    let mut newer = providers;
    newer[0]["models"][0] = json!({"slug":"second","name":"Second"});
    newer[0]["skills"] = json!([{"path":"/synthetic/private/skill"}]);
    let updated = json!({"type":"providerStatuses","payload":{"providers":newer}});
    let (host, native) = server(vec![(
        "subscribeServerConfig",
        Response::ConfigStream(vec![first, updated]),
    )])
    .await;
    let (theme, _) = tokio::sync::watch::channel(None);
    let mut changes = host.catalog_changes();
    assert!(host.watch_theme(&theme).await.is_err());
    changes.changed().await.expect("catalog invalidation");
    let catalog = host.board_catalog();
    assert_eq!(catalog["status"], "stale");
    assert!(catalog["readAtMs"].is_u64());
    assert_eq!(catalog["providers"][0]["models"][0]["slug"], "second");
    assert!(catalog["providers"][0].get("skills").is_none());
    assert_eq!(native.await.expect("one config subscription").len(), 1);
}

#[tokio::test]
async fn sent_role_reads_share_changed_evidence_and_recover_a_missed_shell_delta() {
    use crate::{rpc::ThreadReply, thread_snapshots::ThreadRead};
    use std::time::Duration;

    let message = "fixture-assignment";
    let row = |time, status| {
        json!({
            "id":THREAD,"updatedAt":time,"status":status,
            "activeRunId":(status != "completed").then_some(NATIVE_RUN),
            "pendingRuntimeRequest":null,"pendingBackgroundTasks":[],
        })
    };
    let running = row("2026-11-24T16:00:00Z", "running");
    let waiting = row("2026-11-24T16:00:02Z", "waiting");
    let ended = row("2026-11-24T16:01:00Z", "completed");
    let (host, native) = server([
        (&running, 1), (&waiting, 2), (&ended, 3), (&ended, 3),
    ].into_iter().map(|(row, sequence)| ("orchestration.subscribeThread", Response::ParentSnapshot(json!({
        "kind":"snapshot","snapshotSequence":sequence,"projection":{
            "thread":row,"runs":[{"id":NATIVE_RUN,"userMessageId":message,"status":row["status"]}],
            "runtimeRequests":[],"turnItems":[],"messages":[],
        }
    })))).collect()).await;
    host.rpc.use_held_shell();
    host.rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1,"threads":[running],"projects":[],
        }}));
    let rpc = &host.rpc;
    let read = |policy| async move {
        let ThreadReply::Snapshot(reply) = rpc.thread(THREAD, policy).await.unwrap() else {
            panic!("expected a bounded thread snapshot");
        };
        reply["snapshotSequence"].as_u64().unwrap()
    };
    let sent = ThreadRead::SentRun(message);
    let count = || host.host_calls()["orchestration.subscribeThread"];
    assert_eq!(
        tokio::join!(read(sent), read(ThreadRead::Observation)),
        (1, 1)
    );
    assert_eq!(count(), 1);
    host.rpc
        .fixture_shell(&json!({"kind":"thread.updated","sequence":2,"thread":waiting}));
    assert_eq!(read(sent).await, 2);
    assert_eq!(count(), 2);

    let advance = |seconds| async move {
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(seconds)).await;
        tokio::time::resume();
    };
    for _ in 0..2 {
        advance(45).await;
        assert_eq!(read(sent).await, 2);
        assert_eq!(count(), 2);
    }
    // No shell delta follows the native completion. Both due observations
    // recover it from one bounded read despite the lagging marker.
    advance(45).await;
    assert_eq!(
        tokio::join!(read(sent), read(ThreadRead::Observation)),
        (3, 3)
    );
    assert_eq!(read(sent).await, 3);
    assert_eq!(count(), 3);
    assert_eq!(host.thread_read_reasons()["sentRunBackstop"], 1);
    assert_eq!(read(ThreadRead::Exact).await, 3);
    assert_eq!(native.await.unwrap().len(), 4);
}

#[tokio::test]
async fn quiet_inbox_reuses_its_projection_and_held_project() {
    let root = "/fixture/inbox";
    let provider = "fixture-acp";
    let project = crate::inbox::PROJECT;
    let thread = json!({
        "id":crate::INBOX_THREAD,"projectId":project,"providerInstanceId":provider,
        "modelSelection":{"instanceId":provider,"model":"nucleus"},
        "updatedAt":"2026-11-24T16:00:00Z","pinnedAt":"2026-11-24T16:00:00Z",
        "status":"idle","activeRunId":null,"pendingRuntimeRequest":null,"pendingBackgroundTasks":[],
    });
    let snapshot = json!({"kind":"snapshot","snapshotSequence":1,"projection":{
        "thread":thread,"runs":[],"runtimeRequests":[],"turnItems":[],"messages":[]
    }});
    let (host, native) = server(vec![(
        "orchestration.subscribeThread",
        Response::ParentSnapshot(snapshot),
    )])
    .await;
    host.rpc.use_held_shell();
    host.rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1,"threads":[thread],"projects":[{"id":project,"workspaceRoot":root}]
        }}));
    let target = crate::InboxTarget { root, provider };
    let pending = std::collections::BTreeSet::new();
    for expected in [Some(&1), None] {
        let (step, calls) =
            T3::count_pass_calls(Box::pin(host.prepare_inbox(&target, &pending))).await;
        assert!(
            matches!(step, Ok(crate::InboxStep::Ready { forms, commands, active_run: None }) if forms.is_empty() && commands.is_empty())
        );
        assert_eq!(calls.get("orchestration.subscribeThread"), expected);
        assert!(!calls.contains_key("orchestration.subscribeShell"));
        if expected.is_none() {
            assert!(calls.is_empty());
        }
    }
    assert_eq!(native.await.unwrap().len(), 1);
}

#[tokio::test]
async fn setup_status_uses_one_client_and_a_shared_project_observation() {
    let root = "/fixture/inbox";
    let id = crate::INBOX_THREAD;
    let project = crate::inbox::PROJECT;
    let provider = crate::NUCLEUS_RUST_PROVIDER;
    let config = setup_config(Some(setup_instance(RUST_LAUNCHER)), true);
    let (host, native) = server(vec![
        ("server.getConfig", config),
        (
            "orchestration.subscribeShell",
            Response::ShellSnapshot(json!({
                "kind":"snapshot","snapshot":{"threads": [], "projects":[{
                    "id":project, "workspaceRoot":root, "faviconPath":"fixture.svg",
                }]}
            })),
        ),
        (
            "orchestration.subscribeThread",
            Response::ParentSnapshot(json!({
                "kind":"snapshot","snapshotSequence":1,"projection":{"thread":{
                    "id":id,"projectId":project,"providerInstanceId":provider,
                    "modelSelection":{"instanceId":provider,"model":"nucleus"},
                    "pinnedAt":"2026-11-24T16:00:00Z",
                }}
            })),
        ),
    ])
    .await;
    assert_eq!(
        host.provider_registration(RUST_LAUNCHER).await.unwrap(),
        crate::ProviderRegistration::Ready,
    );
    let target = crate::InboxTarget { root, provider };
    assert_eq!(
        host.inbox_status_with_favicon(&target).await.unwrap(),
        (crate::InboxStatus::Pinned, Some("fixture.svg".into())),
    );
    assert_eq!(host.host_calls()["auth.websocketTicket"], 1);
    assert_eq!(host.host_calls()["orchestration.subscribeShell"], 1);
    assert_eq!(native.await.unwrap().len(), 3);
}

#[tokio::test]
async fn rust_provider_create_and_remove_use_the_exact_id_and_read_back() {
    use crate::ProviderSetup;
    let instance = setup_instance(RUST_LAUNCHER);
    let get = "server.getConfig";
    let update = "server.updateSettings";
    let (t3, runner) = server(vec![
        (get, setup_config(None, false)),
        (update, Response::Success),
        (get, setup_config(Some(instance.clone()), false)),
        (get, setup_config(Some(instance.clone()), true)),
        (get, setup_config(Some(instance.clone()), true)),
        (get, setup_config(Some(instance.clone()), true)),
        (update, Response::Success),
        (get, setup_config(None, true)),
        (get, setup_config(None, false)),
        (get, setup_config(None, false)),
    ])
    .await;
    let setup = ProviderSetup::new(t3.endpoint(), "fixture-key", RUST_LAUNCHER).expect("setup");
    setup.install(false).await.expect("created and ready");
    setup.install(false).await.expect("already ready");
    setup.uninstall().await.expect("removed");
    setup.uninstall().await.expect("already absent");

    let mutations = runner
        .await
        .expect("loopback RPC fixture")
        .into_iter()
        .filter(|request| request.tag == update)
        .map(|request| serde_json::from_str::<Value>(request.payload.get()).expect("mutation"))
        .collect::<Vec<_>>();
    assert_eq!(
        mutations,
        vec![
            json!({"patch":{},"providerInstanceMutation":{
                "operation":"create","instanceId":"nucleus-rust","instance":instance
            }}),
            json!({"patch":{},"providerInstanceMutation":{
                "operation":"remove","instanceId":"nucleus-rust"
            }}),
        ],
    );
}

#[tokio::test]
async fn rust_provider_conflict_never_sends_a_mutation() {
    use crate::{ProviderSetup, ProviderSetupError};
    let mut foreign = setup_instance("/synthetic/other/command");
    foreign["displayName"] = json!("Unrelated ACP");
    let (t3, runner) = server(vec![
        (
            "server.getConfig",
            setup_config(Some(foreign.clone()), true),
        ),
        ("server.getConfig", setup_config(Some(foreign), true)),
    ])
    .await;
    let setup = ProviderSetup::new(t3.endpoint(), "fixture-key", RUST_LAUNCHER).expect("setup");
    assert!(matches!(
        setup.install(false).await,
        Err(ProviderSetupError::Conflict)
    ));
    assert!(matches!(
        setup.uninstall().await,
        Err(ProviderSetupError::Conflict)
    ));
    assert_eq!(runner.await.expect("loopback RPC fixture").len(), 2);
}

#[tokio::test]
async fn rust_provider_adoption_changes_only_its_local_command() {
    use crate::{ProviderSetup, ProviderSetupError};
    let prior = setup_instance("/synthetic/engine/previous/nucleus-rust-acp");
    let expected = setup_instance(RUST_LAUNCHER);
    let get = "server.getConfig";
    let update = "server.updateSettings";
    let (t3, runner) = server(vec![
        (get, setup_config(Some(prior.clone()), true)),
        (get, setup_config(Some(prior), true)),
        (update, Response::Success),
        (get, setup_config(Some(expected.clone()), true)),
        (get, setup_config(Some(expected.clone()), true)),
    ])
    .await;
    let setup = ProviderSetup::new(t3.endpoint(), "fixture-key", RUST_LAUNCHER).expect("setup");
    assert!(matches!(
        setup.install(false).await,
        Err(ProviderSetupError::AdoptionRequired)
    ));
    setup.install(true).await.expect("adopted and ready");
    setup.install(true).await.expect("already ready");
    let requests = runner.await.expect("fixture trace");
    let change: Value = serde_json::from_str(requests[2].payload.get()).expect("mutation");
    assert_eq!(
        change,
        json!({"patch":{}, "providerInstanceMutation":{
            "operation":"upsert", "instanceId":"nucleus-rust", "instance":expected
        }})
    );
}

#[tokio::test]
async fn rust_provider_create_race_never_upserts_a_namesake() {
    use crate::{ProviderSetup, ProviderSetupError};
    let (t3, runner) = server(vec![
        ("server.getConfig", setup_config(None, false)),
        ("server.updateSettings", Response::Failure(json!([]))),
        (
            "server.getConfig",
            setup_config(Some(json!({"driver":"codex"})), false),
        ),
    ])
    .await;
    let setup = ProviderSetup::new(t3.endpoint(), "fixture-key", RUST_LAUNCHER).expect("setup");
    assert!(matches!(
        setup.install(false).await,
        Err(ProviderSetupError::Conflict)
    ));
    let requests = runner.await.expect("loopback RPC fixture");
    let mutation: Value = serde_json::from_str(requests[1].payload.get()).expect("mutation");
    assert_eq!(mutation["providerInstanceMutation"]["operation"], "create");
}

#[tokio::test]
async fn retention_walk_removes_only_an_old_owned_archive_still_closed_at_the_wire() {
    let old = "2026-11-20T10:00:00.000Z";
    let cutoff = crate::task_row::timestamp_ms("2026-11-22T10:00:00Z").unwrap();
    let row = |id: &str, at: &str| json!({"id":id,"archivedAt":at,"deletedAt":null});
    let mut deleted = row("gone", old);
    deleted["deletedAt"] = json!(old);
    let inventory = json!({"schemaVersion":2,"snapshotSequence":14,"projects":[],"threads":[
        row("old",old),row("reopened",old),row("foreign",old),
        row("recent","2026-11-24T11:00:00.000Z"),deleted
    ]});
    let (host, wire) = server(vec![
        (
            "orchestration.getArchivedShellSnapshot",
            Response::Value(inventory),
        ),
        ("orchestration.dispatchCommand", Response::Success),
    ])
    .await;
    host.rpc.fixture_shell(
        &json!({"kind":"snapshot","snapshot":{"snapshotSequence":14,"projects":[],"threads":[]}}),
    );
    let (work, more) = host
        .prune_candidates(|id, _| id != "foreign", cutoff)
        .await
        .unwrap();
    assert!(!more);
    assert_eq!(
        work.iter().map(|w| w.thread.as_str()).collect::<Vec<_>>(),
        ["old", "reopened"]
    );
    assert!(host.prune_thread(&work[0], || Ok(true)).await.unwrap());
    host.rpc.fixture_shell(&json!({"kind":"thread.updated","sequence":15,"thread":{"id":"reopened","archivedAt":null,"deletedAt":null}}));
    assert!(
        !host
            .prune_thread(&work[1], || panic!("no claim on a reopened thread"))
            .await
            .unwrap()
    );
    let writes = wire.await.unwrap();
    let cmd: Value = serde_json::from_str(writes.last().unwrap().payload.get()).unwrap();
    assert_eq!(cmd["type"], "thread.delete");
    assert_eq!(cmd["threadId"], "old");
    assert!(cmd.get("onlyIfUnused").is_none());
}

#[tokio::test]
async fn retention_walk_drains_seventy_archives_in_three_bounded_batches() {
    let mut steps = Vec::new();
    for start in [0, 32, 64] {
        let rows:Vec<_>=(start..70).map(|n|json!({"id":format!("t-{n:02}"), "archivedAt":"2026-11-18T00:00:00Z", "deletedAt":null})).collect();
        steps.push((
            "orchestration.getArchivedShellSnapshot",
            Response::Value(json!({"snapshotSequence":101,"projects":[],"threads":rows})),
        ));
        for _ in start..(start + 32).min(70) {
            steps.push(("orchestration.dispatchCommand", Response::Success));
        }
    }
    let (host, wire) = server(steps).await;
    host.rpc.fixture_shell(
        &json!({"kind":"snapshot","snapshot":{"snapshotSequence":101,"projects":[],"threads":[]}}),
    );
    let mut sizes = Vec::new();
    loop {
        let (batch, more) = host.prune_candidates(|_, _| true, u64::MAX).await.unwrap();
        sizes.push(batch.len());
        for write in batch {
            assert!(host.prune_thread(&write, || Ok(true)).await.unwrap());
        }
        if !more {
            break;
        }
    }
    assert_eq!(sizes, [32, 32, 6]);
    assert_eq!(wire.await.unwrap().len(), 73);
}

#[tokio::test]
async fn failed_inbox_write_releases_effect_claim_so_retry_writes() {
    use crate::{
        InboxStep, InboxTarget, NUCLEUS_RUST_PROVIDER, inbox::INBOX_THREAD, inbox::PROJECT,
    };
    use std::collections::BTreeSet;

    let root = "/synthetic/rust-inbox";
    let inbox_snapshot = json!({
        "kind": "snapshot",
        "snapshotSequence": 11,
        "projection": {
            "thread": {
                "id": INBOX_THREAD,
                "projectId": PROJECT,
                "providerInstanceId": NUCLEUS_RUST_PROVIDER,
                "modelSelection": {"instanceId": NUCLEUS_RUST_PROVIDER, "model": "nucleus"},
                "pinnedAt": "2026-11-24T10:00:00Z",
                "archivedAt": null,
                "deletedAt": null,
                "worktreePath": null,
                "parentThreadId": null,
                "lineage": null
            },
            "runs": [],
            "runtimeRequests": [],
            "turnItems": []
        }
    });
    let shell_snapshot = json!({
        "kind": "snapshot",
        "snapshot": {
            "snapshotSequence": 11,
            "projects": [{"id": PROJECT, "workspaceRoot": root}],
            "threads": [{
                "id": INBOX_THREAD,
                "projectId": PROJECT,
                "pinnedAt": "2026-11-24T10:00:00Z",
                "archivedAt": null,
                "deletedAt": null,
                "updatedAt": "2026-11-24T10:00:00Z"
            }]
        }
    });
    let (host, requests) = server(vec![
        (
            "orchestration.subscribeThread",
            Response::ParentSnapshot(inbox_snapshot.clone()),
        ),
        (
            "orchestration.dispatchCommand",
            Response::Failure(json!([{"_tag":"Fail","error":{"_tag":"TransientError"}}])),
        ),
        (
            "orchestration.subscribeThread",
            Response::ParentSnapshot(inbox_snapshot.clone()),
        ),
        ("orchestration.dispatchCommand", Response::Success),
        (
            "orchestration.subscribeThread",
            Response::ParentSnapshot(inbox_snapshot),
        ),
    ])
    .await;
    host.rpc.use_held_shell();
    host.rpc.fixture_shell(&shell_snapshot);
    let target = InboxTarget {
        root,
        provider: NUCLEUS_RUST_PROVIDER,
    };
    let pending = BTreeSet::from(["decision:fixture".to_owned()]);

    let InboxStep::Wake(first) = host.prepare_inbox(&target, &pending).await.unwrap() else {
        panic!("expected inbox wake");
    };
    let command_id = first.command_id().to_owned();
    assert!(matches!(
        host.write_inbox(first).await,
        Err(HostError::Uncertain)
    ));

    let InboxStep::Wake(retry) = host.prepare_inbox(&target, &pending).await.unwrap() else {
        panic!("expected inbox wake retry");
    };
    assert_eq!(retry.command_id(), command_id);
    host.write_inbox(retry).await.unwrap();

    // After success, the same command ID is deduplicated while the shell has not moved.
    let InboxStep::Wake(duplicate) = host.prepare_inbox(&target, &pending).await.unwrap() else {
        panic!("expected inbox wake duplicate");
    };
    assert_eq!(duplicate.command_id(), command_id);
    host.write_inbox(duplicate).await.unwrap();

    let dispatches: Vec<Value> = requests
        .await
        .unwrap()
        .into_iter()
        .filter(|request| request.tag == "orchestration.dispatchCommand")
        .map(|request| serde_json::from_str(request.payload.get()).unwrap())
        .collect();
    assert_eq!(dispatches.len(), 2);
    assert_eq!(dispatches[0]["commandId"], command_id);
    assert_eq!(dispatches[1]["commandId"], command_id);
}

#[tokio::test]
async fn pre_send_connection_failure_reports_not_sent_for_notice_and_role_dispatch() {
    use crate::NoticeOutcome;

    let directory = checkout_fixture();
    let binding = binding(directory.path());
    let mut notice = T3::prepare_notice(THREAD.into(), "pre-send-notice".into(), "Please decide")
        .expect("notice");
    let mut idle = snapshot(&binding, &notice.command, "queued", false);
    idle["projection"]["runs"] = json!([]);
    let (mut task, _, _) = reserve_entry(binding.clone(), Entry::Brief);

    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("listen");
    let address = listener.local_addr().expect("address");
    let client = T3::new(&format!("http://{address}"), "fixture-key").expect("client");
    let server = tokio::spawn(async move {
        // First connection serves observe_notice and authorize_send, then closes so writes reconnect.
        serve_ticket(&listener).await;
        let (socket, _) = listener.accept().await.expect("websocket");
        let mut socket = accept_hdr_async(socket, check_upgrade)
            .await
            .expect("handshake");
        for step in 0..2 {
            let frame = socket.next().await.unwrap().unwrap();
            let request: Request = serde_json::from_str(frame.to_text().unwrap()).unwrap();
            assert_eq!(request.tag, "orchestration.subscribeThread");
            let reply = if step == 0 {
                json!({
                    "_tag": "Chunk",
                    "requestId": request.id.parse::<u64>().unwrap(),
                    "values": [idle, {"kind": "synchronized"}],
                })
            } else {
                json!({
                    "_tag": "Exit",
                    "requestId": request.id,
                    "exit": {
                        "_tag": "Failure",
                        "cause": [{"_tag": "Fail", "error": {
                            "_tag": "OrchestrationV2GetThreadProjectionError",
                            "threadId": THREAD,
                            "cause": {
                                "name": "ProjectionStoreThreadNotFoundError",
                                "message": format!("No orchestration projection exists for thread {THREAD}.")
                            }
                        }}]
                    }
                })
            };
            socket
                .send(Message::Text(reply.to_string().into()))
                .await
                .unwrap();
            if step == 0 {
                for _ in 0..2 {
                    let _ = socket.next().await;
                }
            }
        }
        drop(socket);

        // Next two ticket requests fail with 503 before any WebSocket write happens.
        for _ in 0..2 {
            let (mut http, _) = listener.accept().await.expect("rejected ticket");
            let mut buf = [0; 1024];
            assert!(http.read(&mut buf).await.unwrap() > 0);
            http.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
        }
    });

    let permit = ready_notice(&client, &notice).await;
    let notice_dispatch = permit.record(&mut notice).expect("record notice");

    let pass = quiet_pass(&client);
    let run_permit = pass
        .authorize_send(task.run().expect("reserved run"))
        .await
        .expect("authorize role launch");
    let run_dispatch = run_permit.record(&mut task).expect("record role launch");

    // Drop the cached socket so both writes must reconnect and hit the 503 ticket failure.
    client.rpc.socket_clear_for_test();
    assert_eq!(
        client.send_notice(notice_dispatch).await.unwrap(),
        NoticeOutcome::NotSent(HostError::Unavailable)
    );

    client.rpc.clear_retry_for_test();
    assert_eq!(
        pass.send(run_dispatch).await.unwrap(),
        SendOutcome::NotSent(HostError::Unavailable)
    );
    assert!(!pass.sent_for_test());
    server.await.unwrap();
}
