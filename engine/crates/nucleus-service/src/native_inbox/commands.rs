use std::sync::atomic::Ordering;

use nucleus_hosts::InboxOperatorMessage;

use crate::{Service, ServiceError, now_ms};

use super::{NativeInbox, Observation};

const REPLY_CAPACITY: usize = 64;

pub(super) struct InboxReply {
    pub(super) run_id: String,
    text: String,
}

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
            self.show_inbox_board(inbox, Some(&message.run_id)).await;
        }
        if self.board.get().is_some() && inbox.preview_pending.swap(false, Ordering::Relaxed) {
            self.show_inbox_board(inbox, None).await;
        }
        Ok(())
    }

    pub(crate) fn take_inbox_replies(
        &self,
        credential: &[u8; 32],
        expected_run: Option<&str>,
    ) -> Result<Vec<String>, ServiceError> {
        let inbox = self.inbox_session(credential)?;
        let observed = inbox.observed.borrow();
        let Some(active_run) = self.inbox_reply_run(&observed) else {
            return Ok(Vec::new());
        };
        if expected_run.is_some_and(|expected| expected != active_run) {
            return Ok(Vec::new());
        }
        let mut pending = inbox.replies.lock().map_err(|_| ServiceError::AcpBinding)?;
        let mut replies = Vec::new();
        pending.retain_mut(|reply| {
            if reply.run_id != active_run {
                return true;
            }
            replies.push(std::mem::take(&mut reply.text));
            false
        });
        Ok(replies)
    }

    pub(super) fn inbox_reply_run<'a>(&self, observation: &'a Observation) -> Option<&'a str> {
        let Observation::Pinned {
            active_run: Some(run),
            ..
        } = observation
        else {
            return None;
        };
        self.host.inbox_run_is_active(run).then_some(run)
    }

    async fn show_inbox_board(&self, inbox: &NativeInbox, run_id: Option<&str>) {
        let board_url = format!("http://{}/", self.callback);
        let reply = if let Some(board) = self.board.get() {
            let result = self
                .host
                .preview_inbox_board(&board_url, || board.inbox_link(self.callback))
                .await;
            if let Err(error) = &result {
                eprintln!("Nucleus Inbox board: {error}");
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
        let Some(run_id) = run_id else {
            return;
        };
        if let Ok(mut replies) = inbox.replies.lock() {
            if replies.len() == REPLY_CAPACITY {
                replies.pop_front();
            }
            replies.push_back(InboxReply {
                run_id: run_id.into(),
                text: reply,
            });
            drop(replies);
            inbox.observed.send_modify(|_| {});
        }
    }
}
