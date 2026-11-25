use std::{
    fs,
    net::{Ipv4Addr, SocketAddr},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    time::Duration,
};

use axum::{Router, http::StatusCode, routing::get};
use rustix::{
    fs::{FlockOperation, flock},
    io::Errno,
    process::{Pid, Signal, kill_process},
};
use tokio::{
    net::{TcpListener, TcpStream},
    process::Command,
    time::{sleep, timeout},
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
        Self {
            _directory: directory,
            home,
        }
    }

    fn ensure(&self, endpoint: SocketAddr) -> Command {
        let endpoint = endpoint.to_string();
        let mut command = Command::new(CLI);
        command
            .args(["--endpoint", &endpoint, "ensure", "--home"])
            .arg(&self.home)
            .arg("--serve-launcher")
            .arg(self.home.join("serve"))
            .arg("--control-key-file")
            .arg(self.home.join("controller.key"))
            .env("NUCLEUS_ENGINE_CONTROL_KEY", KEY)
            .env("NUCLEUS_ENGINE_T3_CALLER_KEY", "12".repeat(32))
            .env("NUCLEUS_ENGINE_T3_BEARER", "synthetic")
            .env("NUCLEUS_ENGINE_GITHUB_TOKEN", "synthetic")
            .env("NUCLEUS_FIXTURE_LAUNCHES", self.home.join("launches"))
            .env("NUCLEUS_FIXTURE_HOME", &self.home)
            .env("NUCLEUS_FIXTURE_BINARY", CLI)
            .env("NUCLEUS_FIXTURE_ENDPOINT", &endpoint)
            .env_remove("NUCLEUS_RUST_NATIVE_INBOX")
            .kill_on_drop(true);
        command
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
        for pid in self.launches() {
            let _ = kill_process(pid, Signal::TERM);
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
