use std::{fs::Permissions, os::unix::fs::PermissionsExt, path::Path};

use crate::{
    Binding, Dispatch, HostError, NoticeHost, NoticeWrite, RoleProfile, RunRequest, SendOutcome,
    StopProgress, T3, T3Pass, TaskHost,
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
    process::Command as Process,
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
                .observe_retained(&binding, row["id"].as_str().unwrap())
                .await
                .expect("initial exact observation");
        }
    }))
    .await;
    assert_eq!(warm["orchestration.subscribeThread"], 20);
    let ((), unchanged) = T3::count_pass_calls(Box::pin(async {
        for row in &rows {
            host.fixture_pass()
                .observe_retained(&binding, row["id"].as_str().unwrap())
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
                .observe_retained(&binding, row["id"].as_str().unwrap())
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
async fn done_task_with_archived_roles_settles_from_shell_without_thread_reads() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let parent = crate::parent_thread(checkout.path());
    let host = T3::new("http://127.0.0.1:9", "fixture").unwrap();
    let row = |id: &str| {
        json!({
            "id":id, "projectId":binding.project_id, "worktreePath":binding.worktree_path,
            "branch":binding.branch, "archivedAt":"2026-11-24T15:50:00Z",
            "providerInstanceId":"fixture-provider",
            "modelSelection":{"instanceId":"fixture-provider","model":"nucleus"},
            "parentThreadId":(id != parent).then_some(&parent)
        })
    };
    host.rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "sequence":1, "threads":[], "projects":[],
            "archivedThreads":[row(&parent), row("worker"), row("reviewer")]
        }}));
    let (archive, calls) = T3::count_pass_calls(Box::pin(host.prepare_parent_archive(
        &binding,
        "fixture-provider",
        &["worker", "reviewer"],
    )))
    .await;
    assert!(matches!(archive, Ok(crate::ArchiveStep::Finished)));
    assert!(calls.is_empty(), "archival made calls: {calls:?}");
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
    let profile = RoleProfile {
        instance_id: "fixture-provider".into(),
        model: "fixture-model".into(),
        runtime_mode: "full-access".into(),
        options: Vec::new(),
    };
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
async fn a_sibling_helper_needs_exact_idle_proof_and_never_hides_other_work() {
    let checkout = checkout_fixture();
    let root = checkout.path().canonicalize().expect("canonical checkout");
    let binding = binding(&root);
    let (mut task, _, instance) = reserve_entry(binding.clone(), Entry::Brief);
    task.record_send(&instance, 1).expect("record worker send");
    assert_eq!(task.threads().get(nucleus_core::Role::Worker), Some(THREAD));
    for (status, unrelated, unknown, expected) in [
        ("completed", false, false, Some(true)),
        ("running", false, false, Some(false)),
        ("completed", true, false, Some(false)),
        ("completed", false, true, None),
    ] {
        let mut observed = snapshot(&binding, &instance, status, false);
        if unknown {
            observed["projection"]
                .as_object_mut()
                .expect("projection")
                .remove("providerThreads");
        }
        let (client, server) = server(vec![(
            "orchestration.subscribeThread",
            Response::Snapshot(observed),
        )])
        .await;
        let mut pass = client.fixture_pass().for_task(&task, None);
        pass.evidence = std::sync::Arc::new(crate::PassEvidence {
            processes: tokio::sync::OnceCell::new_with(Some(Ok(
                crate::Inventory::bound_helper_fixture(&root, THREAD, unrelated),
            ))),
            ..crate::PassEvidence::default()
        });
        let result = pass.quiet(&binding, "fixture-reviewer", None).await;
        if let Some(expected) = expected {
            assert_eq!(result.expect("custody"), expected);
        } else {
            assert!(matches!(result, Err(HostError::Uncertain)));
        }
        let requests = server.await.expect("scripted host");
        let payload: Value = serde_json::from_str(requests[0].payload.get()).expect("payload");
        assert_eq!(payload["threadId"], THREAD);
    }
}

fn snapshot(binding: &Binding, instance: &str, state: &str, archived: bool) -> Value {
    json!({
        "kind": "snapshot",
        "snapshotSequence": 16,
        "projection": {
            "thread": { "id": THREAD, "projectId": binding.project_id, "worktreePath": binding.worktree_path, "branch": binding.branch,
                "archivedAt": archived.then_some("2026-11-23T16:00:00Z") },
            "runs": [{ "id": NATIVE_RUN, "status": state, "userMessageId": format!("{instance}-message") }],
            "messages": [],
            "runtimeRequests": [],
            "providerThreads": [],
            "turnItems": [],
        }
    })
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
async fn a_failed_parent_turn_is_observed_without_preparing_another_prompt() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (client, native) = server(vec![(
        "orchestration.subscribeThread",
        Response::ParentSnapshot(parent_snapshot(&binding, "failed", false)),
    )])
    .await;
    let result = Box::pin(client.prepare_parent(
        &binding,
        "fixture-acp",
        "Synthetic task",
        Some(crate::ParentAttempt {
            command: "fixture-parent-command",
            released: false,
        }),
        quiet_pass(&client).profile_catalog(),
    ))
    .await
    .expect("read exact prior turn");
    assert!(matches!(result, crate::ParentStep::Failed));
    native.await.expect("only one read");
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
    let crate::ParentStep::Live(parent) = Box::pin(client.prepare_parent(
        &binding,
        "fixture-acp",
        "Synthetic task",
        Some(crate::ParentAttempt {
            command: "fixture-parent-command",
            released: true,
        }),
        quiet_pass(&client).profile_catalog(),
    ))
    .await
    .expect("parent read") else {
        panic!("live parent and its root are required");
    };
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

#[tokio::test]
async fn missing_parent_send_reuses_its_id_after_a_fresh_idle_check() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let thread = crate::parent_thread(checkout.path());
    let command = format!("{thread}-hold-12");
    let mut compact = parent_snapshot(&binding, "completed", false);
    compact["hasMoreHistory"] = json!(false);
    compact["turnItemsOmitLocalVisible"] = json!(true);
    compact["projection"]["turnItems"] = json!([]);
    compact["projection"]["thread"]["updatedAt"] = json!("2026-11-24T17:11:15Z");
    let mut row = compact["projection"]["thread"].clone();
    row["latestRunId"] = json!(NATIVE_RUN);
    row["status"] = json!("completed");
    row["pendingBackgroundTasks"] = json!([]);
    let mut fresh = compact.clone();
    fresh["snapshotSequence"] = json!(18);
    let (host, native) = server(vec![
        (
            "orchestration.subscribeThread",
            Response::ParentSnapshot(compact),
        ),
        (
            "orchestration.subscribeThread",
            Response::ParentSnapshot(fresh),
        ),
        ("orchestration.dispatchCommand", Response::Success),
    ])
    .await;
    host.rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{"threads":[row],"projects":[]}}));
    let crate::ParentStep::Write(write) = Box::pin(host.prepare_parent(
        &binding,
        "fixture-acp",
        "Fixture",
        Some(crate::ParentAttempt {
            command: &command,
            released: false,
        }),
        quiet_pass(&host).profile_catalog(),
    ))
    .await
    .unwrap() else {
        panic!("the unsent intent should become dispatchable");
    };
    assert_eq!(write.command_id(), Some(command.as_str()));
    host.write_parent(write).await.unwrap();
    let sent = native.await.unwrap();
    let payload: Value = serde_json::from_str(sent[2].payload.get()).unwrap();
    assert_eq!(payload["commandId"], command);
}

#[tokio::test]
async fn an_unconfirmed_parent_intent_is_not_replayed_over_a_bounded_snapshot() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let mut compact = parent_snapshot(&binding, "completed", false);
    compact["hasMoreHistory"] = json!(true);
    compact["historyCursor"] = json!("older-turns");
    compact["turnItemsOmitLocalVisible"] = json!(true);
    let (host, native) = server(vec![(
        "orchestration.subscribeThread",
        Response::ParentSnapshot(compact),
    )])
    .await;
    let step = Box::pin(host.prepare_parent(
        &binding,
        "fixture-acp",
        "Fixture",
        Some(crate::ParentAttempt {
            command: "ambiguous-command",
            released: false,
        }),
        quiet_pass(&host).profile_catalog(),
    ))
    .await
    .unwrap();
    assert!(matches!(step, crate::ParentStep::DeliveryUnknown));
    assert_eq!(native.await.unwrap().len(), 1);
}

#[tokio::test]
async fn bounded_parent_custody_converges_after_visibility_changes() {
    for prior in [None, Some("fixture-parent-command")] {
        let checkout = checkout_fixture();
        let binding = binding(checkout.path());
        let thread = crate::parent_thread(checkout.path());
        let mut prepared = parent_snapshot(&binding, "completed", false);
        prepared["hasMoreHistory"] = json!(true);
        prepared["historyCursor"] = json!("older-turns");
        prepared["turnItemsOmitLocalVisible"] = json!(true);
        prepared["projection"]["thread"]["updatedAt"] = json!("2026-11-24T17:38:00Z");
        let mut fresh = prepared.clone();
        fresh["snapshotSequence"] = json!(18);
        fresh["projection"]["thread"]["updatedAt"] = json!("2026-11-24T17:39:00Z");
        let mut row = prepared["projection"]["thread"].clone();
        row["latestRunId"] = json!(NATIVE_RUN);
        row["status"] = json!("completed");
        row["pendingBackgroundTasks"] = json!([]);
        let mut changed = fresh.clone();
        changed["snapshotSequence"] = json!(19);
        changed["projection"]["runtimeRequests"] = json!([{"kind":"approval","status":"pending"}]);
        let read = "orchestration.subscribeThread";
        let (host, native) = server(vec![
            (read, Response::ParentSnapshot(prepared)),
            (read, Response::ParentSnapshot(fresh.clone())),
            (read, Response::ParentSnapshot(fresh.clone())),
            (read, Response::ParentSnapshot(changed)),
            (read, Response::ParentSnapshot(fresh.clone())),
            (read, Response::ParentSnapshot(fresh.clone())),
            (read, Response::ParentSnapshot(fresh.clone())),
            (read, Response::ParentSnapshot(fresh.clone())),
            (read, Response::ParentSnapshot(fresh.clone())),
            (read, Response::ParentSnapshot(fresh)),
            ("orchestration.dispatchCommand", Response::Success),
        ])
        .await;
        host.rpc
            .fixture_shell(&json!({"kind":"snapshot","snapshot":{
                "snapshotSequence":16, "threads":[row], "projects":[]
            }}));
        let pass = quiet_pass(&host);
        let prepare = || {
            Box::pin(host.prepare_parent(
                &binding,
                "fixture-acp",
                "Fixture",
                prior.map(|command| crate::ParentAttempt {
                    command,
                    released: false,
                }),
                pass.profile_catalog(),
            ))
        };
        let crate::ParentStep::Write(mut first) = prepare().await.unwrap() else {
            panic!("idle parent should prepare a message");
        };
        let error = host
            .verify_parent_write(&mut first)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("matching shell background coverage missing"),
            "{error}"
        );
        assert!(
            error.contains("prepared revision 16, observed revision Some(18)"),
            "{error}"
        );

        row["title"] = json!("Updated title");
        host.rpc
            .fixture_shell(&json!({"kind":"thread.updated","sequence":18,"thread":row}));
        let crate::ParentStep::Write(mut second) = prepare().await.unwrap() else {
            panic!("fresh held-shell revision covers the compact snapshot");
        };
        let error = host
            .verify_parent_write(&mut second)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("active run or runtime request"), "{error}");
        let mut verified = Vec::new();
        for _ in 0..2 {
            let crate::ParentStep::Write(mut write) = prepare().await.unwrap() else {
                panic!("prepare an idle parent message");
            };
            host.verify_parent_write(&mut write).await.unwrap();
            verified.push(write);
        }
        row["pendingBackgroundTasks"] = json!([{"kind":"monitor","taskId":"fixture-monitor"}]);
        host.rpc
            .fixture_shell(&json!({"kind":"thread.updated","sequence":20,"thread":row}));
        let mut refusals = Vec::new();
        for write in verified {
            let Err(crate::ParentSendError::NotSent(error)) =
                host.write_verified_parent(write).await
            else {
                panic!("new background work must refuse the write before the wire");
            };
            refusals.push(error.to_string());
        }
        assert_eq!(refusals[0], refusals[1]);
        assert!(refusals[0].contains("pendingBackgroundTasks changed"));
        row["pendingBackgroundTasks"] = json!([]);
        row["updatedAt"] = json!("2026-11-24T17:39:00Z");
        host.rpc
            .fixture_shell(&json!({"kind":"thread.updated","sequence":21,"thread":row}));
        let crate::ParentStep::Write(last) = prepare().await.unwrap() else {
            panic!("the task can replan once custody converges");
        };
        assert_eq!(
            last.command_id(),
            Some(format!("{thread}-hold-18").as_str())
        );
        host.write_parent(last).await.unwrap();
        assert_eq!(native.await.unwrap().len(), 11);
    }
}

#[test]
fn parent_custody_fails_closed_with_an_unknown_or_live_child() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let thread = crate::parent_thread(checkout.path());
    let snapshot = parent_snapshot(&binding, "completed", false);
    for status in [
        Value::Null,
        json!("unknown"),
        json!("queued"),
        json!("preparing"),
        json!("running"),
    ] {
        let mut input = snapshot.clone();
        input["projection"]["subagents"][0]["status"] = status;
        let projection = crate::Projection::parse(input, &binding, &thread).unwrap();
        assert!(projection.delivery_custody().unwrap_err().contains("child"));
    }
    let mut input = snapshot.clone();
    input["projection"]
        .as_object_mut()
        .unwrap()
        .remove("subagents");
    let projection = crate::Projection::parse(input, &binding, &thread).unwrap();
    assert!(
        projection
            .delivery_custody()
            .unwrap_err()
            .contains("roster")
    );
}

#[tokio::test]
async fn archival_finds_displaced_children_and_reads_back_both_threads() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let parent = parent_snapshot(&binding, "completed", false);
    let mut archived_parent = parent_snapshot(&binding, "completed", true);
    archived_parent["snapshotSequence"] = json!(18);
    let child = |state, archived| snapshot(&binding, "child", state, archived);
    let read = "orchestration.subscribeThread";
    let write = "orchestration.dispatchCommand";
    let (client, native) = server(vec![
        (read, Response::ParentSnapshot(parent.clone())),
        (read, Response::Snapshot(child("running", false))),
        (read, Response::ParentSnapshot(parent.clone())),
        (read, Response::Snapshot(child("completed", false))),
        (read, Response::Snapshot(child("completed", false))),
        (write, Response::Success),
        (read, Response::ParentSnapshot(parent.clone())),
        (read, Response::Snapshot(child("completed", true))),
        (read, Response::ParentSnapshot(parent.clone())),
        (read, Response::ParentSnapshot(parent)),
        (write, Response::Success),
        (read, Response::ParentSnapshot(archived_parent.clone())),
        (read, Response::Snapshot(child("completed", true))),
        (read, Response::ParentSnapshot(archived_parent)),
    ])
    .await;
    assert!(matches!(
        client
            .prepare_parent_archive(&binding, "fixture-acp", &[])
            .await
            .expect("busy read"),
        crate::ArchiveStep::Wait
    ));
    for _ in 0..2 {
        let crate::ArchiveStep::Write(effect) = client
            .prepare_parent_archive(&binding, "fixture-acp", &[])
            .await
            .expect("idle read")
        else {
            panic!("one archive effect");
        };
        client.write_parent(effect).await.expect("archive receipt");
    }
    assert!(matches!(
        client
            .prepare_parent_archive(&binding, "fixture-acp", &[])
            .await
            .expect("readback"),
        crate::ArchiveStep::Finished
    ));
    let requests = native.await.expect("native trace");
    let archived: Vec<Value> = requests
        .iter()
        .filter(|request| request.tag == write)
        .map(|request| serde_json::from_str(request.payload.get()).expect("archive wire"))
        .collect();
    assert_eq!(archived.len(), 2);
    assert!(archived.iter().all(|wire| wire["type"] == "thread.archive"));
    assert_eq!(archived[0]["threadId"], THREAD);
    assert_eq!(
        archived[1]["threadId"],
        crate::parent_thread(Path::new(&binding.worktree_path))
    );
}

#[tokio::test]
async fn bounded_finished_worker_is_idle_and_archives_with_its_parent() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let parent = crate::parent_thread(checkout.path());
    let updated = "2026-11-24T16:00:00Z";
    let bounded = |mut value: Value| {
        value["hasMoreHistory"] = json!(true);
        value["historyCursor"] = json!("older worker turns");
        value["turnItemsOmitLocalVisible"] = json!(true);
        value["projection"]["thread"]["updatedAt"] = json!(updated);
        value
    };
    let mut worker = bounded(snapshot(&binding, "child", "completed", false));
    worker["projection"]["thread"]["parentThreadId"] = json!(parent);
    let parent_view = bounded(parent_snapshot(&binding, "completed", false));
    let read = "orchestration.subscribeThread";
    let write = "orchestration.dispatchCommand";
    let (host, native) = server(vec![
        (read, Response::Snapshot(worker.clone())),
        (read, Response::ParentSnapshot(parent_view.clone())),
        (read, Response::Snapshot(worker.clone())),
        (write, Response::Success),
        (read, Response::ParentSnapshot(parent_view.clone())),
        (write, Response::Success),
    ])
    .await;
    let shell_row = |view: &Value| {
        let mut row = view["projection"]["thread"].clone();
        row["latestRunId"] = json!(NATIVE_RUN);
        row["status"] = json!("completed");
        row["pendingBackgroundTasks"] = json!([]);
        row["visibleItemCount"] = json!(50_000);
        row
    };
    host.rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":16, "projects":[],
            "threads":[shell_row(&parent_view), shell_row(&worker)]
        }}));
    let mut projection = crate::Projection::parse(worker.clone(), &binding, THREAD).unwrap();
    let mut stale = shell_row(&worker);
    stale["updatedAt"] = json!("2026-11-24T15:59:00Z");
    projection.use_shell_background(&stale, false);
    assert!(matches!(projection.retained(), Err(HostError::Uncertain)));
    let mut busy = shell_row(&worker);
    busy["pendingBackgroundTasks"] = json!([{"taskId":"before-the-window"}]);
    projection.use_shell_background(&busy, false);
    assert_eq!(projection.retained().unwrap(), RetainedThread::Busy);

    assert_eq!(
        quiet_pass(&host)
            .observe_retained(&binding, THREAD)
            .await
            .unwrap(),
        Host::Retained {
            thread: THREAD.into(),
            state: RetainedThread::Idle,
        }
    );
    for (index, view) in [&worker, &parent_view].into_iter().enumerate() {
        let crate::ArchiveStep::Write(effect) = host
            .prepare_parent_archive(&binding, "fixture-acp", &[])
            .await
            .unwrap()
        else {
            panic!("idle bounded thread can be archived");
        };
        host.write_parent(effect).await.unwrap();
        let mut row = shell_row(view);
        row["archivedAt"] = json!("2026-11-24T16:01:00Z");
        host.rpc
            .fixture_shell(&json!({"kind":"thread.updated","sequence":17 + index,"thread":row}));
    }
    assert!(matches!(
        host.prepare_parent_archive(&binding, "fixture-acp", &[THREAD])
            .await
            .unwrap(),
        crate::ArchiveStep::Finished
    ));
    let requests = native.await.unwrap();
    assert_thread_subscription(&requests[0], THREAD);
    assert_thread_subscription(&requests[1], &parent);
    assert_thread_subscription(&requests[2], THREAD);
    assert_thread_subscription(&requests[4], &parent);
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
    let permit = client
        .authorize_notice(notice)
        .await
        .expect("read planner")
        .expect("authorized");
    if permit.needs_unsettle() {
        client
            .deliver_notice(NoticeWrite::Prepare(&permit))
            .await
            .expect("wake planner");
        client
            .authorize_notice(notice)
            .await
            .expect("read back wake")
            .expect("ready")
    } else {
        permit
    }
}

#[tokio::test]
async fn terminal_exact_thread_waits_for_a_process_in_its_checkout() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (mut task, _, instance) = reserve(binding.clone());
    task.record_send(&instance, 1).expect("record send");
    let terminal = snapshot(&binding, &instance, "completed", false);
    let probe = "orchestration.subscribeThread";
    let (client, server) = server(vec![
        (probe, Response::Snapshot(terminal.clone())),
        (probe, Response::Snapshot(terminal.clone())),
        (probe, Response::Snapshot(terminal)),
    ])
    .await;

    // The process outlives the projected turn. Its cwd is the only connection
    // to the checkout, so a pass-wide thread inventory would not account for it.
    let mut process = Process::new("/bin/sleep")
        .arg("60")
        .current_dir(checkout.path())
        .kill_on_drop(true)
        .spawn()
        .expect("fixture child");
    let run = task.run().expect("run");
    let pass = client.pass(checkout.path());
    assert_eq!(
        pass.observe_run(run, 2).await.expect("busy checkout").host,
        Host::Current {
            instance: instance.clone(),
            state: RunState::Running
        }
    );
    process.kill().await.expect("stop fixture child");
    assert_eq!(
        pass.observe_run(run, 3).await.expect("same inventory").host,
        Host::Current {
            instance: instance.clone(),
            state: RunState::Running
        }
    );
    assert_eq!(
        quiet_pass(&client)
            .observe_run(run, 3)
            .await
            .expect("quiet checkout")
            .host,
        Host::Current {
            instance,
            state: RunState::Ended
        }
    );
    server.await.expect("scripted host");
}

#[tokio::test]
async fn settlement_needs_every_provider_and_background_turn_item() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (task, _, instance) = reserve(binding.clone());
    let terminal = snapshot(&binding, &instance, "completed", false);
    let mut omitted = terminal.clone();
    omitted["projection"]
        .as_object_mut()
        .expect("projection")
        .remove("providerThreads");
    let mut windowed = terminal.clone();
    windowed["hasMoreHistory"] = json!(true);
    windowed["historyCursor"] = json!("prior-session-not-in-window");
    let mut old_provider = terminal.clone();
    old_provider["projection"]["providerThreads"] = json!([
        {"id":"older-session", "pendingBackgroundTasks":[{"taskId":"still-executing","kind":"command"}]},
        {"id":"latest-session", "pendingBackgroundTasks":[]},
    ]);
    let mut live_item = terminal.clone();
    live_item["projection"]["turnItems"] = json!([
        {"type":"command_execution","status":"running","runId":NATIVE_RUN},
    ]);
    let probe = "orchestration.subscribeThread";
    let (client, server) = server(vec![
        (probe, Response::Snapshot(omitted)),
        (probe, Response::Snapshot(windowed)),
        (probe, Response::Snapshot(old_provider)),
        (probe, Response::Snapshot(live_item)),
        (probe, Response::Snapshot(terminal)),
    ])
    .await;

    let pass = quiet_pass(&client);
    assert!(matches!(
        pass.observe_retained(&binding, THREAD).await,
        Err(HostError::Uncertain)
    ));
    let run = task.run().expect("run");
    assert!(matches!(
        pass.observe_run(run, 2).await,
        Err(HostError::Uncertain)
    ));
    for _ in 0..2 {
        assert_eq!(
            pass.observe_run(run, 2)
                .await
                .expect("active background work")
                .host,
            Host::Current {
                instance: instance.clone(),
                state: RunState::Running
            }
        );
    }
    assert_eq!(
        pass.observe_run(run, 3)
            .await
            .expect("covered and quiet")
            .host,
        Host::Current {
            instance,
            state: RunState::Ended
        }
    );
    server.await.expect("scripted host");
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

    let steps = [
        limited, no_reset, running, completed, older_run, child_node, text_only, superseded, steer,
    ]
    .into_iter()
    .map(|reply| ("orchestration.subscribeThread", Response::Snapshot(reply)))
    .collect();
    let (client, server) = server(steps).await;
    let pass = quiet_pass(&client);
    let run = task.run().expect("own launch");
    for (status, evidence) in [
        (RunState::UsageLimited, Some(Some(1_795_449_900_000))),
        (RunState::UsageLimited, Some(None)),
        (RunState::Running, None),
        (RunState::Ended, None),
        (RunState::Ended, None),
        (RunState::Ended, None),
        (RunState::Ended, None),
        (RunState::Ended, None),
        (RunState::Ended, None),
    ] {
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

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "assert the full unarchive, operator snooze and continuation sequence"
)]
async fn next_review_resumes_the_same_thread_after_archival_and_explicit_wake() {
    let checkout = checkout_fixture();
    let binding = binding(checkout.path());
    let (mut task, mut observation, previous) = reserve(binding.clone());
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

    let archived = snapshot(&binding, &previous, "interrupted", true);
    let mut restored = snapshot(&binding, &previous, "interrupted", false);
    restored["hasMoreHistory"] = json!(true);
    restored["historyCursor"] = json!("50000-earlier-items");
    restored["turnItemsOmitLocalVisible"] = json!(true);
    restored["projection"]["turnItems"] = json!([]);
    restored["projection"]["thread"]["updatedAt"] = json!("2026-11-24T16:42:26Z");
    let mut shell_row = restored["projection"]["thread"].clone();
    shell_row["latestRunId"] = json!(NATIVE_RUN);
    shell_row["status"] = json!("interrupted");
    shell_row["pendingBackgroundTasks"] = json!([]);
    shell_row["visibleItemCount"] = json!(50_000);
    let mut operator_snoozed = restored.clone();
    operator_snoozed["projection"]["thread"]["snoozedUntil"] = json!("2099-06-01T12:00:00.000Z");
    let mut settled = restored.clone();
    settled["projection"]["thread"]["settledAt"] = json!("2026-11-23T16:00:00Z");
    let probe = "orchestration.subscribeThread";
    let command = "orchestration.dispatchCommand";
    let (client, server) = server(vec![
        (command, Response::Success),
        (probe, Response::Snapshot(operator_snoozed)),
        (probe, Response::Snapshot(settled)),
        (command, Response::Success),
        (probe, Response::Snapshot(restored.clone())),
        (command, Response::Success),
    ])
    .await;
    client
        .rpc
        .fixture_shell(&json!({"kind":"snapshot","snapshot":{
            "sequence":1, "projects":[], "threads":[],
            "archivedThreads":[archived["projection"]["thread"]]
        }}));
    let pass = quiet_pass(&client);
    let retained = pass
        .observe_retained(&binding, THREAD)
        .await
        .expect("retained thread");
    assert_eq!(
        retained,
        Host::Retained {
            thread: THREAD.into(),
            state: RetainedThread::Idle
        }
    );
    observation.host = Observed::Known(retained);
    let instance = task.next_launch_instance().expect("next instance");
    let inputs = RunRequest {
        parent: None,
        binding,
        dispatch: Dispatch::Continue { profile: None },
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
    client
        .rpc
        .fixture_shell(&json!({"kind":"thread.updated","sequence":2,
            "thread":shell_row
        }));
    assert!(
        matches!(
            pass.authorize_send(task.run().expect("run")).await,
            Err(HostError::Uncertain)
        ),
        "a continuation must wait for the operator's snooze"
    );
    let permit = pass
        .authorize_send(task.run().expect("run"))
        .await
        .expect("settled child");
    let wake = permit.unsettle().expect("explicit wake");
    assert!(matches!(permit.record(&mut task), Err(HostError::Binding)));
    pass.write_control(wake).await.expect("unsettled");
    assert_eq!(
        send(&pass, &mut task).await.expect("send continuation"),
        SendOutcome::Sent
    );
    let sent = server.await.expect("scripted host");
    let unarchive: Value = serde_json::from_str(sent[0].payload.get()).expect("unarchive payload");
    let wake: Value = serde_json::from_str(sent[3].payload.get()).expect("unsettle payload");
    let message: Value = serde_json::from_str(sent[5].payload.get()).expect("continuation payload");
    assert_eq!(wake["type"], "thread.unsettle");
    assert_eq!(wake["reason"], "user");
    assert_eq!(
        unarchive,
        json!({"type":"thread.unarchive", "threadId":THREAD, "commandId":format!("{instance}-unarchive")})
    );
    assert_eq!(message["type"], "message.dispatch");
    assert_eq!(message["commandId"], instance);
    assert_eq!(message["threadId"], THREAD);
    assert_eq!(message["messageId"], format!("{instance}-message"));
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
        steps.extend([
            (command, Response::Success),
            (
                probe,
                Response::Snapshot(snapshot(binding, instance, "interrupted", true)),
            ),
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
    if archive {
        assert_eq!(
            stop(&quiet_pass(&client), run, &binding, expired, true)
                .await
                .expect("archive"),
            StopProgress::Waiting
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
    idle["projection"]["runs"] = json!([]);
    let mut archived = idle.clone();
    archived["projection"]["thread"]["archivedAt"] = json!("2026-11-23T16:00:00Z");
    let (client, server) = server(vec![
        (probe, Response::Snapshot(idle.clone())),
        (command, Response::Success),
        (probe, Response::Snapshot(idle)),
        (probe, Response::Snapshot(archived)),
    ])
    .await;
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
async fn planner_notice_unsettles_and_queue_acceptance_is_not_delivery() {
    use crate::{NoticeSend, NoticeState};

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
    let mut unsettled = settled.clone();
    unsettled["projection"]["thread"]["settledOverride"] = json!("active");
    unsettled["projection"]["thread"]["settledAt"] = Value::Null;
    unsettled["snapshotSequence"] = json!(17);
    let mut started = interrupted.clone();
    started["projection"]["runs"][0]["startedAt"] = json!("2026-11-23T16:01:00Z");
    let (client, server) = server(vec![
        (probe, Response::Snapshot(settled)),
        (command, Response::Success),
        (probe, Response::Snapshot(unsettled)),
        (command, Response::Success),
        (probe, Response::Snapshot(queued)),
        (probe, Response::Snapshot(interrupted)),
        (probe, Response::Snapshot(started)),
    ])
    .await;
    let permit = ready_notice(&client, &notice).await;
    assert_eq!(notice.last_send_at_ms, None);
    let dispatch = permit.record(&mut notice).expect("persist native marker");
    assert_eq!(
        client
            .deliver_notice(NoticeWrite::Queue(dispatch))
            .await
            .expect("queue planner notice"),
        NoticeSend::Accepted
    );
    assert_eq!(
        client.notice_state(&notice).await.expect("queued"),
        NoticeState::Queued
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
    let wake: Value = serde_json::from_str(frames[1].payload.get()).expect("unsettle wire");
    assert_eq!(wake["type"], "thread.unsettle");
    assert_eq!(wake["threadId"], THREAD);
    assert_eq!(frames[3].payload.get(), notice.payload.as_str());
    let payload: Value = serde_json::from_str(&notice.payload).expect("message wire");
    assert_eq!(payload["dispatchMode"]["type"], "queue_after_active");
}

#[tokio::test]
async fn a_new_settlement_gets_a_new_wake_id_and_rejection_settles_the_exact_wire() {
    use crate::NoticeSend;

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
    let mut second = first.clone();
    second["snapshotSequence"] = json!(18);
    let mut active_first = idle.clone();
    active_first["snapshotSequence"] = json!(17);
    idle["snapshotSequence"] = json!(19);
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
        (probe, Response::Snapshot(first)),
        (command, Response::Success),
        (probe, Response::Snapshot(active_first)),
        (probe, Response::Snapshot(second)),
        (command, Response::Success),
        (probe, Response::Snapshot(idle)),
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
            .deliver_notice(NoticeWrite::Queue(dispatch))
            .await
            .expect("confirmed outcome"),
        NoticeSend::Rejected
    );
    let frames = server.await.expect("fixture trace");
    let wake_id = |index: usize| {
        let wire: Value = serde_json::from_str(frames[index].payload.get()).expect("unsettle wire");
        assert_eq!(wire["type"], "thread.unsettle");
        wire["commandId"].as_str().expect("wake ID").to_owned()
    };
    assert_eq!(wake_id(1), format!("unsettle:{THREAD}:16"));
    assert_eq!(wake_id(4), format!("unsettle:{THREAD}:18"));
    assert_eq!(frames[6].payload.get(), notice.payload);
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
