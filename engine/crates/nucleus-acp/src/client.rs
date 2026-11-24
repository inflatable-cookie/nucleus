use std::{
    env,
    fs::File,
    io::Read,
    net::SocketAddr,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

use nucleus_core::{
    Identity, Phase, PullRequest, Question, Role,
    acp::{
        InboxAnswer, InboxSnapshot, SessionBinding,
        lifecycle::{Lifecycle, Milestone, Outcome},
        session_id,
    },
    profiles::Provider,
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Detail {
    pub identity: Identity,
    pub reference: Option<String>,
    pub phase: Phase,
    pub lifecycle: Lifecycle,
    pub question: Option<Question>,
    pub question_url: Option<String>,
    #[serde(default)]
    pub operator_inbox: bool,
    pub plan_scope_id: Option<String>,
    pub parent_hold: Option<String>,
    #[serde(default)]
    pub active_child: bool,
    #[serde(default)]
    pub transcript_pending: bool,
    pub run: Option<Run>,
    pub pull_request: Option<PullRequest>,
    pub report: Option<Report>,
}

#[derive(Deserialize)]
pub(crate) struct Report {
    pub delivery: Option<nucleus_core::ReportDelivery>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Run {
    pub instance: String,
    pub role: Role,
    pub purpose: String,
    pub last_send_at: Option<u64>,
    pub thread_url: Option<String>,
    pub provider: Option<Provider>,
    pub model: Option<String>,
    pub outcome: Option<Outcome>,
    pub activity: Option<Activity>,
}

#[derive(Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Activity {
    pub label: String,
}

#[derive(Deserialize)]
pub(crate) struct Event {
    pub sequence: i64,
    pub content: Option<EventContent>,
    #[serde(default)]
    pub presentation: Vec<Milestone>,
}

#[derive(Deserialize)]
pub(crate) struct EventContent {
    pub at: u64,
    pub kind: String,
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

    pub(crate) async fn history(&self, after: i64) -> Result<Vec<Event>, Failure> {
        let mut events = Vec::new();
        let mut before = i64::MAX;
        loop {
            let page: Vec<Event> = self
                .get(&format!("/history?limit=100&before={before}"))
                .await?;
            let next = page.last().map_or(after, |event| event.sequence);
            let more = page.len() == 100 && next > after && next < before;
            events.extend(page.into_iter().filter(|event| event.sequence > after));
            if !more {
                break;
            }
            before = next;
        }
        events.reverse();
        Ok(events)
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, Failure> {
        let response = accepted(
            self.request(Method::GET, path, &self.auth)
                .timeout(DEADLINE)
                .send()
                .await,
        )
        .await?;
        serde_json::from_slice(&body(response).await?).map_err(|_| Failure::Unavailable)
    }

    pub(crate) async fn inbox(&self) -> Result<InboxSnapshot, Failure> {
        self.get("").await
    }

    pub(crate) async fn take_inbox_replies(
        &self,
        run: Option<&str>,
    ) -> Result<Vec<String>, Failure> {
        let mut request = self
            .request(Method::POST, "/replies", &self.auth)
            .timeout(DEADLINE);
        if let Some(run) = run {
            request = request.json(run);
        }
        let response = accepted(request.send().await).await?;
        serde_json::from_slice(&body(response).await?).map_err(|_| Failure::Unavailable)
    }

    pub(crate) async fn answer(&self, answer: &InboxAnswer) -> Result<(), Failure> {
        let response = self
            .request(Method::POST, "/answer", &self.auth)
            .timeout(DEADLINE)
            .json(answer)
            .send()
            .await;
        accepted(response).await?;
        Ok(())
    }

    pub(crate) async fn stream(&self) -> Result<Invalidations, Failure> {
        let response = tokio::time::timeout(
            DEADLINE,
            self.request(Method::GET, "/events", &self.auth).send(),
        )
        .await
        .map_err(|_| Failure::Unavailable)?;
        Ok(Invalidations {
            response: accepted(response).await?,
            buffer: Vec::new(),
        })
    }
}

fn authorization(credential: &[u8; 32]) -> Result<HeaderValue, Failure> {
    let mut auth = HeaderValue::from_str(&format!("Bearer {}", hex::encode(credential)))
        .map_err(|_| Failure::Binding)?;
    auth.set_sensitive(true);
    Ok(auth)
}

async fn accepted(result: Result<Response, reqwest::Error>) -> Result<Response, Failure> {
    let response = result.map_err(|_| Failure::Unavailable)?;
    match response.status() {
        StatusCode::UNAUTHORIZED => Err(Failure::Unauthorized),
        status if status.is_success() => Ok(response),
        status if status.is_server_error() => Err(Failure::Unavailable),
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
            return Err(Failure::Unavailable);
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
                return Err(Failure::Unavailable);
            }
            self.buffer.extend_from_slice(&chunk);
        }
    }
}
