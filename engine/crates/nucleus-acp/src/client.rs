use std::{
    collections::HashMap,
    env,
    fs::File,
    io::Read,
    net::SocketAddr,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use nucleus_core::{
    Identity, Phase, PullRequest,
    acp::{InboxAnswer, InboxSnapshot, SessionBinding, lifecycle::Lifecycle, session_id},
};
use reqwest::{
    Client, Method, Response, StatusCode,
    header::{AUTHORIZATION, HeaderValue},
};
use rustix::{
    fs::{Mode, OFlags, open},
    process::{fchdir, geteuid},
};
use serde::{Deserialize, de::DeserializeOwned};

const DEADLINE: Duration = Duration::from_secs(5);
const MAX_REPLY: usize = 8 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub(crate) enum Failure {
    #[error("This directory has no Nucleus task binding.")]
    Missing,
    #[error("The Nucleus task binding is invalid.")]
    Binding,
    #[error("This Nucleus session credential was refused.")]
    Unauthorized,
    #[error("Nucleus is unavailable.")]
    Unavailable,
    #[error("Nucleus could not answer: {0}")]
    Engine(String),
    #[error("{0}")]
    Refused(String),
}

pub(crate) fn binding(cwd: &Path) -> Result<SessionBinding, Failure> {
    let explicit = env::var_os("NUCLEUS_ACP_SESSION").map(PathBuf::from);
    let (path, inferred) = if let Some(path) = explicit {
        (path, None)
    } else {
        let directory = env::var_os("NUCLEUS_ACP_BINDINGS").ok_or(Failure::Missing)?;
        if !cwd.is_absolute() {
            return Err(Failure::Binding);
        }
        let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_owned());
        let id = session_id(&cwd);
        (
            PathBuf::from(directory).join(format!("{id}.json")),
            Some(id),
        )
    };
    let file = File::from(
        open(
            path,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|error| {
            if error == rustix::io::Errno::NOENT {
                Failure::Missing
            } else {
                Failure::Binding
            }
        })?,
    );
    let metadata = file.metadata().map_err(|_| Failure::Binding)?;
    if !metadata.is_file()
        || metadata.uid() != geteuid().as_raw()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.len() > 4096
    {
        return Err(Failure::Binding);
    }
    let binding: SessionBinding =
        serde_json::from_reader(file.take(4096)).map_err(|_| Failure::Binding)?;
    if inferred.is_some_and(|id| id != binding.id())
        || binding.id().is_empty()
        || !binding.endpoint().ip().is_loopback()
        || binding.endpoint().port() == 0
        || matches!(&binding, SessionBinding::Task(task)
            if task.task_id.is_empty() || task.task_id.len() > 64
                || !task.task_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
    {
        return Err(Failure::Binding);
    }
    Ok(binding)
}

pub(crate) fn enter_scratch(workspace: &Path, scratch: &Path) -> Result<(), Failure> {
    if !scratch.is_absolute()
        || scratch.starts_with(workspace)
        || !scratch
            .canonicalize()
            .is_ok_and(|canonical| canonical == scratch)
    {
        return Err(Failure::Binding);
    }
    let directory = File::from(
        open(
            scratch,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| Failure::Binding)?,
    );
    let metadata = directory.metadata().map_err(|_| Failure::Binding)?;
    if metadata.uid() != geteuid().as_raw() || metadata.permissions().mode() & 0o077 != 0 {
        return Err(Failure::Binding);
    }
    fchdir(directory).map_err(|_| Failure::Binding)
}

#[derive(Clone)]
pub(crate) struct ServiceClient {
    http: Client,
    endpoint: SocketAddr,
    task: Option<String>,
    auth: HeaderValue,
    attempt: Arc<Mutex<HashMap<String, usize>>>,
    #[cfg(test)]
    log: Arc<std::sync::Mutex<Vec<String>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Detail {
    pub identity: Identity,
    pub reference: Option<String>,
    pub phase: Phase,
    pub lifecycle: Lifecycle,
    #[serde(default)]
    pub operator_inbox: bool,
    pub plan_scope_id: Option<String>,
    pub parent_hold: Option<String>,
    #[serde(default)]
    pub active_child: bool,
    pub pull_request: Option<PullRequest>,
    pub report: Option<Report>,
}

#[derive(Deserialize)]
pub(crate) struct Report {
    pub delivery: Option<nucleus_core::ReportDelivery>,
}

impl ServiceClient {
    pub(crate) fn new(binding: &SessionBinding) -> Result<Self, Failure> {
        let http = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(DEADLINE)
            .build()
            .map_err(|_| Failure::Binding)?;
        let (task, key) = match binding {
            SessionBinding::Task(task) => (Some(task.task_id.clone()), &task.credential),
            SessionBinding::Inbox(inbox) => (None, &inbox.inbox_credential),
        };
        Ok(Self {
            http,
            endpoint: binding.endpoint(),
            task,
            auth: authorization(key)?,
            attempt: Arc::default(),
            #[cfg(test)]
            log: Arc::default(),
        })
    }

    pub(crate) const fn is_inbox(&self) -> bool {
        self.task.is_none()
    }

    /// Reload a rotated reader. A valid binding with a different identity
    /// positively replaces this session. An unreadable file proves neither.
    pub(crate) fn renew_task_reader(&mut self, cwd: &Path, session: &str) -> Result<bool, Failure> {
        let SessionBinding::Task(next) = binding(cwd)? else {
            return Ok(false);
        };
        if next.session_id != session || self.task.as_deref() != Some(&next.task_id) {
            return Ok(false);
        }
        self.auth = authorization(&next.credential)?;
        self.endpoint = next.endpoint;
        Ok(true)
    }

    fn request(&self, method: Method, path: &str, key: &HeaderValue) -> reqwest::RequestBuilder {
        let resource = self
            .task
            .as_ref()
            .map_or_else(|| "acp/inbox".to_owned(), |task| format!("tasks/{task}"));
        self.http
            .request(
                method,
                format!("http://{}/v1/{resource}{path}", self.endpoint),
            )
            .header(AUTHORIZATION, key.clone())
    }

    pub(crate) async fn detail(&self) -> Result<Detail, Failure> {
        let detail: Detail = self.get("").await?;
        if self.task.as_ref() != Some(&detail.identity.id) {
            return Err(Failure::Binding);
        }
        Ok(detail)
    }

    async fn call<T>(
        &self,
        path: &str,
        request: reqwest::RequestBuilder,
        decode: impl AsyncFnOnce(Response) -> Result<T, Failure>,
    ) -> Result<T, Failure> {
        let started = Instant::now();
        let attempt = {
            let mut attempts = self.attempt.lock().expect("attempt lock");
            let attempt = attempts.entry(path.to_owned()).or_default();
            *attempt += 1;
            *attempt
        };
        let mut outcome = String::from("transport");
        let work = async {
            let response = request.send().await.map_err(|error| {
                if error.is_timeout() {
                    outcome = "timeout".into();
                }
                Failure::Unavailable
            })?;
            outcome = response.status().as_u16().to_string();
            let response = accepted(response).await?;
            decode(response).await
        };
        let result = if let Ok(result) = tokio::time::timeout(DEADLINE, work).await {
            result
        } else {
            outcome = "timeout".into();
            Err(Failure::Unavailable)
        };
        if result.is_err() || started.elapsed() > Duration::from_secs(2) {
            let resource = if self.task.is_some() {
                "/v1/tasks/{id}"
            } else {
                "/v1/acp/inbox"
            };
            let event = serde_json::json!({"time": time::OffsetDateTime::now_utc().to_string(), "route": format!("{resource}{path}"), "outcome": outcome, "latency_ms": started.elapsed().as_millis(), "attempt": attempt});
            #[cfg(not(test))]
            eprintln!("{event}");
            #[cfg(test)]
            self.log.lock().unwrap().push(event.to_string());
        }
        if result.is_ok() {
            self.attempt.lock().expect("attempt lock").remove(path);
        }
        result
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, Failure> {
        self.call(
            path,
            self.request(Method::GET, path, &self.auth),
            |response| async {
                serde_json::from_slice(&body(response).await?)
                    .map_err(|_| Failure::Engine("malformed reply".into()))
            },
        )
        .await
    }

    pub(crate) async fn inbox(&self) -> Result<InboxSnapshot, Failure> {
        self.get("").await
    }

    pub(crate) async fn take_inbox_replies(
        &self,
        run: Option<&str>,
    ) -> Result<Vec<String>, Failure> {
        let mut request = self.request(Method::POST, "/replies", &self.auth);
        if let Some(run) = run {
            request = request.json(run);
        }
        self.call("/replies", request, |response| async {
            serde_json::from_slice(&body(response).await?)
                .map_err(|_| Failure::Engine("malformed reply".into()))
        })
        .await
    }

    pub(crate) async fn answer(&self, answer: &InboxAnswer) -> Result<(), Failure> {
        let request = self
            .request(Method::POST, "/answer", &self.auth)
            .json(answer);
        self.call("/answer", request, |_| async { Ok(()) }).await
    }

    pub(crate) async fn stream(&self) -> Result<Invalidations, Failure> {
        let request = self.request(Method::GET, "/events", &self.auth);
        self.call("/events", request, |response| async {
            Ok(Invalidations {
                response,
                buffer: Vec::new(),
            })
        })
        .await
    }
}

fn authorization(credential: &[u8; 32]) -> Result<HeaderValue, Failure> {
    let mut auth = HeaderValue::from_str(&format!("Bearer {}", hex::encode(credential)))
        .map_err(|_| Failure::Binding)?;
    auth.set_sensitive(true);
    Ok(auth)
}

async fn accepted(response: Response) -> Result<Response, Failure> {
    match response.status() {
        StatusCode::UNAUTHORIZED => Err(Failure::Unauthorized),
        status if status.is_success() => Ok(response),
        status if status.is_server_error() => {
            let Failure::Refused(message) = rejection(response).await else {
                unreachable!()
            };
            Err(Failure::Engine(message))
        }
        _ => Err(rejection(response).await),
    }
}

async fn rejection(response: Response) -> Failure {
    #[derive(Deserialize)]
    struct Rejection {
        error: String,
    }
    let message = body(response)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Rejection>(&bytes).ok())
        .map_or_else(
            || "Nucleus refused the request.".into(),
            |reply| reply.error,
        );
    Failure::Refused(message)
}

async fn body(mut response: Response) -> Result<Vec<u8>, Failure> {
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Unavailable)? {
        if data.len() + chunk.len() > MAX_REPLY {
            return Err(Failure::Engine("oversized reply".into()));
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

pub(crate) struct Invalidations {
    response: Response,
    buffer: Vec<u8>,
}

impl Invalidations {
    pub(crate) async fn next(&mut self) -> Result<(), Failure> {
        loop {
            if let Some(end) = self.buffer.windows(2).position(|bytes| bytes == b"\n\n") {
                let event = &self.buffer[..end];
                let changed = event.starts_with(b"event: refresh\n")
                    || event.starts_with(b"event: invalidate\n");
                self.buffer.drain(..end + 2);
                if changed {
                    return Ok(());
                }
                continue;
            }
            let chunk = self
                .response
                .chunk()
                .await
                .map_err(|_| Failure::Unavailable)?
                .ok_or(Failure::Unavailable)?;
            if self.buffer.len() + chunk.len() > 64 * 1024 {
                return Err(Failure::Engine("oversized event".into()));
            }
            self.buffer.extend_from_slice(&chunk);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn fixture(
        response: Option<&'static [u8]>,
    ) -> (ServiceClient, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            if let Some(response) = response {
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.ends_with(b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0, "request closed before its headers");
                    request.extend_from_slice(&buffer[..count]);
                }
                socket.write_all(response).await.unwrap();
            } else {
                tokio::time::sleep(DEADLINE + Duration::from_secs(1)).await;
            }
        });
        let binding = SessionBinding::Inbox(nucleus_core::acp::InboxBinding {
            session_id: "fixture".into(),
            endpoint,
            inbox_credential: [0; 32],
        });
        (ServiceClient::new(&binding).unwrap(), server)
    }

    fn check_log(client: &ServiceClient, outcome: &str) {
        let lines = client.log.lock().unwrap();
        assert_eq!(lines.len(), 1);
        let event: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert!(event["time"].as_str().unwrap().contains("+00:00"));
        assert_eq!(event["route"], "/v1/acp/inbox");
        assert_eq!(event["outcome"], outcome);
        assert!(event["latency_ms"].as_u64().is_some());
        assert_eq!(event["attempt"], 1);
    }

    #[tokio::test]
    async fn engine_error_preserves_message_and_logs_status() {
        let (client, server) = fixture(Some(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 22\r\n\r\n{\"error\":\"store busy\"}")).await;
        let error = client.inbox().await.err().unwrap();
        assert_eq!(error.to_string(), "Nucleus could not answer: store busy");
        check_log(&client, "503");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn hung_server_times_out_and_logs_attempt() {
        let (client, server) = fixture(None).await;
        let start = Instant::now();
        let error = client.inbox().await.err().unwrap();
        assert_eq!(error.to_string(), "Nucleus is unavailable.");
        assert!(start.elapsed() >= DEADLINE);
        check_log(&client, "timeout");
        server.abort();
        let _ = server.await;
    }
}
