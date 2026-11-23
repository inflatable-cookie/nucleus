use std::path::Path;

use futures_util::{SinkExt, StreamExt};
use nucleus_core::{
    Authority, CheckState, Command, Entry, Forge, Host, Identity, Observation, Observed, Phase,
    PullRequest, RetainedThread, RunState, Task, Workspace,
};
use nucleus_hosts::{
    Binding, Dispatch, HostError, RoleProfile, RunRequest, SendOutcome, StopProgress, T3, TaskHost,
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

#[derive(Deserialize)]
struct Request {
    id: String,
    tag: String,
    payload: Box<RawValue>,
}

enum Response {
    Snapshot(Value),
    Success,
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

async fn server(steps: Vec<(&'static str, Response)>) -> (T3, JoinHandle<Vec<Request>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("listen");
    let address = listener.local_addr().expect("address");
    let client = T3::new(&format!("http://{address}"), "fixture-key").expect("client");
    let runner = tokio::spawn(async move {
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
            let chunk = matches!(response, Response::Snapshot(_));
            let reply = match response {
                Response::Snapshot(value) => json!({
                    "_tag": "Chunk", "requestId": id.parse::<u64>().expect("numeric request sequence"),
                    "values": [value, {"kind": "synchronized"}],
                }),
                Response::Success => {
                    json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Success","value":{"sequence":1}}})
                }
                Response::Failure(cause) => {
                    json!({"_tag":"Exit","requestId":id,"exit":{"_tag":"Failure","cause":cause}})
                }
            };
            socket
                .send(Message::Text(reply.to_string().into()))
                .await
                .expect("write reply");
            if chunk {
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
                let payload: Value =
                    serde_json::from_str(request.payload.get()).expect("subscribe body");
                assert_eq!(
                    payload,
                    json!({"threadId":THREAD,"requestCompletionMarker":true,"acceptBoundedSnapshot":true})
                );
            }
            seen.push(request);
        }
        seen
    });
    (client, runner)
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
            entry: Entry::ReviewEntry,
        },
        "Synthetic task".into(),
        Some(pr.clone()),
    );
    let observation = Observation {
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Clean(pr.head.clone())),
        forge: Observed::Known(Forge::Open {
            pr,
            checks: CheckState::Ready,
        }),
    };
    let _ = task.reconcile(&observation);
    let instance = task.next_launch_instance().expect("instance");
    let inputs = RunRequest {
        binding,
        dispatch: Dispatch::Create {
            title: "fixture".into(),
            profile: RoleProfile {
                instance_id: "fixture-provider".into(),
                model: "fixture-model".into(),
                runtime_mode: "full-access".into(),
            },
        },
        text: "Frozen prompt".into(),
    }
    .inputs(&instance, THREAD.into(), 1)
    .expect("inputs");
    let _ = task
        .reserve_launch(&observation, inputs, &[4; 32])
        .expect("reserve");
    (task, observation, instance)
}

fn snapshot(binding: &Binding, instance: &str, state: &str, archived: bool) -> Value {
    json!({
        "kind": "snapshot",
        "snapshotSequence": 16,
        "hasMoreHistory": true,
        "historyCursor": "omitted-timeline",
        "projection": {
            "thread": { "id": THREAD, "projectId": binding.project_id, "worktreePath": binding.worktree_path, "branch": binding.branch,
                "archivedAt": archived.then_some("2026-11-23T16:00:00Z") },
            "runs": [{ "id": NATIVE_RUN, "status": state, "userMessageId": format!("{instance}-message") }],
            "messages": [],
            "runtimeRequests": [],
        }
    })
}

fn absent() -> Response {
    Response::Failure(json!([{"_tag":"Fail","error":{
        "_tag":"OrchestrationV2GetThreadProjectionError","threadId":THREAD,
        "cause":{"name":"ProjectionStoreThreadNotFoundError","message": format!("No orchestration projection exists for thread {THREAD}.")},
    }}]))
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

#[tokio::test]
async fn terminal_exact_thread_waits_for_a_process_in_its_checkout() {
    let checkout = tempfile::tempdir().expect("checkout");
    let binding = binding(checkout.path());
    let (mut task, _, instance) = reserve(binding.clone());
    task.record_send(&instance, 1).expect("record send");
    let terminal = snapshot(&binding, &instance, "completed", false);
    let probe = "orchestration.subscribeThread";
    let (client, server) = server(vec![
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
    assert_eq!(
        client.observe_run(run, 2).await.expect("busy checkout"),
        Host::Current {
            instance: instance.clone(),
            state: RunState::Running
        }
    );
    process.kill().await.expect("stop fixture child");
    assert_eq!(
        client.observe_run(run, 3).await.expect("quiet checkout"),
        Host::Current {
            instance,
            state: RunState::Ended
        }
    );
    server.await.expect("scripted host");
}

#[tokio::test]
async fn an_unsent_revoked_reservation_clears_without_contacting_t3() {
    let checkout = tempfile::tempdir().expect("checkout");
    let (mut task, observation, instance) = reserve(binding(checkout.path()));
    revoke(&mut task, &observation);
    let client = T3::new("http://127.0.0.1:9", "fixture-key").expect("client");
    assert_eq!(
        client
            .stop(task.run().expect("run"), 2, true)
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
    revoked_replay(false).await;
}

#[tokio::test]
async fn superseded_review_replay_archives_after_exact_stop() {
    revoked_replay(true).await;
}

#[tokio::test]
async fn next_review_resumes_the_same_thread_after_archival() {
    let checkout = tempfile::tempdir().expect("checkout");
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
    let restored = snapshot(&binding, &previous, "interrupted", false);
    let probe = "orchestration.subscribeThread";
    let command = "orchestration.dispatchCommand";
    let (client, server) = server(vec![
        (probe, Response::Snapshot(archived.clone())),
        (probe, Response::Snapshot(archived)),
        (command, Response::Success),
        (probe, Response::Snapshot(restored)),
        (command, Response::Success),
    ])
    .await;
    let retained = client
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
        binding,
        dispatch: Dispatch::Continue,
        text: "Fresh review".into(),
    }
    .inputs(&instance, THREAD.into(), 2)
    .expect("continuation inputs");
    let _ = task
        .reserve_launch(&observation, inputs, &[4; 32])
        .expect("reserve continuation");
    task.record_send(&instance, 2).expect("record continuation");
    assert_eq!(
        client
            .send(task.run().expect("continued run"))
            .await
            .expect("send continuation"),
        SendOutcome::Sent
    );
    let sent = server.await.expect("scripted host");
    let unarchive: Value = serde_json::from_str(sent[2].payload.get()).expect("unarchive payload");
    let message: Value = serde_json::from_str(sent[4].payload.get()).expect("continuation payload");
    assert_eq!(
        unarchive,
        json!({"type":"thread.unarchive", "threadId":THREAD, "commandId":format!("{instance}-unarchive")})
    );
    assert_eq!(message["type"], "message.dispatch");
    assert_eq!(message["threadId"], THREAD);
    assert_eq!(message["messageId"], format!("{instance}-message"));
}

async fn revoked_replay(archive: bool) {
    let checkout = tempfile::tempdir().expect("checkout");
    let binding = binding(checkout.path());
    let (mut task, observation, instance) = reserve(binding.clone());
    let probe = "orchestration.subscribeThread";
    let launch = "orchestration.launchThread";
    let command = "orchestration.dispatchCommand";
    let ended = snapshot(&binding, &instance, "interrupted", false);
    let mut steps = vec![
        (probe, absent()),
        (launch, Response::Failure(json!([]))),
        (probe, absent()),
        (probe, absent()),
        (probe, absent()),
        (launch, Response::Success),
        (
            probe,
            Response::Snapshot(snapshot(&binding, &instance, "running", false)),
        ),
        (command, Response::Success),
        (probe, Response::Snapshot(ended)),
    ];
    if archive {
        steps.extend([
            (command, Response::Success),
            (
                probe,
                Response::Snapshot(snapshot(&binding, &instance, "interrupted", true)),
            ),
        ]);
    }
    let (client, server) = server(steps).await;

    task.record_send(&instance, 1).expect("record first send");
    assert!(matches!(
        client.send(task.run().expect("run")).await,
        Err(HostError::Uncertain)
    ));
    revoke(&mut task, &observation);
    assert_eq!(
        client
            .stop(task.run().expect("run"), LATE_REPLY_MS, archive)
            .await
            .expect("late reply window"),
        StopProgress::Waiting
    );
    let expired = LATE_REPLY_MS + 1;
    assert_eq!(
        client
            .stop(task.run().expect("run"), expired, archive)
            .await
            .expect("expired window"),
        StopProgress::ReplayDue
    );
    task.record_send(&instance, expired).expect("record replay");
    let run = task.run().expect("run");
    assert_eq!(client.send(run).await.expect("replay"), SendOutcome::Sent);
    assert_eq!(
        client.stop(run, expired, archive).await.expect("interrupt"),
        StopProgress::Waiting
    );
    if archive {
        assert_eq!(
            client.stop(run, expired, true).await.expect("archive"),
            StopProgress::Waiting
        );
    }
    assert_eq!(
        client.stop(run, expired, archive).await.expect("settled"),
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
