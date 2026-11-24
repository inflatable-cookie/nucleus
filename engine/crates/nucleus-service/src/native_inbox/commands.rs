use std::sync::atomic::Ordering;

use nucleus_hosts::InboxOperatorMessage;

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
            // A typed request can also satisfy this connection's automatic attempt.
            inbox.preview_pending.store(false, Ordering::Relaxed);
            self.show_inbox_board(inbox, true).await;
        }
        if self.board.get().is_some() && inbox.preview_pending.swap(false, Ordering::Relaxed) {
            self.show_inbox_board(inbox, false).await;
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

    async fn show_inbox_board(&self, inbox: &NativeInbox, typed: bool) {
        let board_url = format!("http://{}/", self.callback);
        let reply = if let Some(board) = self.board.get() {
            let result = self
                .host
                .preview_inbox_board(&board_url, || board.inbox_link(self.callback))
                .await;
            if let Err(error) = &result {
                eprintln!("Nucleus Inbox board: {error}");
            }
            if !typed {
                return;
            }
            match result {
                Ok(()) => format!("Board at {board_url}"),
                Err(error) => format!(
                    "Could not open the board ({error}). Please type ui again to retry.\nBoard at {board_url}"
                ),
            }
        } else {
            "The local board is unavailable. Please type ui again to retry.".into()
        };
        if let Ok(mut replies) = inbox.replies.lock() {
            if replies.len() == REPLY_CAPACITY {
                replies.pop_front();
            }
            replies.push_back(reply);
            drop(replies);
            inbox.observed.send_modify(|_| {});
        }
    }
}
