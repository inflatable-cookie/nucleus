use std::{
    env,
    fs::File,
    io::Read,
    os::unix::fs::MetadataExt,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use nucleus_core::{Action, Answer, Authority, Command, WaitReason};
use nucleus_store::{InboxBinding, TaskRow};
use reqwest::{Client, Url};
use rustix::{
    fs::{Mode, OFlags, open},
    process::geteuid,
};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use crate::{Preflight, Service, ServiceError, event, now_ms};

#[cfg(test)]
mod tests;

const MAX_BODY: usize = 4096;
const RETRY: Duration = Duration::from_secs(15);

pub(super) struct Inbox {
    client: Client,
    url: Url,
    engine: String,
    key: String,
    until_ms: AtomicU64,
    retry_ms: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Operation {
    Ensure,
    Withdraw,
}

#[derive(Serialize)]
struct Request<'a> {
    operation: Operation,
    id: &'a str,
    repository: &'a str,
    reference: &'a str,
    head: &'a str,
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum Reply {
    Pending,
    Accepted { actor: String, reason: String },
    Declined,
    Withdrawn,
}

fn key(path: &Path) -> Result<String, ServiceError> {
    let failure = ServiceError::InboxConfiguration;
    if !path.is_absolute() {
        return Err(failure);
    }
    let file = File::from(
        open(
            path,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| ServiceError::InboxConfiguration)?,
    );
    let stat = file
        .metadata()
        .map_err(|_| ServiceError::InboxConfiguration)?;
    if !stat.is_file() || stat.uid() != geteuid().as_raw() || stat.mode() & 0o077 != 0 {
        return Err(failure);
    }
    let mut secret = String::new();
    file.take(66)
        .read_to_string(&mut secret)
        .map_err(|_| ServiceError::InboxConfiguration)?;
    if secret.ends_with('\n') {
        secret.pop();
    }
    if secret.len() != 64
        || !secret
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(failure);
    }
    Ok(secret)
}

impl Inbox {
    fn configured() -> Result<Option<Self>, ServiceError> {
        let endpoint = env::var_os("NUCLEUS_RUST_INBOX_URL");
        let engine = env::var_os("NUCLEUS_RUST_INBOX_ENGINE");
        let file = env::var_os("NUCLEUS_RUST_INBOX_KEY_FILE");
        match (endpoint, engine, file) {
            (None, None, None) => Ok(None),
            (Some(endpoint), Some(engine), Some(file)) => Self::new(
                endpoint.to_str().ok_or(ServiceError::InboxConfiguration)?,
                engine
                    .into_string()
                    .map_err(|_| ServiceError::InboxConfiguration)?,
                key(Path::new(&file))?,
            )
            .map(Some),
            _ => Err(ServiceError::InboxConfiguration),
        }
    }

    fn new(endpoint: &str, engine: String, key: String) -> Result<Self, ServiceError> {
        let mut url = Url::parse(endpoint).map_err(|_| ServiceError::InboxConfiguration)?;
        if url.host_str() != Some("127.0.0.1")
            || url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || engine.is_empty()
            || engine.len() > 48
            || !engine
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(ServiceError::InboxConfiguration);
        }
        url.set_path("/api/internal/rust-inbox");
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|_| ServiceError::InboxConfiguration)?;
        Ok(Self {
            client,
            url,
            engine,
            key,
            until_ms: AtomicU64::new(0),
            retry_ms: AtomicU64::new(0),
        })
    }

    async fn call(&self, input: &Request<'_>) -> Result<Reply, ServiceError> {
        let pending = self
            .until_ms
            .load(Ordering::Relaxed)
            .saturating_sub(now_ms());
        if pending > 0 {
            return Err(ServiceError::InboxUnavailable {
                until: Instant::now() + Duration::from_millis(pending),
            });
        }
        if let Ok(reply) = self.read(input).await {
            self.retry_ms.store(0, Ordering::Relaxed);
            self.until_ms.store(0, Ordering::Relaxed);
            return Ok(reply);
        }
        let delay = (self.retry_ms.load(Ordering::Relaxed) * 2).clamp(15_000, 120_000);
        self.retry_ms.store(delay, Ordering::Relaxed);
        self.until_ms
            .store(now_ms().saturating_add(delay), Ordering::Relaxed);
        Err(ServiceError::InboxUnavailable {
            until: Instant::now() + Duration::from_millis(delay),
        })
    }

    async fn read(&self, input: &Request<'_>) -> Result<Reply, ()> {
        let mut response = self
            .client
            .post(self.url.clone())
            .bearer_auth(&self.key)
            .json(input)
            .send()
            .await
            .map_err(|_| ())?
            .error_for_status()
            .map_err(|_| ())?;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
            if chunk.len() > MAX_BODY - body.len() {
                return Err(());
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| ())
    }
}

fn wire<'a>(
    operation: Operation,
    row: &'a TaskRow,
    binding: &'a InboxBinding,
    reference: &'a str,
) -> Request<'a> {
    Request {
        operation,
        id: &binding.decision_id,
        repository: &row.task.identity().repository,
        reference,
        head: &binding.head,
    }
}

fn reference(row: &TaskRow) -> String {
    row.task
        .identity()
        .reference
        .trim()
        .chars()
        .take(120)
        .collect()
}

impl Service {
    /// Configure the optional scheduler bridge from its environment and owner-only key.
    /// # Errors
    /// Returns an error if any supplied bridge setting is invalid.
    pub fn with_inbox_from_env(mut self) -> Result<Self, ServiceError> {
        self.inbox = Inbox::configured()?;
        Ok(self)
    }

    pub(super) async fn clear_stale_inbox(&self, row: &TaskRow) -> Result<(), ServiceError> {
        let Some(inbox) = &self.inbox else {
            return Ok(());
        };
        let task = &row.task.identity().id;
        let Some(binding) = self.state.lock().await.store.inbox_binding(task)? else {
            return Ok(());
        };
        if binding.task_version == row.version
            && row.task.operator_decline().is_none()
            && row.task.operator_question().is_some()
        {
            return Ok(());
        }
        let _fence = self.effect(row).await?;
        let reference = reference(row);
        if matches!(
            inbox
                .call(&wire(Operation::Withdraw, row, &binding, &reference))
                .await?,
            Reply::Withdrawn
        ) {
            self.state
                .lock()
                .await
                .store
                .clear_inbox(task, &binding.decision_id)?;
            Ok(())
        } else {
            Err(ServiceError::InboxUnavailable {
                until: Instant::now() + RETRY,
            })
        }
    }

    pub(super) async fn operator_decision(&self, row: &TaskRow) -> Result<Action, ServiceError> {
        let waiting = Action::Wait(WaitReason::Question);
        let Some(inbox) = &self.inbox else {
            return Ok(waiting);
        };
        let Some(head) = row.task.operator_question() else {
            return Ok(waiting);
        };
        let _fence = self.effect(row).await?;
        let id = &row.task.identity().id;
        let binding = {
            let mut state = self.state.lock().await;
            if let Some(bound) = state.store.inbox_binding(id)? {
                if bound.task_version != row.version || bound.head != head.as_str() {
                    return Ok(waiting);
                }
                bound
            } else {
                let binding = InboxBinding {
                    task_version: row.version,
                    decision_id: format!("rust-inbox:{}:{id}:{}", inbox.engine, row.version),
                    head: head.as_str().into(),
                };
                state.store.bind_inbox(id, &binding)?;
                binding
            }
        };
        let reference = reference(row);
        let reply = inbox
            .call(&wire(Operation::Ensure, row, &binding, &reference))
            .await?;
        let (actor, reason, declined) = match reply {
            Reply::Accepted { actor, reason } => (actor, reason, false),
            Reply::Declined => ("operator (Inbox)".into(), String::new(), true),
            Reply::Pending | Reply::Withdrawn => return Ok(waiting),
        };
        let mut state = self.state.lock().await;
        let current = self.lookup(&state, id)?;
        if current != *row {
            return Ok(waiting);
        }
        let observation = state.command_observation(&current);
        let mut updated = current.task.clone();
        let command = Command::Answer(Answer::Accept {
            head: head.clone(),
            reason,
        });
        let authority = Authority::Operator { actor };
        if !matches!(
            state.preflight(&mut updated, &authority, &observation, command)?,
            Preflight::Ready
        ) {
            return Ok(waiting);
        }
        if declined {
            updated = current.task.clone();
            if !updated.decline_operator_question(head) {
                return Ok(waiting);
            }
        }
        self.commit(
            &mut state,
            row,
            &updated,
            &event(if declined {
                "operator_declined"
            } else {
                "operator_accepted"
            }),
            None,
        )?;
        Ok(waiting)
    }
}
