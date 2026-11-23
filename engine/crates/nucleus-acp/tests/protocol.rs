use std::{
    convert::Infallible,
    fs::OpenOptions,
    os::unix::fs::OpenOptionsExt,
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
use nucleus_core::acp::Binding;
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
    fn spawn(path: Option<&Path>) -> Self {
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
async fn unbound_new_is_inert_and_load_refuses() {
    let mut agent = AgentIo::spawn(None);
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
        let activity = if state == 1 {
            Value::Null
        } else {
            json!({"label":"Running Rust tests","startedAt":null})
        };
        json!({"instance":INSTANCE,"role":"worker","purpose":"Write the fixture","lastSendAt":1,"activity":activity})
    };
    Json(json!({
        "version":1,
        "identity":{"id":"fixture","reference":"fixture","repository":"example/fixture","base":"main","entry":"brief"},
        "phase": if state == 3 { "cancelled" } else { "working" },
        "wait":null,"question":null,"run":run
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
    let pointer = home.path().join("binding.json");
    let binding = Binding {
        session_id: SESSION.into(),
        task_id: "fixture".into(),
        endpoint,
        credential: [5; 32],
        command_credential: Some([6; 32]),
    };
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&pointer)
        .expect("binding file");
    serde_json::to_writer(file, &binding).expect("write binding");
    let agent = AgentIo::spawn(Some(&pointer));
    (agent, fixture, home, server)
}

#[tokio::test]
async fn stdio_rebuilds_and_updates_the_exact_run_from_invalidations() {
    let (mut agent, fixture, _home, server) = loopback().await;

    let opened = agent
        .call(1, "session/new", json!({"cwd":"/fixture"}))
        .await;
    assert_eq!(opened["result"]["sessionId"], SESSION);
    agent.update("plan").await;
    assert_eq!(agent.update("tool_call").await["toolCallId"], INSTANCE);
    agent
        .send(json!({"jsonrpc":"2.0","id":2,"method":"session/prompt",
        "params":{"sessionId":SESSION,"prompt":[{"type":"text","text":"cancel"}]}}))
        .await;
    tokio::time::timeout(Duration::from_secs(15), fixture.stream_ready.notified())
        .await
        .expect("subscribe");
    fixture.state.store(2, Ordering::Relaxed);
    let _ = fixture.changes.send(());
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
