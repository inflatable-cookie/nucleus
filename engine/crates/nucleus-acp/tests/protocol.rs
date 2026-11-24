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
    response::sse::{Event, Sse},
    routing::{get, post},
};
use futures_util::stream;
use nucleus_core::acp::{Binding, InboxBinding};
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
        let mut command = Command::new(env!("CARGO_BIN_EXE_nucleus-acp"));
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
        let response = self.read().await;
        assert_eq!(response["id"], id);
        response
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

async fn view(State(fixture): State<Arc<Fixture>>) -> Json<Value> {
    let state = fixture.state.load(Ordering::Relaxed);
    let run = if state == 3 {
        Value::Null
    } else {
        let activity = if state == 2 {
            json!({"label":"Running Rust tests","startedAt":null})
        } else {
            Value::Null
        };
        json!({"instance":INSTANCE,"role":"worker","purpose":"Write the fixture","lastSendAt":1,
            "reported":state == 4,"activity":activity})
    };
    Json(json!({
        "version":1,
        "reference":"fixture#67",
        "identity":{"id":"fixture","reference":"fixture","repository":"example/fixture","base":"main","entry":"brief"},
        "phase": if state == 3 { "cancelled" } else { "working" },
        "wait": if state == 4 { Some("host_unknown") } else { None },"question":null,"run":run
    }))
}

async fn history(State(fixture): State<Arc<Fixture>>) -> Json<Value> {
    let mut history = vec![json!({"sequence":1,"presentation":[
        {"kind":"run_started","instance":INSTANCE,"role":"worker","purpose":"Write the fixture"}
    ]})];
    if fixture.state.load(Ordering::Relaxed) == 3 {
        history.insert(
            0,
            json!({"sequence":2,"presentation":[{"kind":"run_ended","instance":INSTANCE}]}),
        );
    }
    Json(json!(history))
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
        .route("/v1/tasks/fixture/history", get(history))
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
async fn stdio_rebuilds_and_updates_the_exact_run_from_invalidations() {
    let (mut agent, fixture, home, server) = loopback().await;

    let opened = agent
        .call(1, "session/new", json!({"cwd":"/fixture"}))
        .await;
    assert_eq!(opened["result"]["sessionId"], SESSION);
    assert_scratch_cwd(&agent, home.path()).await;
    agent.update("plan").await;
    assert_eq!(agent.update("tool_call").await["toolCallId"], INSTANCE);
    agent
        .send(json!({"jsonrpc":"2.0","id":2,"method":"session/prompt",
        "params":{"sessionId":SESSION,"prompt":[{"type":"text","text":"cancel"}]}}))
        .await;
    tokio::time::timeout(Duration::from_secs(15), fixture.stream_ready.notified())
        .await
        .expect("subscribe");
    fixture.state.store(4, Ordering::Relaxed);
    let _ = fixture.changes.send(());
    let waiting = agent.update("plan").await;
    assert_eq!(
        waiting["entries"][1]["content"],
        "fixture#67 · Working · waiting to confirm the worker is idle"
    );
    fixture.state.store(2, Ordering::Relaxed);
    let _ = fixture.changes.send(());
    agent.update("plan").await;
    let changed = agent.update("tool_call_update").await;
    assert_eq!(changed["toolCallId"], INSTANCE);
    assert_eq!(
        changed["content"][0]["content"]["text"],
        "Running Rust tests"
    );
    let _ = fixture.changes.send(());
    agent
        .send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":SESSION}}))
        .await;
    let stopped = agent.read().await;
    assert_eq!(stopped["id"], 2);
    assert_eq!(stopped["result"]["stopReason"], "cancelled");
    assert_eq!(fixture.commands.load(Ordering::Relaxed), 0);

    let bad = agent
        .call(
            3,
            "session/load",
            json!({"sessionId":"other","cwd":"/fixture"}),
        )
        .await;
    assert_eq!(bad["error"]["code"], -32000);
    let loaded = agent
        .call(
            4,
            "session/load",
            json!({"sessionId":SESSION,"cwd":"/fixture"}),
        )
        .await;
    assert_eq!(loaded["result"]["sessionId"], SESSION);
    agent.update("plan").await;
    assert_eq!(agent.update("tool_call").await["toolCallId"], INSTANCE);
    agent.send(json!({"jsonrpc":"2.0","id":5,"method":"session/prompt",
        "params":{"sessionId":SESSION,"prompt":[{"type":"text","text":"Envelope\n<user_request>cancel</user_request>"}]}})).await;
    agent.update("plan").await;
    assert_eq!(
        agent.update("tool_call_update").await["status"],
        "completed"
    );
    assert_eq!(
        agent.update("agent_message_chunk").await["content"]["text"],
        "Task cancelled.\n\n"
    );
    let end = agent.read().await;
    assert_eq!(end["id"], 5);
    assert_eq!(end["result"]["stopReason"], "end_turn");
    assert_eq!(fixture.commands.load(Ordering::Relaxed), 1);
    drop(agent.input);
    assert!(
        tokio::time::timeout(Duration::from_secs(15), agent.child.wait())
            .await
            .expect("agent exits on EOF")
            .expect("exit")
            .success()
    );
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
