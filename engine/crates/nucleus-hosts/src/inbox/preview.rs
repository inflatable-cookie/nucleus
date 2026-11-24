use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};

use super::INBOX_THREAD;
use crate::{
    HostError, T3,
    rpc::{Read, Reply},
};

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
        fresh_link: impl FnOnce() -> Option<String> + Send,
    ) -> Result<(), HostError> {
        let origin = Url::parse(board_url)
            .map_err(|_| HostError::Configuration)?
            .origin();
        let listed = self
            .preview_call("preview.list", json!({"threadId": INBOX_THREAD}))
            .await?;
        let listed: PreviewList =
            serde_json::from_value(listed).map_err(|_| HostError::Protocol)?;
        for tab in listed.sessions.into_iter().filter(|tab| {
            tab.thread_id == INBOX_THREAD
                && tab
                    .nav_status
                    .url()
                    .is_some_and(|url| url.origin() == origin)
        }) {
            if tab.tab_id.is_empty() {
                return Err(HostError::Protocol);
            }
            self.preview_call(
                "preview.close",
                json!({"threadId": INBOX_THREAD, "tabId": tab.tab_id}),
            )
            .await?;
        }
        let link = fresh_link().ok_or(HostError::Unavailable)?;
        let opened = self
            .preview_call(
                "preview.open",
                json!({
                    "threadId": INBOX_THREAD, "url": link, "runtime": "server", "reveal": true
                }),
            )
            .await?;
        let opened: PreviewSession =
            serde_json::from_value(opened).map_err(|_| HostError::Protocol)?;
        if opened.thread_id != INBOX_THREAD || opened.tab_id.is_empty() {
            return Err(HostError::Protocol);
        }
        Ok(())
    }

    async fn preview_call(&self, method: &'static str, payload: Value) -> Result<Value, HostError> {
        match self.rpc.call(method, payload, Read::One).await? {
            Reply::Value(value) => Ok(value),
            // Preview errors may echo a pairing URL. Discard the complete failure payload.
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }
}
