use std::{fs::Permissions, os::unix::fs::PermissionsExt, path::Path};

use crate::{
    Binding, Dispatch, HostError, RoleProfile, RunRequest, SendOutcome, StopProgress, T3, T3Pass,
    TaskHost, process::Inventory,
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
    let pass = client.pass();
    assert!(pass.processes.set(Ok(Inventory::quiet_fixture())).is_ok());
    pass
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
                    json!({"threadId":THREAD,"requestCompletionMarker":true,"acceptBoundedSnapshot":false})
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
            origin_thread: None,
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

async fn send(pass: &impl TaskHost, task: &mut Task) -> Result<SendOutcome, HostError> {
    let permit = pass
        .authorize_send(task.run().expect("reserved run"))
        .await?;
    permit.record(task)?;
    pass.send(task.run().expect("run after marker"), permit)
        .await
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
    let pass = client.pass();
    assert_eq!(
        pass.observe_run(run, 2).await.expect("busy checkout"),
        Host::Current {
            instance: instance.clone(),
            state: RunState::Running
        }
    );
    process.kill().await.expect("stop fixture child");
    assert_eq!(
        pass.observe_run(run, 3).await.expect("same inventory"),
        Host::Current {
            instance: instance.clone(),
            state: RunState::Running
        }
    );
    assert_eq!(
        quiet_pass(&client)
            .observe_run(run, 3)
            .await
            .expect("quiet checkout"),
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
                .expect("active background work"),
            Host::Current {
                instance: instance.clone(),
                state: RunState::Running
            }
        );
    }
    assert_eq!(
        pass.observe_run(run, 3).await.expect("covered and quiet"),
        Host::Current {
            instance,
            state: RunState::Ended
        }
    );
    server.await.expect("scripted host");
}

#[tokio::test]
async fn an_unsent_revoked_reservation_clears_without_contacting_t3() {
    let checkout = checkout_fixture();
    let (mut task, observation, instance) = reserve(binding(checkout.path()));
    revoke(&mut task, &observation);
    let client = T3::new("http://127.0.0.1:9", "fixture-key").expect("client");
    assert_eq!(
        quiet_pass(&client)
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
    Box::pin(revoked_replay(false)).await;
}

#[tokio::test]
async fn superseded_review_replay_archives_after_exact_stop() {
    Box::pin(revoked_replay(true)).await;
}

#[tokio::test]
async fn next_review_resumes_the_same_thread_after_archival() {
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
    let restored = snapshot(&binding, &previous, "interrupted", false);
    let probe = "orchestration.subscribeThread";
    let command = "orchestration.dispatchCommand";
    let (client, server) = server(vec![
        (probe, Response::Snapshot(archived.clone())),
        (probe, Response::Snapshot(archived.clone())),
        (probe, Response::Snapshot(archived)),
        (command, Response::Success),
        (probe, Response::Snapshot(restored)),
        (command, Response::Success),
    ])
    .await;
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
        binding,
        dispatch: Dispatch::Continue,
        text: "Fresh review".into(),
    }
    .inputs(&instance, THREAD.into(), 2)
    .expect("continuation inputs");
    let _ = task
        .reserve_launch(&observation, inputs, &[4; 32])
        .expect("reserve continuation");
    assert_eq!(
        send(&pass, &mut task).await.expect("send continuation"),
        SendOutcome::Sent
    );
    let sent = server.await.expect("scripted host");
    let unarchive: Value = serde_json::from_str(sent[3].payload.get()).expect("unarchive payload");
    let message: Value = serde_json::from_str(sent[5].payload.get()).expect("continuation payload");
    assert_eq!(
        unarchive,
        json!({"type":"thread.unarchive", "threadId":THREAD, "commandId":format!("{instance}-unarchive")})
    );
    assert_eq!(message["type"], "message.dispatch");
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
        (probe, absent()),
        (launch, Response::Failure(json!([]))),
        (probe, absent()),
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
        client.pass().authorize_send(task.run().expect("run")).await,
        Err(HostError::Uncertain)
    ));
    revoke(&mut task, &observation);
    assert_eq!(
        quiet_pass(&client)
            .stop(
                task.run().expect("run"),
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
            .stop(task.run().expect("run"), expired, archive)
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
        pass.stop(run, expired, archive).await.expect("interrupt"),
        StopProgress::Waiting
    );
    if archive {
        assert_eq!(
            quiet_pass(&client)
                .stop(run, expired, true)
                .await
                .expect("archive"),
            StopProgress::Waiting
        );
    }
    assert_eq!(
        quiet_pass(&client)
            .stop(run, expired, archive)
            .await
            .expect("settled"),
        StopProgress::Settled(Host::Current {
            instance: instance.clone(),
            state: RunState::Ended
        })
    );

    let sent = server.await.expect("scripted host");
    assert_eq!(
        sent[2].payload.get().as_bytes(),
        sent[7].payload.get().as_bytes()
    );
    let stop: Value = serde_json::from_str(sent[9].payload.get()).expect("stop payload");
    assert_eq!(
        stop,
        json!({"type":"run.interrupt", "threadId":THREAD, "commandId":format!("{instance}-run.interrupt"), "runId": NATIVE_RUN})
    );
    if archive {
        let archive: Value = serde_json::from_str(sent[11].payload.get()).expect("archive payload");
        assert_eq!(
            archive,
            json!({"type":"thread.archive", "threadId":THREAD, "commandId":format!("{instance}-archive")})
        );
    }
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
    let permit = client
        .authorize_notice(&notice)
        .await
        .expect("read planner")
        .expect("authorized");
    assert_eq!(notice.last_send_at_ms, None);
    let dispatch = permit.record(&mut notice).expect("persist native marker");
    assert_eq!(
        client
            .send_notice(dispatch)
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
    let permit = client
        .authorize_notice(&notice)
        .await
        .expect("first read")
        .expect("first permit");
    let mut edited = T3::prepare_notice(THREAD.into(), notice.command.clone(), "Different text")
        .expect("same ID with different text");
    assert!(matches!(
        permit.record(&mut edited),
        Err(HostError::Binding)
    ));
    assert_eq!(edited.last_send_at_ms, None);
    let permit = client
        .authorize_notice(&notice)
        .await
        .expect("fresh read")
        .expect("new permit");
    let dispatch = permit
        .record(&mut notice)
        .expect("record the original bytes");
    assert_eq!(
        client
            .send_notice(dispatch)
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
