use std::{
    error::Error,
    io::{self, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::Duration,
};

use tokio::{process::Command, task::JoinHandle, time::Instant};

// Allow a brief listener gap during an ordinary engine roll.
const REFUSAL_GRACE: Duration = Duration::from_secs(2);

/// Whether an HTTP request failed to connect because the socket refused it.
#[must_use]
pub fn connection_refused(error: &reqwest::Error) -> bool {
    error.is_connect()
        && std::iter::successors(error.source(), |&cause| cause.source()).any(|cause| {
            cause
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::ConnectionRefused)
        })
}

/// Run the installed provider launcher's existing engine startup path.
///
/// # Errors
/// Returns an error if the launcher fails or does not finish within 30 seconds.
pub async fn ensure_launcher(launcher: &Path) -> io::Result<()> {
    let running = Command::new(launcher)
        .arg("--ensure-only")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .status();
    if tokio::time::timeout(Duration::from_secs(30), running)
        .await??
        .success()
    {
        Ok(())
    } else {
        Err(io::Error::other(
            "the local engine did not report healthy; check the serve launcher and log",
        ))
    }
}

pub(crate) struct Recovery {
    endpoint: SocketAddr,
    launcher: PathBuf,
    outage: Mutex<Outage>,
}

#[derive(Default)]
struct Outage {
    next_attempt: Option<Instant>,
    attempts: u32,
    running: Option<JoinHandle<()>>,
}

impl Recovery {
    pub(crate) fn new(endpoint: SocketAddr, launcher: PathBuf) -> Self {
        Self {
            endpoint,
            launcher,
            outage: Mutex::default(),
        }
    }

    pub(crate) fn observe(&self, endpoint: SocketAddr, refused: bool) {
        if endpoint != self.endpoint {
            return;
        }
        let mut outage = self.outage.lock().expect("engine recovery lock");
        if !refused {
            outage.next_attempt = None;
            outage.attempts = 0;
            return;
        }
        let now = Instant::now();
        if now < *outage.next_attempt.get_or_insert(now + REFUSAL_GRACE)
            || outage
                .running
                .as_ref()
                .is_some_and(|job| !job.is_finished())
        {
            return;
        }
        outage.attempts = outage.attempts.saturating_add(1);
        let attempt = outage.attempts;
        let delay = Duration::from_secs((1_u64 << attempt.min(5)).min(30));
        outage.next_attempt = Some(now + delay);
        let launcher = self.launcher.clone();
        outage.running = Some(tokio::spawn(async move {
            log_attempt(attempt, "started");
            match ensure_launcher(&launcher).await {
                Ok(()) => log_attempt(attempt, "healthy"),
                Err(error) => log_attempt(attempt, &error.to_string()),
            }
        }));
    }
}

fn log_attempt(attempt: u32, outcome: &str) {
    let event = serde_json::json!({
        "time": time::OffsetDateTime::now_utc().to_string(),
        "event": "engine_recovery",
        "attempt": attempt,
        "outcome": outcome,
    });
    let _ = io::stderr().write_all(format!("{event}\n").as_bytes());
}
