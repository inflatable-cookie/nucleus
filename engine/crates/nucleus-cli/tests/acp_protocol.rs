use std::{
    convert::Infallible,
    fs::{DirBuilder, OpenOptions},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::sse::{Event, Sse},
    routing::{get, post},
};
use futures_util::stream;
use nucleus_core::acp::{Binding, InboxBinding, legacy_parent_hold_prompt};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    net::TcpListener,
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Notify, broadcast},
};

const SESSION: &str = "fixture-session";
const INSTANCE: &str = "task-fixture-run-1";

struct AgentIo {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
}

impl AgentIo {
    fn spawn(path: Option<&Path>, cwd: Option<&Path>) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nucleus"));
        command.arg("acp");
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .env_remove("NUCLEUS_ACP_SESSION")
            .env_remove("NUCLEUS_ACP_BINDINGS");
        if let Some(path) = path {
            command.env("NUCLEUS_ACP_SESSION", path);
        }
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let mut child = command.spawn().expect("spawn ACP agent");
        let input = child.stdin.take().expect("stdin");
        let output = BufReader::new(child.stdout.take().expect("stdout")).lines();
        Self {
            child,
            input,
            output,
        }
    }

    async fn send(&mut self, request: Value) {
        let line = format!("{request}\n");
        self.input
            .write_all(line.as_bytes())
            .await
            .expect("send ACP request");
    }

    async fn read(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(15), self.output.next_line())
            .await
            .expect("ACP response deadline")
            .expect("read frame")
            .expect("frame");
        serde_json::from_str(&line).expect("ACP JSON")
    }

    async fn call(&mut self, id: u8, method: &str, params: Value) -> Value {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await;
        self.response(id).await
    }

    async fn response(&mut self, id: u8) -> Value {
        loop {
            let frame = self.read().await;
            if frame.get("id").is_some() {
                assert_eq!(frame["id"], id);
                return frame;
            }
        }
    }

    async fn update(&mut self, kind: &str) -> Value {
        let frame = self.read().await;
        assert_eq!(frame["method"], "session/update");
        assert_eq!(frame["params"]["sessionId"], SESSION);
        let update = &frame["params"]["update"];
        assert_eq!(update["sessionUpdate"], kind);
        update.clone()
    }
}

#[tokio::test]
async fn broken_stdout_exits_with_stdin_open() {
    let mut agent = AgentIo::spawn(None, None);
    let init = agent
        .call(1, "initialize", json!({"protocolVersion":1}))
        .await;
    assert_eq!(init["result"]["protocolVersion"], 1);

    let AgentIo {
        mut child,
        mut input,
        output,
    } = agent;
    drop(output);
    input
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"authenticate\"}\n")
        .await
        .expect("request after closing stdout");
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("ACP must exit while stdin is open")
        .expect("wait for ACP exit");
    assert!(
        status.code().is_some_and(|code| code != 0),
        "ACP exit: {status}"
    );
    drop(input);
}

#[tokio::test]
async fn stdin_eof_drains_queued_replies_and_exits_successfully() {
    let mut agent = AgentIo::spawn(None, None);
    for id in 1..=2 {
        agent
            .send(json!({"jsonrpc":"2.0","id":id,"method":"authenticate"}))
            .await;
    }
    let AgentIo {
        mut child,
        input,
        mut output,
    } = agent;
    drop(input);
    let status = tokio::time::timeout(Duration::from_secs(5), async {
        for id in 1..=2 {
            let line = output.next_line().await.unwrap().expect("queued ACP reply");
            assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["id"], id);
        }
        child.wait().await.expect("wait for ACP exit")
    })
    .await
    .expect("ACP must drain and exit after stdin EOF");
    assert!(status.success(), "ACP exit: {status}");
}

#[tokio::test]
async fn inbox_holds_concurrent_native_forms_and_sends_one_answer_per_live_request() {
    let fixture = Arc::new(Fixture {
        state: AtomicU8::new(0),
        commands: AtomicUsize::new(0),
        stream_ready: Notify::new(),
        changes: broadcast::channel(8).0,
    });
    let api = Router::new()
        .route(
            "/v1/acp/inbox",
            get(async |State(fixture): State<Arc<Fixture>>| {
                let pending: Vec<_> = [("first", 1), ("second", 2)]
                    .into_iter()
                    .filter(|(_, bit)| fixture.state.load(Ordering::Relaxed) & bit == 0)
                    .map(|(field, _)| {
                        json!({"field":field,"question":format!("Decide {field}?"),
                    "choices":[{"id":"yes","label":"Yes"},{"id":"no","label":"No"}],"offer":true})
                    })
                    .collect();
                Json(json!({"pending":pending}))
            }),
        )
        .route("/v1/acp/inbox/events", get(events))
        .route(
            "/v1/acp/inbox/answer",
            post(
                async |State(fixture): State<Arc<Fixture>>, Json(answer): Json<Value>| {
                    assert_eq!(answer["optionId"], "yes");
                    let bit = match answer["field"].as_str() {
                        Some("first") => 1,
                        Some("second") => 2,
                        _ => panic!("unknown fixture choice"),
                    };
                    let prior = fixture.state.fetch_or(bit, Ordering::Relaxed);
                    assert_eq!(prior & bit, 0);
                    fixture.commands.fetch_add(1, Ordering::Relaxed);
                    let _ = fixture.changes.send(());
                    axum::http::StatusCode::NO_CONTENT
                },
            ),
        )
        .with_state(Arc::clone(&fixture));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, api).await.unwrap() });
    let home = tempfile::tempdir().unwrap();
    let pointer = home.path().join("inbox.json");
    write_pointer(
        &pointer,
        &InboxBinding {
            session_id: SESSION.into(),
            endpoint,
            inbox_credential: [5; 32],
        },
    );
    let mut agent = AgentIo::spawn(Some(&pointer), Some(home.path()));
    let opened = agent.call(1, "session/new", json!({})).await;
    assert_eq!(opened["result"]["sessionId"], SESSION);
    agent
        .send(
            json!({"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{
                "sessionId":SESSION,"prompt":"move queued"
            }}),
        )
        .await;
    let first = agent.read().await;
    let second = agent.read().await;
    for form in [&first, &second] {
        assert_eq!(form["method"], "elicitation/create");
        assert_eq!(form["params"]["sessionId"], SESSION);
    }
    assert_eq!(
        first["params"]["requestedSchema"]["required"],
        json!(["first"])
    );
    assert_eq!(
        first["params"]["requestedSchema"]["properties"]["first"]["oneOf"][0]["const"],
        "yes"
    );
    assert_eq!(
        second["params"]["requestedSchema"]["required"],
        json!(["second"])
    );
    let reply = |form: &Value, content: Value| {
        json!({"jsonrpc":"2.0","id":form["id"],
        "result":{"action":"accept","content":content}})
    };
    let answer = reply(&second, json!({"second":"yes"}));
    agent.send(answer.clone()).await;
    agent.send(answer).await;
    agent.send(reply(&first, json!({"first":"yes"}))).await;
    let ended = agent.read().await;
    assert_eq!(ended["id"], 2);
    assert_eq!(ended["result"]["stopReason"], "end_turn");
    assert_eq!(fixture.commands.load(Ordering::Relaxed), 2);
    server.abort();
}

#[tokio::test]
async fn unbound_new_is_inert_and_load_refuses() {
    let mut agent = AgentIo::spawn(None, None);
    let init = agent
        .call(1, "initialize", json!({"protocolVersion":1}))
        .await;
    assert_eq!(init["result"]["agentCapabilities"]["loadSession"], true);
    let opened = agent
        .call(2, "session/new", json!({"cwd":"/fixture"}))
        .await;
    let id = opened["result"]["sessionId"].as_str().expect("inert ID");
    assert_eq!(
        opened["result"]["models"]["availableModels"]
            .as_array()
            .expect("models")
            .len(),
        2
    );
    let prompt = agent
        .call(
            3,
            "session/prompt",
            json!({"sessionId":id,"prompt":"cancel"}),
        )
        .await;
    assert_eq!(prompt["error"]["code"], -32000);
    let load = agent
        .call(4, "session/load", json!({"sessionId":id,"cwd":"/fixture"}))
        .await;
    assert_eq!(load["error"]["code"], -32000);
}

struct Fixture {
    state: AtomicU8,
    commands: AtomicUsize,
    stream_ready: Notify,
    changes: broadcast::Sender<()>,
}

async fn view(
    State(fixture): State<Arc<Fixture>>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    let state = fixture.state.load(Ordering::Relaxed);
    if state == 6
        || (state == 7
            && headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                != Some(&format!("Bearer {}", hex::encode([7; 32]))))
    {
        return (StatusCode::UNAUTHORIZED, Json(json!(null)));
    }
    let reported = matches!(state, 3 | 9);
    let cards = if matches!(state, 0 | 5) {
        Vec::new()
    } else {
        let outcome = reported.then(|| {
            json!({
                "kind":"work","url":"https://github.com/example/fixture/pull/7",
                "summary":"Fixed the fixture.","revision":false,
            })
        });
        vec![json!({
            "instance":INSTANCE,"role":"worker","purpose":"Write the fixture",
            "provider":if reported { "claude" } else { "codex" },
            "model":if reported { "observed-model" } else { "assigned-model" },
            "modelObserved":reported,"threadUrl":"t3-thread://v1/thread:worker",
            "startedAtMs":1_000,"elapsedMs":reported.then_some(62_000),
            "ended":reported || state == 7,"outcome":outcome,
            "activity":(state == 2).then_some("Running Rust tests"),
        })]
    };
    let step_state = if reported { "done" } else { "current" };
    let phase = match state {
        3 => "done",
        9 => "closing",
        _ => "working",
    };
    let step_note = match state {
        4 => Some("Waiting on Nucleus"),
        5 => Some("Waiting for prerequisite"),
        8 => Some("Waiting for capacity"),
        _ => None,
    };
    (
        StatusCode::OK,
        Json(json!({
            "version":1,
            "reference":"fixture#67",
            "identity":{"id":"fixture","reference":"fixture","repository":"example/fixture","base":"main","entry":"brief"},
            "phase":phase,
            "lifecycle":{
                "steps":[
                    {"key":"queued","label":"Queued","state":"done","tone":"success"},
                    {"key":"working","label":"Working","state":step_state,"note":step_note,"tone":"accent"}
                ],
                "admittedAtMs":0,"finishedAtMs":(state == 3).then_some(120_000),
                "transcript":{"cards":cards,"completedReviews":0,"merged":reported,"externalAcceptances":[]}
            },
            "pullRequest":reported.then(|| json!({
                "url":"https://github.com/example/fixture/pull/7","head":format!("{:040x}",1)
            })),
            "parentHold": match state {
                0 => Some(legacy_parent_hold_prompt("fixture-hold")),
                10 => Some("Starting reviewer round 1".to_owned()),
                _ => None,
            },
            "activeChild": matches!(state, 1 | 2 | 8),
            // Older candidates may still send this presentation hint.
            "transcriptPending":state == 9,
        })),
    )
}

async fn events(
    State(fixture): State<Arc<Fixture>>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let changes = fixture.changes.subscribe();
    fixture.stream_ready.notify_one();
    Sse::new(stream::unfold(
        (true, changes),
        |(first, mut changes)| async move {
            let event = if first {
                "refresh"
            } else {
                changes.recv().await.ok()?;
                "invalidate"
            };
            Some((
                Ok(Event::default()
                    .event(event)
                    .data(r#"{"taskId":"fixture","version":1}"#)),
                (false, changes),
            ))
        },
    ))
}

async fn loopback() -> (
    AgentIo,
    Arc<Fixture>,
    tempfile::TempDir,
    tokio::task::JoinHandle<()>,
) {
    let fixture = Arc::new(Fixture {
        state: AtomicU8::new(1),
        commands: AtomicUsize::new(0),
        stream_ready: Notify::new(),
        changes: broadcast::channel(8).0,
    });
    let api = Router::new()
        .route("/v1/tasks/fixture", get(view))
        .route("/v1/tasks/fixture/events", get(events))
        .route(
            "/v1/tasks/fixture/commands",
            post(
                async |State(fixture): State<Arc<Fixture>>, Json(command): Json<Value>| {
                    assert_eq!(command, "cancel");
                    fixture.commands.fetch_add(1, Ordering::Relaxed);
                    fixture.state.store(3, Ordering::Relaxed);
                    Json(json!({"status":"applied"}))
                },
            ),
        )
        .with_state(Arc::clone(&fixture));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("loopback");
    let endpoint = listener.local_addr().expect("address");
    let server = tokio::spawn(async move {
        axum::serve(listener, api).await.expect("serve");
    });
    let home = tempfile::tempdir().expect("scratch directory");
    let canonical = home.path().canonicalize().expect("scratch root");
    let checkout = canonical.join("checkout");
    let scratch = canonical.join("agent");
    for path in [&checkout, &scratch] {
        DirBuilder::new()
            .mode(0o700)
            .create(path)
            .expect("private directory");
    }
    let pointer = home.path().join("binding.json");
    let binding = Binding {
        session_id: SESSION.into(),
        task_id: "fixture".into(),
        endpoint,
        credential: [5; 32],
        command_credential: Some([6; 32]),
        scratch_dir: Some(scratch),
    };
    write_pointer(&pointer, &binding);
    let agent = AgentIo::spawn(Some(&pointer), Some(&checkout));
    (agent, fixture, home, server)
}

fn write_pointer(path: &Path, binding: &impl serde::Serialize) {
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .expect("binding file");
    serde_json::to_writer(file, binding).expect("write binding");
}

#[tokio::test]
async fn a_slow_close_releases_the_parent_and_reattach_renders_the_finish() {
    let (mut agent, fixture, home, server) = loopback().await;
    fixture.state.store(0, Ordering::Relaxed);
    let opened = agent
        .call(
            1,
            "session/load",
            json!({"sessionId":SESSION,"cwd":"/fixture"}),
        )
        .await;
    assert_eq!(opened["result"]["sessionId"], SESSION);
    assert_scratch_cwd(&agent, home.path()).await;
    agent.update("plan").await;
    agent.send(json!({"jsonrpc":"2.0","id":2,"method":"session/prompt",
        "params":{"sessionId":SESSION,"prompt":[{"type":"text",
            "text":format!("Envelope\n<user_request>{}</user_request>", legacy_parent_hold_prompt("fixture-hold"))}]}})).await;
    tokio::time::timeout(Duration::from_secs(15), fixture.stream_ready.notified())
        .await
        .expect("deployment's scheduler hold stays open after reload");
    fixture.state.store(2, Ordering::Relaxed);
    let _ = fixture.changes.send(());
    let start = agent.update("tool_call").await;
    assert_eq!(start["toolCallId"], INSTANCE);
    assert_eq!(
        start["title"],
        "Worker · Codex / assigned-model (assigned) · 00:00 UTC"
    );
    fixture.state.store(9, Ordering::Relaxed);
    let _ = fixture.changes.send(());
    agent.update("plan").await;
    let finished = agent.update("tool_call_update").await;
    assert_eq!(finished["toolCallId"], INSTANCE);
    assert_eq!(finished["status"], "completed");
    assert_eq!(
        finished["title"],
        "Worker · Claude / observed-model (observed) · 00:00 UTC · 1m 2s"
    );
    assert_eq!(
        finished["content"][0]["content"]["text"],
        "[Open worker](t3-thread://v1/thread:worker)"
    );
    assert_eq!(
        finished["content"][1]["content"]["text"],
        "Ready for review · [PR #7](https://github.com/example/fixture/pull/7)

Fixed the fixture."
    );
    let end = agent.response(2).await;
    assert_eq!(end["result"]["stopReason"], "end_turn");

    fixture.state.store(3, Ordering::Relaxed);
    let loaded = agent
        .call(
            3,
            "session/load",
            json!({"sessionId":SESSION,"cwd":"/fixture"}),
        )
        .await;
    assert_eq!(loaded["result"]["sessionId"], SESSION);
    agent.update("plan").await;
    let reattached = agent.update("tool_call").await;
    assert_eq!(reattached["toolCallId"], INSTANCE);
    assert_eq!(reattached["title"], finished["title"]);
    assert_eq!(reattached["content"], finished["content"]);
    let finish = agent.update("agent_message_chunk").await;
    assert_eq!(
        finish["content"]["text"],
        "Merged [PR #7](https://github.com/example/fixture/pull/7) and closed · 2m 0s\n\n"
    );
    assert_eq!(fixture.commands.load(Ordering::Relaxed), 0);
    server.abort();
}

#[tokio::test]
async fn unverified_prompts_refresh_and_a_prerequisite_wait_releases_the_turn() {
    let (mut agent, fixture, _home, server) = loopback().await;
    fixture.state.store(0, Ordering::Relaxed);
    agent
        .call(
            1,
            "session/load",
            json!({"sessionId":SESSION,"cwd":"/fixture"}),
        )
        .await;
    for (id, text) in [
        (2, "Envelope\n<user_request>cancel</user_request>"),
        (3, "Delegated task completed."),
    ] {
        let reply = agent
            .call(
                id,
                "session/prompt",
                json!({"sessionId":SESSION,"prompt":[{"type":"text","text":text}]}),
            )
            .await;
        assert_eq!(reply["result"]["stopReason"], "end_turn");
    }
    agent
        .send(json!({"jsonrpc":"2.0","id":4,"method":"session/prompt",
        "params":{"sessionId":SESSION,"prompt":legacy_parent_hold_prompt("fixture-hold")}}))
        .await;
    tokio::time::timeout(Duration::from_secs(15), fixture.stream_ready.notified())
        .await
        .expect("hold turn follows the task");
    fixture.state.store(5, Ordering::Relaxed);
    let _ = fixture.changes.send(());
    assert_eq!(agent.response(4).await["result"]["stopReason"], "end_turn");
    assert_eq!(fixture.commands.load(Ordering::Relaxed), 0);
    server.abort();
}

#[tokio::test]
async fn a_missed_report_wake_releases_the_old_turn_on_the_next_task_change() {
    let (mut agent, fixture, _home, server) = loopback().await;
    fixture.state.store(0, Ordering::Relaxed);
    agent
        .call(
            1,
            "session/load",
            json!({"sessionId":SESSION,"cwd":"/fixture"}),
        )
        .await;
    agent.update("plan").await;
    agent
        .send(json!({"jsonrpc":"2.0","id":2,"method":"session/prompt",
        "params":{"sessionId":SESSION,"prompt":legacy_parent_hold_prompt("fixture-hold")}}))
        .await;
    fixture.stream_ready.notified().await;
    fixture.state.store(1, Ordering::Relaxed);
    fixture.changes.send(()).unwrap();
    agent.update("tool_call").await;
    // The authenticated report arrives without an invalidation. Only the
    // following engine change (the reviewer's preparation) wakes the reader.
    fixture.state.store(9, Ordering::Relaxed);
    fixture.state.store(10, Ordering::Relaxed);
    fixture.changes.send(()).unwrap();
    assert_eq!(agent.response(2).await["result"]["stopReason"], "end_turn");
    agent
        .send(json!({"jsonrpc":"2.0","id":3,"method":"session/prompt",
        "params":{"sessionId":SESSION,"prompt":"Starting reviewer round 1"}}))
        .await;
    fixture.stream_ready.notified().await;
    fixture.state.store(3, Ordering::Relaxed);
    fixture.changes.send(()).unwrap();
    assert_eq!(agent.response(3).await["result"]["stopReason"], "end_turn");
    assert_eq!(fixture.commands.load(Ordering::Relaxed), 0);
    server.abort();
}

#[tokio::test]
async fn an_active_child_keeps_the_parent_hold_through_pause_and_a_read_failure() {
    let (mut agent, fixture, home, server) = loopback().await;
    fixture.state.store(0, Ordering::Relaxed);
    agent
        .call(
            1,
            "session/load",
            json!({"sessionId":SESSION,"cwd":"/fixture"}),
        )
        .await;
    agent.update("plan").await;
    agent
        .send(json!({"jsonrpc":"2.0","id":2,"method":"session/prompt",
        "params":{"sessionId":SESSION,"prompt":legacy_parent_hold_prompt("fixture-hold")}}))
        .await;
    tokio::time::timeout(Duration::from_secs(10), fixture.stream_ready.notified())
        .await
        .expect("authenticated hold enters its follow loop");
    fixture.state.store(8, Ordering::Relaxed);
    let _ = fixture.changes.send(());
    let plan = agent.update("plan").await;
    assert_eq!(
        plan["entries"][1]["content"],
        "fixture#67 · Working · Waiting for capacity"
    );
    assert_eq!(agent.update("tool_call").await["toolCallId"], INSTANCE);
    let pointer = home.path().join("binding.json");
    let mut renewed: Binding =
        serde_json::from_reader(std::fs::File::open(&pointer).unwrap()).unwrap();
    renewed.credential = [7; 32];
    let new_pointer = home.path().join("binding.new");
    write_pointer(&new_pointer, &renewed);
    std::fs::rename(new_pointer, pointer).expect("rotate the read binding");
    fixture.state.store(6, Ordering::Relaxed);
    let _ = fixture.changes.send(());
    tokio::time::timeout(Duration::from_secs(10), fixture.stream_ready.notified())
        .await
        .expect("read failure reconnects without ending the held turn");
    fixture.state.store(7, Ordering::Relaxed);
    let _ = fixture.changes.send(());
    assert_eq!(agent.response(2).await["result"]["stopReason"], "end_turn");
    assert_eq!(fixture.commands.load(Ordering::Relaxed), 0);
    server.abort();
}

async fn assert_scratch_cwd(agent: &AgentIo, home: &Path) {
    let pid = agent.child.id().expect("agent pid").to_string();
    let listing = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new("/usr/sbin/lsof")
            .args(["-a", "-p", &pid, "-d", "cwd", "-Fn"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("cwd probe deadline")
    .expect("probe cwd");
    assert!(listing.status.success());
    let cwd = home.canonicalize().expect("scratch root").join("agent");
    let expected = format!("n{}", cwd.display());
    assert!(
        String::from_utf8_lossy(&listing.stdout)
            .lines()
            .any(|line| line == expected)
    );
}
