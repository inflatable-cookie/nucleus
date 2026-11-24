use nucleus_core::acp::INBOX_PREVIEW_TIMEOUT;
use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::{Instant, timeout_at};

use super::INBOX_THREAD;
use crate::{
    HostError, T3,
    rpc::{Read, Reply},
};

/// The failed Inbox preview stage and a value-free error kind.
#[derive(Debug, thiserror::Error)]
#[error("{stage}: {kind}")]
pub struct InboxPreviewError {
    stage: &'static str,
    kind: &'static str,
}

impl InboxPreviewError {
    const fn new(stage: &'static str, kind: &'static str) -> Self {
        Self { stage, kind }
    }
}

#[derive(Deserialize)]
struct PreviewList {
    sessions: Vec<PreviewSession>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewSession {
    thread_id: String,
    tab_id: String,
    nav_status: Navigation,
    #[serde(rename = "updatedAt")]
    _updated_at: String,
}

#[derive(Deserialize)]
#[serde(tag = "_tag")]
enum Navigation {
    Idle,
    Loading { url: String },
    Success { url: String },
    LoadFailed { url: String },
}

impl Navigation {
    fn url(&self) -> Option<Url> {
        match self {
            Self::Idle => None,
            Self::Loading { url } | Self::Success { url } | Self::LoadFailed { url } => {
                Url::parse(url).ok()
            }
        }
    }
}

impl T3 {
    /// Reveal the board in the already verified, pinned Rust Inbox.
    /// Existing board tabs are closed before the caller issues a fresh link.
    ///
    /// # Errors
    /// Returns an error if the board link cannot be issued or T3 fails to acknowledge a request.
    pub async fn preview_inbox_board(
        &self,
        board_url: &str,
        operator_requested: bool,
        fresh_link: impl FnOnce() -> Option<String> + Send,
    ) -> Result<(), InboxPreviewError> {
        let deadline = Instant::now() + INBOX_PREVIEW_TIMEOUT;
        let origin = Url::parse(board_url)
            .map_err(|_| InboxPreviewError::new("board origin", "invalid configuration"))?
            .origin();
        let class = if operator_requested {
            Read::One
        } else {
            Read::Background
        };
        let listed = self
            .preview_call(
                "preview.list",
                json!({"threadId": INBOX_THREAD}),
                class,
                deadline,
            )
            .await?;
        let listed: PreviewList = serde_json::from_value(listed)
            .map_err(|_| InboxPreviewError::new("preview.list", "unexpected reply"))?;
        for tab in listed.sessions.into_iter().filter(|tab| {
            tab.thread_id == INBOX_THREAD
                && tab
                    .nav_status
                    .url()
                    .is_some_and(|url| url.origin() == origin)
        }) {
            if tab.tab_id.is_empty() {
                return Err(InboxPreviewError::new("preview.list", "missing tab id"));
            }
            self.preview_call(
                "preview.close",
                json!({"threadId": INBOX_THREAD, "tabId": tab.tab_id}),
                class,
                deadline,
            )
            .await?;
        }
        let link = fresh_link().ok_or(InboxPreviewError::new("board pairing", "unavailable"))?;
        let opened = self
            .preview_call(
                "preview.open",
                json!({
                    "threadId": INBOX_THREAD, "url": link, "runtime": "server", "reveal": true
                }),
                class,
                deadline,
            )
            .await?;
        let opened: PreviewSession = serde_json::from_value(opened)
            .map_err(|_| InboxPreviewError::new("preview.open", "unexpected reply"))?;
        if opened.thread_id != INBOX_THREAD || opened.tab_id.is_empty() {
            return Err(InboxPreviewError::new(
                "preview.open",
                "unexpected tab identity",
            ));
        }
        Ok(())
    }

    async fn preview_call(
        &self,
        method: &'static str,
        payload: Value,
        class: Read,
        deadline: Instant,
    ) -> Result<Value, InboxPreviewError> {
        if Instant::now() >= deadline {
            return Err(InboxPreviewError::new(method, "timeout"));
        }
        let reply = timeout_at(deadline, self.rpc.call(method, payload, class))
            .await
            .unwrap_or(Err(HostError::Timeout))
            .map_err(|error| {
                InboxPreviewError::new(
                    method,
                    match error {
                        HostError::Timeout => "timeout",
                        HostError::Deferred { .. } => "connection backoff",
                        HostError::Unavailable => "host unavailable",
                        HostError::Protocol => "unexpected reply",
                        _ => "host failure",
                    },
                )
            })?;
        match reply {
            Reply::Value(value) => Ok(value),
            Reply::Failure(cause) => Err(InboxPreviewError::new(method, native_error_kind(&cause))),
        }
    }
}

fn native_error_kind(cause: &Value) -> &'static str {
    // The failure payload can contain the pairing link. Only fixed descriptions
    // of known native error tags leave this boundary.
    let error = cause
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|entry| (entry["_tag"] == "Fail").then_some(&entry["error"]));
    match error.and_then(|error| error["_tag"].as_str()) {
        Some("EnvironmentAuthorizationError")
            if error.is_some_and(|error| {
                error["requiredPermission"] == "preview:operate"
                    || error["requiredScope"] == "preview:operate"
            }) =>
        {
            "missing preview:operate scope"
        }
        Some("EnvironmentAuthorizationError") => "scope denied",
        Some("PreviewSessionLookupError") => "missing preview session",
        Some("PreviewInvalidUrlError") => "invalid preview address",
        Some("PreviewControlRequiredError") => "preview control required",
        _ => "native failure",
    }
}
