use std::{process::Stdio, time::Duration};

use nucleus_hosts::InboxOperatorMessage;
use tokio::{process::Command, time::timeout};

use crate::{Service, ServiceError, now_ms};

use super::NativeInbox;

const REPLY_CAPACITY: usize = 64;

impl Service {
    pub(super) async fn serve_inbox_commands(
        &self,
        inbox: &NativeInbox,
        messages: &[InboxOperatorMessage],
    ) -> Result<(), ServiceError> {
        for message in messages {
            if message.text != "ui" || message.id.is_empty() || message.id.len() > 512 {
                continue;
            }
            if !self
                .state
                .lock()
                .await
                .store
                .claim_inbox_message(&message.id, i64::try_from(now_ms()).unwrap_or(i64::MAX))?
            {
                continue;
            }
            let reply = self.open_inbox_board().await;
            if let Ok(mut replies) = inbox.replies.lock() {
                if replies.len() == REPLY_CAPACITY {
                    replies.pop_front();
                }
                replies.push_back(reply);
            } else {
                continue;
            }
            inbox.observed.send_modify(|_| {});
        }
        Ok(())
    }

    pub(crate) fn take_inbox_replies(
        &self,
        credential: &[u8; 32],
    ) -> Result<Vec<String>, ServiceError> {
        let inbox = self.inbox_session(credential)?;
        if !matches!(&*inbox.observed.borrow(), super::Observation::Pinned(_)) {
            return Ok(Vec::new());
        }
        Ok(inbox
            .replies
            .lock()
            .map_err(|_| ServiceError::AcpBinding)?
            .drain(..)
            .collect())
    }

    async fn open_inbox_board(&self) -> String {
        let Some(board) = self.board.get() else {
            return "The local board is unavailable.".into();
        };
        let Some(link) = board.inbox_link(self.callback) else {
            return "Could not issue a one-use board link.".into();
        };
        let board_url = format!("http://{}/", self.callback);
        let opener = if cfg!(target_os = "macos") {
            "/usr/bin/open"
        } else {
            "xdg-open"
        };
        let mut command = Command::new(opener);
        let scratch = self.storage.scratch().path();
        command
            .arg(link)
            .env("TMPDIR", scratch)
            .env("TMP", scratch)
            .env("TEMP", scratch)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if timeout(Duration::from_secs(5), command.status())
            .await
            .is_ok_and(|result| result.is_ok_and(|status| status.success()))
        {
            format!("Board at {board_url}")
        } else {
            format!("Could not open the browser. Board at {board_url}")
        }
    }
}
