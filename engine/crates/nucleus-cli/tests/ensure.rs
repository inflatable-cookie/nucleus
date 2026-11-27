use std::{
    fs,
    net::{Ipv4Addr, SocketAddr},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Stdio,
    time::Duration,
};

use axum::{Router, http::StatusCode, routing::get};
use nucleus_core::acp::session_id;
use rustix::{
    fs::{FlockOperation, flock},
    io::Errno,
    process::{Pid, Signal, kill_process},
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    net::{TcpListener, TcpStream},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{Instant, sleep, timeout},
};

const KEY: &str = "abababababababababababababababababababababababababababababababab";
const CLI: &str = env!("CARGO_BIN_EXE_nucleus");

struct Profile {
    _directory: tempfile::TempDir,
    home: PathBuf,
}

impl Profile {
    async fn new() -> Self {
        let directory = tempfile::tempdir().expect("test profile");
        let home = directory.path().canonicalize().expect("absolute profile");
        let configured = Command::new(CLI)
            .args(["configure", "--enable", "--home"])
            .arg(&home)
            .output()
            .await
            .expect("configure the fixture profile");
        assert!(
            configured.status.success(),
            "{}",
            String::from_utf8_lossy(&configured.stderr)
        );
        let key = home.join("controller.key");
        fs::write(&key, KEY).expect("write the synthetic key");
        fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).expect("private key");
        let launcher = home.join("serve");
        fs::write(
            &launcher,
            r#"#!/bin/sh
set -eu
printf '%s\n' "$$" >>"$NUCLEUS_FIXTURE_LAUNCHES"
exec >>"$NUCLEUS_FIXTURE_HOME/serve.log" 2>&1
exec "$NUCLEUS_FIXTURE_BINARY" --endpoint "$NUCLEUS_FIXTURE_ENDPOINT" serve \
    --home "$NUCLEUS_FIXTURE_HOME" --acp-provider fixture --actor fixture \
    --t3 http://127.0.0.1:9
"#,
        )
        .expect("write the fixture launcher");
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700))
            .expect("private launcher");
        let provider = home.join("provider");
        fs::write(
            &provider,
            r#"#!/bin/sh
set -eu
test "$1" = --ensure-only
requests="$NUCLEUS_FIXTURE_HOME/recovery-requests"
printf '%s\n' "$$" >>"$requests"
while [ "$(wc -l <"$requests")" -lt 2 ]; do sleep 0.05; done
exec "$NUCLEUS_FIXTURE_BINARY" --endpoint "$NUCLEUS_FIXTURE_ENDPOINT" ensure \
    --home "$NUCLEUS_FIXTURE_HOME" --control-key-file "$NUCLEUS_FIXTURE_HOME/controller.key" \
    --serve-launcher "$NUCLEUS_FIXTURE_HOME/serve"
"#,
        )
        .expect("write the fixture provider");
        fs::set_permissions(&provider, fs::Permissions::from_mode(0o700))
            .expect("private provider");
        Self {
            _directory: directory,
            home,
        }
    }

    fn command(&self, endpoint: SocketAddr) -> Command {
        let endpoint = endpoint.to_string();
        let mut command = Command::new(CLI);
        command
            .args(["--endpoint", &endpoint])
            .env("NUCLEUS_ENGINE_CONTROL_KEY", KEY)
            .env("NUCLEUS_ENGINE_T3_CALLER_KEY", "12".repeat(32))
            .env("NUCLEUS_ENGINE_T3_BEARER", "synthetic")
            .env("NUCLEUS_ENGINE_GITHUB_TOKEN", "synthetic")
            .env("NUCLEUS_FIXTURE_LAUNCHES", self.home.join("launches"))
            .env("NUCLEUS_FIXTURE_HOME", &self.home)
            .env("NUCLEUS_FIXTURE_BINARY", CLI)
            .env("NUCLEUS_FIXTURE_ENDPOINT", &endpoint)
            .env_remove("NUCLEUS_ENGINE_T3_RUNTIME_DESCRIPTOR")
            .env_remove("NUCLEUS_RUST_NATIVE_INBOX")
            .kill_on_drop(true);
        command
    }

    fn ensure(&self, endpoint: SocketAddr) -> Command {
        let mut command = self.command(endpoint);
        command
            .args(["ensure", "--home"])
            .arg(&self.home)
            .arg("--serve-launcher")
            .arg(self.home.join("serve"))
            .arg("--control-key-file")
            .arg(self.home.join("controller.key"));
        command
    }

    fn log(&self, name: &str) -> String {
        fs::read_to_string(self.home.join(name)).unwrap_or_default()
    }

    fn append_log(&self, name: &str) -> fs::File {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.home.join(name))
            .expect("open the fixture log")
    }

    fn serve_command(&self, endpoint: SocketAddr) -> Command {
        let mut command = self.command(endpoint);
        command
            .args(["serve", "--home"])
            .arg(&self.home)
            .args([
                "--acp-provider",
                "fixture",
                "--actor",
                "fixture",
                "--t3",
                "http://127.0.0.1:9",
            ])
            .stderr(self.append_log("serve.log"))
            .stdout(self.append_log("serve.log"));
        command
    }

    async fn serve(&self, endpoint: SocketAddr) -> Child {
        let child = self.serve_command(endpoint).spawn().expect("start serve");
        let http = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(1))
            .build()
            .expect("build fixture client");
        timeout(Duration::from_secs(8), async {
            while !http
                .get(format!("http://{endpoint}/v1/health"))
                .bearer_auth(KEY)
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("engine failed to listen: {}", self.log("serve.log")));
        child
    }

    fn launches(&self) -> Vec<Pid> {
        fs::read_to_string(self.home.join("launches"))
            .unwrap_or_default()
            .lines()
            .map(|line| {
                Pid::from_raw(line.parse().expect("fixture process ID"))
                    .expect("positive process ID")
            })
            .collect()
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        if let Some(pid) = self.launches().last() {
            let _ = kill_process(*pid, Signal::KILL);
        }
    }
}

#[tokio::test]
async fn two_ensure_calls_share_one_detached_engine() {
    let fixture = Profile::new().await;
    let socket = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("reserve test port");
    let endpoint = socket.local_addr().expect("local port");
    drop(socket);
    let mut first = fixture.ensure(endpoint);
    let mut second = fixture.ensure(endpoint);
    let (first, second) = timeout(Duration::from_secs(15), async {
        tokio::join!(first.output(), second.output())
    })
    .await
    .expect("start before test deadline");
    for output in [first, second] {
        let output = output.expect("ensure invocation");
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stderr),
            fs::read_to_string(fixture.home.join("serve.log")).unwrap_or_default(),
        );
    }
    assert_eq!(fixture.launches().len(), 1);
    let lock = fs::File::open(fixture.home.join("serve.lock")).expect("startup lock");
    assert_eq!(
        flock(&lock, FlockOperation::NonBlockingLockExclusive),
        Err(Errno::WOULDBLOCK),
        "the engine keeps the startup lock after both ensure processes exit"
    );
    kill_process(fixture.launches()[0], Signal::TERM).expect("stop the fixture engine");
    timeout(Duration::from_secs(5), async {
        while TcpStream::connect(endpoint).await.is_ok() {
            sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("engine releases the port");
    let output = timeout(Duration::from_secs(10), fixture.ensure(endpoint).output())
        .await
        .expect("restart before test deadline")
        .expect("ensure invocation");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fixture.launches().len(), 2);
}

#[tokio::test]
async fn ensure_does_not_start_behind_an_unverified_listener() {
    let fixture = Profile::new().await;
    let socket = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("reserve test port");
    let endpoint = socket.local_addr().expect("local port");
    let app = Router::new().route("/v1/health", get(|| async { StatusCode::UNAUTHORIZED }));
    let server = tokio::spawn(async { axum::serve(socket, app).await });
    let output = timeout(Duration::from_secs(5), fixture.ensure(endpoint).output())
        .await
        .expect("the proof is refused")
        .expect("ensure invocation");
    server.abort();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("did not confirm"));
    assert!(fixture.launches().is_empty());
}

async fn free_endpoint() -> SocketAddr {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("reserve test port")
        .local_addr()
        .expect("local port")
}

async fn exit(child: &mut Child) -> std::process::ExitStatus {
    timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("fixture process should exit")
        .expect("fixture exit status")
}

fn pid(child: &Child) -> Pid {
    let raw = i32::try_from(child.id().expect("running fixture PID")).expect("signed PID");
    Pid::from_raw(raw).expect("positive fixture PID")
}

fn last_log_time(log: &str) -> String {
    log.lines()
        .last()
        .expect("last engine log")
        .split_whitespace()
        .take(3)
        .collect::<Vec<_>>()
        .join(" ")
}

#[tokio::test]
async fn serve_records_clean_and_unannounced_exits() {
    let fixture = Profile::new().await;
    let endpoint = free_endpoint().await;
    let mut first = fixture.serve(endpoint).await;
    kill_process(pid(&first), Signal::TERM).expect("send SIGTERM to serve");
    assert!(
        exit(&mut first).await.success(),
        "SIGTERM must exit cleanly"
    );

    let first_log = fixture.log("serve.log");
    let ending = first_log
        .lines()
        .find_map(|line| line.split_once(" Nucleus engine shutting down "))
        .expect("the log records shutdown")
        .1;
    assert!(ending.starts_with("on SIGTERM after "), "{ending}");
    assert!(ending.ends_with('s'), "{ending}");

    let time = last_log_time(&first_log);
    let mut second = fixture.serve(endpoint).await;
    assert!(
        fixture.log("serve.log").contains(&format!(
            "Previous Nucleus engine run shut down cleanly (last log at {time})"
        )),
        "{}",
        fixture.log("serve.log")
    );
    second.kill().await.expect("send SIGKILL to serve and reap");
    let last_time = last_log_time(&fixture.log("serve.log"));

    let mut third = fixture.serve(endpoint).await;
    let log = fixture.log("serve.log");
    assert!(
        log.contains(&format!(
            "Previous Nucleus engine run ended unannounced (last log at {last_time})"
        )),
        "{log}"
    );
    kill_process(pid(&third), Signal::HUP).expect("send SIGHUP to serve");
    assert!(exit(&mut third).await.success());
    assert!(
        fixture
            .log("serve.log")
            .contains("shutting down on SIGHUP after ")
    );
}

#[tokio::test]
async fn a_failed_initialization_replaces_the_earlier_clean_run_record() {
    let fixture = Profile::new().await;
    let endpoint = free_endpoint().await;
    let mut first = fixture.serve(endpoint).await;
    kill_process(pid(&first), Signal::TERM).expect("stop the first run");
    assert!(exit(&mut first).await.success());

    let mut failed = fixture
        .serve_command(endpoint)
        .env("NUCLEUS_RUST_NATIVE_INBOX", "invalid")
        .spawn()
        .expect("start serve with an invalid Inbox configuration");
    assert!(!exit(&mut failed).await.success());
    let before = fixture.log("serve.log");
    let failure = before.lines().last().expect("initialization error");
    assert!(
        failure.contains("set NUCLEUS_RUST_NATIVE_INBOX to 0 or 1"),
        "{failure}"
    );

    let last_time = last_log_time(&before);
    let mut third = fixture.serve(endpoint).await;
    let log = fixture.log("serve.log");
    assert!(
        log[before.len()..].contains(&format!(
            "Previous Nucleus engine run exited with an error (last log at {last_time})"
        )),
        "{log}"
    );
    kill_process(pid(&third), Signal::TERM).expect("stop the fixture engine");
    assert!(exit(&mut third).await.success());
}

struct Acp {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
}

impl Acp {
    fn spawn(fixture: &Profile, endpoint: SocketAddr, binding: &std::path::Path) -> Self {
        let mut child = fixture
            .command(endpoint)
            .args(["acp", "--ensure-launcher"])
            .arg(fixture.home.join("provider"))
            .env("NUCLEUS_RUST_NATIVE_INBOX", "1")
            .env("NUCLEUS_ACP_SESSION", binding)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(fixture.append_log("acp.log"))
            .spawn()
            .expect("start ACP client");
        Self {
            input: child.stdin.take().expect("ACP stdin"),
            output: BufReader::new(child.stdout.take().expect("ACP stdout")).lines(),
            child,
        }
    }

    async fn send(&mut self, id: u8, method: &str, params: Value) {
        let frame = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        self.input
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .expect("write ACP request");
    }

    async fn response(&mut self, id: u8) -> Value {
        timeout(Duration::from_secs(8), async {
            loop {
                let line = self
                    .output
                    .next_line()
                    .await
                    .expect("ACP frame")
                    .expect("ACP remains open");
                let frame: Value = serde_json::from_str(&line).expect("ACP JSON");
                if frame["id"] == id {
                    return frame;
                }
                assert!(frame.get("error").is_none(), "{frame}");
            }
        })
        .await
        .expect("ACP response deadline")
    }
}

#[tokio::test]
async fn attached_acp_clients_restart_a_killed_engine_once() {
    let fixture = Profile::new().await;
    let endpoint = free_endpoint().await;
    let initial = fixture
        .ensure(endpoint)
        .env("NUCLEUS_RUST_NATIVE_INBOX", "1")
        .output()
        .await
        .expect("start the initial engine");
    assert!(initial.status.success(), "{}", fixture.log("serve.log"));
    let original = fixture.launches()[0];
    let storage = nucleus_store::SettingsFile::open(&fixture.home)
        .expect("profile settings")
        .storage()
        .expect("profile storage");
    let inbox = nucleus_service::native_inbox_directory(&storage);
    let session = session_id(&inbox);
    let binding = storage
        .database()
        .path()
        .join("acp-bindings")
        .join(format!("{session}.json"));
    let mut clients = [
        Acp::spawn(&fixture, endpoint, &binding),
        Acp::spawn(&fixture, endpoint, &binding),
    ];
    for client in &mut clients {
        client.send(1, "session/new", json!({"cwd": inbox})).await;
        assert_eq!(client.response(1).await["result"]["sessionId"], session);
        client
            .send(
                2,
                "session/prompt",
                json!({"sessionId": session, "prompt": "ui"}),
            )
            .await;
        client.send(3, "authenticate", json!({})).await;
        assert!(
            client.response(3).await.get("result").is_some(),
            "ACP accepted the held Inbox prompt"
        );
    }

    let killed = Instant::now();
    kill_process(original, Signal::KILL).expect("kill the initial engine");
    timeout(Duration::from_secs(12), async {
        loop {
            let log = fixture.log("acp.log");
            if log.matches(r#""outcome":"healthy""#).count() == clients.len() {
                break;
            }
            sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "ACP failed to recover the engine: {}\n{}",
            fixture.log("acp.log"),
            fixture.log("serve.log")
        )
    });
    assert!(
        killed.elapsed() >= Duration::from_secs(2),
        "clients allowed the listener grace period"
    );
    let launches = fixture.launches();
    assert_eq!(launches.len(), 2, "both recoveries share one engine");
    assert_ne!(launches[1], original);
    assert!(
        fixture
            .log("serve.log")
            .contains("ended unannounced (last log at ")
    );
    for mut client in clients {
        client
            .child
            .kill()
            .await
            .expect("stop the fixture ACP client");
    }
}
