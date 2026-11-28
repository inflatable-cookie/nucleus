use std::{fs, os::unix::fs::PermissionsExt, sync::Arc};

use nucleus_core::acp::{InboxBinding, SessionBinding};
use tokio::{net::TcpListener, time};

use super::*;
use crate::client::ServiceClient;

struct Launcher {
    directory: tempfile::TempDir,
}

impl Launcher {
    fn new() -> Self {
        let directory = tempfile::tempdir().expect("launcher fixture");
        let launcher = Self { directory };
        let path = launcher.path();
        fs::write(&path, "#!/bin/sh\necho \"$1\" >>\"$0.runs\"\n").expect("write the launcher");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("executable");
        launcher
    }

    fn path(&self) -> PathBuf {
        self.directory.path().join("launcher")
    }

    /// Wait for any started attempt, then count the launcher's runs.
    async fn runs(&self, recovery: &Recovery) -> usize {
        let running = recovery.outage.lock().unwrap().running.take();
        if let Some(running) = running {
            running.await.expect("recovery attempt");
        }
        fs::read_to_string(self.directory.path().join("launcher.runs"))
            .unwrap_or_default()
            .lines()
            .inspect(|line| assert_eq!(*line, "--ensure-only"))
            .count()
    }
}

/// An address with no listener behind it.
async fn closed_port() -> SocketAddr {
    TcpListener::bind("127.0.0.1:0")
        .await
        .expect("reserve")
        .local_addr()
        .expect("endpoint")
}

fn client(endpoint: SocketAddr, recovery: &Arc<Recovery>) -> ServiceClient {
    let binding = SessionBinding::Inbox(InboxBinding {
        session_id: "fixture".into(),
        endpoint,
        inbox_credential: [0; 32],
    });
    ServiceClient::new(&binding, Some(Arc::clone(recovery))).expect("client")
}

async fn advance(duration: Duration) {
    time::pause();
    time::advance(duration).await;
    time::resume();
}

async fn request(client: &ServiceClient, events: bool) {
    let failed = if events {
        client.stream().await.is_err()
    } else {
        client.inbox().await.is_err()
    };
    assert!(failed, "the fixture endpoint cannot answer");
}

async fn closed_port_recovers(events: bool) {
    let endpoint = closed_port().await;
    let launcher = Launcher::new();
    let recovery = Arc::new(Recovery::new(Some(endpoint), launcher.path()));
    let client = client(endpoint, &recovery);

    request(&client, events).await;
    let line = client
        .log_lines()
        .pop()
        .expect("the failed request is logged");
    let event: serde_json::Value = serde_json::from_str(&line).expect("event JSON");
    assert_eq!(event["refused"], true, "{line}");
    assert_eq!(event["outcome"], "transport", "{line}");
    assert_eq!(launcher.runs(&recovery).await, 0, "the grace comes first");

    // Each step waits, fails one request and expects this many attempts so far.
    for (wait_ms, attempts) in [
        (2000, 1),
        (0, 1),
        (1000, 1),
        (1000, 2),
        (3000, 2),
        (1000, 3),
    ] {
        advance(Duration::from_millis(wait_ms)).await;
        request(&client, events).await;
        assert_eq!(
            launcher.runs(&recovery).await,
            attempts,
            "after {wait_ms} ms"
        );
    }
}

#[tokio::test]
async fn a_closed_port_recovers_from_the_event_stream() {
    closed_port_recovers(true).await;
}

#[tokio::test]
async fn a_closed_port_recovers_from_an_ordinary_request() {
    closed_port_recovers(false).await;
}

#[tokio::test]
async fn a_named_endpoint_ignores_a_binding_for_another_one() {
    let endpoint = closed_port().await;
    let launcher = Launcher::new();
    let other = SocketAddr::from(([127, 0, 0, 1], endpoint.port() ^ 1));
    let recovery = Arc::new(Recovery::new(Some(other), launcher.path()));
    let client = client(endpoint, &recovery);
    request(&client, false).await;
    advance(REFUSAL_GRACE).await;
    request(&client, false).await;
    assert_eq!(launcher.runs(&recovery).await, 0);
}

#[tokio::test]
async fn a_reachable_slow_endpoint_starts_no_recovery() {
    // The kernel completes connections to this listener. Nothing answers them.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
    let endpoint = listener.local_addr().expect("endpoint");
    let launcher = Launcher::new();
    let recovery = Arc::new(Recovery::new(None, launcher.path()));
    let client = client(endpoint, &recovery);
    for _ in 0..2 {
        tokio::join!(request(&client, true), request(&client, false));
        advance(REFUSAL_GRACE).await;
    }
    assert_eq!(launcher.runs(&recovery).await, 0);
    let lines = client.log_lines();
    assert_eq!(lines.len(), 4);
    for line in lines {
        assert!(line.contains(r#""outcome":"timeout""#), "{line}");
        assert!(line.contains(r#""refused":false"#), "{line}");
    }
}
