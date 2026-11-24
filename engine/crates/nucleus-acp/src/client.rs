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
    Command, Identity, Phase, PullRequest, Question, Role, Verdict,
    acp::{Binding, session_id},
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

pub(crate) fn binding(cwd: &Path) -> Result<Binding, Failure> {
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
    if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 || metadata.len() > 4096 {
        return Err(Failure::Binding);
    }
    let binding: Binding =
        serde_json::from_reader(file.take(4096)).map_err(|_| Failure::Binding)?;
    if inferred.is_some_and(|id| id != binding.session_id)
        || binding.session_id.is_empty()
        || !binding.endpoint.ip().is_loopback()
        || binding.endpoint.port() == 0
        || binding.task_id.is_empty()
        || binding.task_id.len() > 64
        || !binding
            .task_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
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
    task: String,
    auth: HeaderValue,
    command_auth: Option<HeaderValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Detail {
    pub identity: Identity,
    pub phase: Phase,
    pub wait: Option<String>,
    pub question: Option<Question>,
    pub run: Option<Run>,
    pub pull_request: Option<PullRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Run {
    pub instance: String,
    pub role: Role,
    pub purpose: String,
    pub last_send_at: Option<u64>,
    #[serde(default)]
    pub reported: bool,
    pub activity: Option<Activity>,
}

#[derive(Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Activity {
    pub label: String,
    pub started_at: Option<u64>,
}

#[derive(Deserialize)]
pub(crate) struct Event {
    pub sequence: i64,
    #[serde(default)]
    pub presentation: Vec<Milestone>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Milestone {
    RunStarted {
        instance: String,
        role: Role,
        purpose: String,
    },
    RunEnded {
        instance: String,
    },
    PullRequest {
        url: String,
    },
    Verdict {
        verdict: Verdict,
    },
    Merged,
    #[serde(other)]
    Other,
}

impl ServiceClient {
    pub(crate) fn new(binding: &Binding) -> Result<Self, Failure> {
        let http = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(DEADLINE)
            .build()
            .map_err(|_| Failure::Binding)?;
        Ok(Self {
            http,
            endpoint: binding.endpoint,
            task: binding.task_id.clone(),
            auth: authorization(&binding.credential)?,
            command_auth: binding
                .command_credential
                .as_ref()
                .map(authorization)
                .transpose()?,
        })
    }

    fn request(&self, method: Method, path: &str, key: &HeaderValue) -> reqwest::RequestBuilder {
        self.http
            .request(
                method,
                format!("http://{}/v1/tasks/{}{path}", self.endpoint, self.task),
            )
            .header(AUTHORIZATION, key.clone())
    }

    pub(crate) async fn detail(&self) -> Result<Detail, Failure> {
        let detail: Detail = self.get("").await?;
        if detail.identity.id != self.task {
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

    pub(crate) async fn command(&self, command: &Command) -> Result<bool, Failure> {
        let key = self
            .command_auth
            .as_ref()
            .ok_or_else(|| Failure::Refused("This binding is read-only.".into()))?;
        let response = self
            .request(Method::POST, "/commands", key)
            .timeout(DEADLINE)
            .json(command)
            .send()
            .await
            .map_err(|_| Failure::Unavailable)?;
        if response.status() == StatusCode::SERVICE_UNAVAILABLE {
            return Err(rejection(response).await);
        }
        let response = accepted(Ok(response)).await?;
        Ok(response.status() != StatusCode::ACCEPTED)
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
