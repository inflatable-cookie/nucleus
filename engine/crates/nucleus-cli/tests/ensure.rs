use std::{
    fs,
    net::{Ipv4Addr, SocketAddr},
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        process::ExitStatusExt,
    },
    path::PathBuf,
    process::Stdio,
    sync::Mutex,
    time::Duration,
};

use axum::{Router, http::StatusCode, routing::get};
use nucleus_core::acp::session_id;
use rustix::{
    fs::{FlockOperation, flock},
    io::Errno,
    process::{Pid, Signal, kill_process, kill_process_group},
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
    /// Process groups of the engines this fixture started directly.
    served: Mutex<Vec<Pid>>,
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
            served: Mutex::default(),
        }
    }

    fn command(&self, endpoint: SocketAddr) -> Command {
        let mut command = self.environment(endpoint);
        command.args(["--endpoint", &endpoint.to_string()]);
        command
    }

    /// The CLI and its environment, without naming the endpoint on the command line.
    fn environment(&self, endpoint: SocketAddr) -> Command {
        let endpoint = endpoint.to_string();
        let mut command = Command::new(CLI);
        command
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
            .stdout(self.append_log("serve.log"))
            .process_group(0);
        command
    }

    async fn serve(&self, endpoint: SocketAddr) -> Child {
        let child = self.serve_command(endpoint).spawn().expect("start serve");
        self.served.lock().unwrap().push(pid(&child));
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

    /// The engine process, which the latest run record names.
    fn engine(&self) -> Pid {
        let record = fs::read(self.home.join("serve.last-run")).expect("run record");
        let id = i32::from_le_bytes(record[17..21].try_into().expect("engine process ID"));
        Pid::from_raw(id).expect("positive process ID")
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
        // Each engine and its parent share a process group.
        let mut groups = std::mem::take(&mut *self.served.lock().unwrap());
        groups.extend(self.launches().last());
        for group in groups {
            let _ = kill_process_group(group, Signal::KILL);
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

/// The time of the engine's own last line, before its parent's exit record.
fn last_log_time(log: &str) -> String {
    log.lines()
        .rfind(|line| !line.contains(" Nucleus engine process "))
        .expect("last engine log")
        .split_whitespace()
        .take(3)
        .collect::<Vec<_>>()
        .join(" ")
}

/// The cause the supervising parent logged last.
fn last_exit_cause(log: &str) -> String {
    let line = log
        .lines()
        .rfind(|line| line.contains(" Nucleus engine process "))
        .expect("an exit record");
    line.split_once(" ended: ")
        .expect("an exit cause")
        .1
        .to_owned()
}

fn assert_cause(cause: &str, ending: &str) {
    let rest = cause
        .strip_prefix(ending)
        .and_then(|rest| rest.strip_prefix(", uptime "))
        .unwrap_or_else(|| panic!("{cause}"));
    let (uptime, peak) = rest.split_once("s, peak RSS ").expect("uptime and peak");
    assert!(uptime.parse::<f64>().expect("seconds") > 0.0, "{cause}");
    let peak = peak.strip_suffix(" KiB").expect("peak unit");
    let peak = peak.parse::<u64>().expect("peak size");
    // A real engine uses megabytes. This also catches a unit mistake.
    assert!((1024..4 * 1024 * 1024).contains(&peak), "{cause}");
}

#[tokio::test]
async fn serve_records_clean_and_unannounced_exits() {
    let fixture = Profile::new().await;
    let endpoint = free_endpoint().await;
    let mut first = fixture.serve(endpoint).await;
    assert_ne!(fixture.engine(), pid(&first), "serve supervises a child");
    kill_process(pid(&first), Signal::TERM).expect("send SIGTERM to serve");
    assert!(
        exit(&mut first).await.success(),
        "SIGTERM must exit cleanly"
    );

    let first_log = fixture.log("serve.log");
    let ending = first_log
        .lines()
        .find_map(|line| line.split_once(" Nucleus engine shutting down "))
        .expect("the parent forwards SIGTERM and the engine records shutdown")
        .1;
    assert!(ending.starts_with("on SIGTERM after "), "{ending}");
    assert!(ending.ends_with('s'), "{ending}");
    let clean = last_exit_cause(&first_log);
    assert_cause(&clean, "exit code 0");

    let time = last_log_time(&first_log);
    let mut second = fixture.serve(endpoint).await;
    assert!(
        fixture.log("serve.log").contains(&format!(
            "Previous Nucleus engine run shut down cleanly (last log at {time}): {clean}"
        )),
        "{}",
        fixture.log("serve.log")
    );
    let last_time = last_log_time(&fixture.log("serve.log"));
    // A refused second launch must not claim the running engine's record.
    let mut refused = fixture
        .serve_command(endpoint)
        .spawn()
        .expect("start a second serve");
    assert_eq!(exit(&mut refused).await.code(), Some(1));
    assert_cause(&last_exit_cause(&fixture.log("serve.log")), "exit code 1");
    kill_process(fixture.engine(), Signal::KILL).expect("send SIGKILL to the engine");
    assert_eq!(
        exit(&mut second).await.signal(),
        Some(9),
        "the parent ends with the engine's status"
    );
    let killed = last_exit_cause(&fixture.log("serve.log"));
    assert_cause(&killed, "signal 9 (KILL)");

    let mut third = fixture.serve(endpoint).await;
    let log = fixture.log("serve.log");
    assert!(
        log.contains(&format!(
            "Previous Nucleus engine run ended unannounced (last log at {last_time}): {killed}"
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

    // A parent that dies with its engine records nothing, and no old cause returns.
    let fourth = fixture.serve(endpoint).await;
    let before = fixture.log("serve.log").len();
    let last_time = last_log_time(&fixture.log("serve.log"));
    kill_process_group(pid(&fourth), Signal::KILL).expect("kill both processes");
    let mut fourth = fourth;
    assert_eq!(exit(&mut fourth).await.signal(), Some(9));
    timeout(Duration::from_secs(5), async {
        while TcpStream::connect(endpoint).await.is_ok() {
            sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("engine releases the port");
    let _fifth = fixture.serve(endpoint).await;
    let log = fixture.log("serve.log");
    let previous = log[before..]
        .lines()
        .find(|line| line.contains("Previous Nucleus engine run"))
        .expect("the previous run");
    assert!(
        previous.ends_with(&format!("ended unannounced (last log at {last_time})")),
        "{previous}"
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
    assert_eq!(exit(&mut failed).await.code(), Some(1));
    let before = fixture.log("serve.log");
    let cause = last_exit_cause(&before);
    assert_cause(&cause, "exit code 1");
    let failure = before.lines().rev().nth(1).expect("initialization error");
    assert!(
        failure.contains("set NUCLEUS_RUST_NATIVE_INBOX to 0 or 1"),
        "{failure}"
    );

    let last_time = last_log_time(&before);
    let mut third = fixture.serve(endpoint).await;
    let log = fixture.log("serve.log");
    assert!(
        log[before.len()..].contains(&format!(
            "Previous Nucleus engine run exited with an error (last log at {last_time}): {cause}"
        )),
        "{log}"
    );
    kill_process(pid(&third), Signal::TERM).expect("stop the fixture engine");
    assert!(exit(&mut third).await.success());
}

#[tokio::test]
async fn ensure_and_serve_refresh_a_stale_marked_launcher() {
    let fixture = Profile::new().await;
    let endpoint = free_endpoint().await;
    let storage = nucleus_store::SettingsFile::open(&fixture.home)
        .expect("profile settings")
        .storage()
        .expect("profile storage");
    storage.bin().ensure().expect("provider directory");
    let launcher = storage.bin().path().join("nucleus-rust-acp");
    let home = fixture.home.display();
    // The generator names the release by its canonical path.
    let release = fs::canonicalize(CLI).expect("release path");
    let release = release.display();
    // An earlier command line with only the release path swapped.
    let stale = format!(
        "#!/bin/sh\n# nucleus-rust-acp-launcher-v1\nset -eu\n\
         '{CLI}' --endpoint {endpoint} ensure --home '{home}' \
         --control-key-file '{home}/controller.key' --serve-launcher '{home}/serve'\n\
         exec '{CLI}' acp \"$@\"\n"
    );
    let install = |script: &str| {
        fs::write(&launcher, script).expect("write the launcher");
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).expect("private");
    };
    let current = format!(
        "exec '{release}' --endpoint {endpoint} acp --ensure-launcher '{}' \"$@\"\n",
        launcher.display()
    );
    let rewritten = format!("Rewrote {} for this Nucleus release", launcher.display());

    // An engine started directly, so ensure finds it and only checks the launcher.
    let mut engine = fixture.serve(endpoint).await;
    install(&stale);
    let mut inode = 0;
    for expected_logs in [1, 0] {
        let output = fixture.ensure(endpoint).output().await.expect("ensure");
        let log = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{log}");
        assert_eq!(log.matches(&rewritten).count(), expected_logs, "{log}");
        let metadata = fs::metadata(&launcher).expect("launcher");
        assert_eq!(metadata.mode() & 0o777, 0o700);
        assert!(inode == 0 || inode == metadata.ino(), "rewritten once");
        inode = metadata.ino();
        let script = fs::read_to_string(&launcher).expect("launcher");
        assert!(script.starts_with("#!/bin/sh\n# nucleus-rust-acp-launcher-v1\n"));
        assert!(script.ends_with(&current), "{script}");
    }
    let unmarked = stale.replace("# nucleus-rust-acp-launcher-v1\n", "");
    install(&unmarked);
    let output = fixture.ensure(endpoint).output().await.expect("ensure");
    assert!(output.status.success());
    assert_eq!(fs::read_to_string(&launcher).expect("kept"), unmarked);
    kill_process(pid(&engine), Signal::TERM).expect("stop the engine");
    assert!(exit(&mut engine).await.success());

    install(&stale);
    let before = fixture.log("serve.log").len();
    let mut engine = fixture.serve(endpoint).await;
    timeout(Duration::from_secs(5), async {
        while !fixture.log("serve.log")[before..].contains(&rewritten) {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("serve left the launcher: {}", fixture.log("serve.log")));
    assert!(
        fs::read_to_string(&launcher)
            .expect("launcher")
            .ends_with(&current)
    );
    kill_process(pid(&engine), Signal::TERM).expect("stop the engine");
    assert!(exit(&mut engine).await.success());
}

struct Acp {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
}

impl Acp {
    fn spawn(mut command: Command, fixture: &Profile, binding: &std::path::Path) -> Self {
        let mut child = command
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
    restart_a_killed_engine(true).await;
}

// An installed launcher can omit `--endpoint` on its `acp` line. The binding
// still names the engine, so a refused connection there is still an outage.
#[tokio::test]
async fn acp_clients_without_an_endpoint_argument_restart_a_killed_engine() {
    restart_a_killed_engine(false).await;
}

async fn restart_a_killed_engine(named_endpoint: bool) {
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
    let mut clients = [(); 2].map(|()| {
        let command = if named_endpoint {
            fixture.command(endpoint)
        } else {
            fixture.environment(endpoint)
        };
        Acp::spawn(command, &fixture, &binding)
    });
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
    let engine = fixture.engine();
    assert_ne!(engine, original, "the launcher's process supervises");
    kill_process(engine, Signal::KILL).expect("kill the initial engine");
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
    let log = fixture.log("serve.log");
    let previous = log
        .lines()
        .find(|line| line.contains("ended unannounced (last log at "))
        .expect("the previous run");
    assert!(
        previous.contains("): signal 9 (KILL), uptime "),
        "{previous}"
    );
    for mut client in clients {
        client
            .child
            .kill()
            .await
            .expect("stop the fixture ACP client");
    }
}
