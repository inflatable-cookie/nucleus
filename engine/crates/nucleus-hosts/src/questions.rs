use nucleus_core::QuestionDelivery;
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    HostError, LATE_REPLY_MS, T3, clock_ms, dispatch_rejected,
    launch::message_id,
    projection,
    rpc::{Read, Reply},
};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerThread {
    pub id: String,
    pub project_id: String,
    pub updated_at: String,
    pub latest_user_message_at: Option<String>,
    pub worktree_path: Option<String>,
    pub archived_at: Option<String>,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeState {
    Gone,
    Absent,
    Queued,
    Started,
    /// The exact turn terminated before entering its provider.
    Undelivered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeSend {
    Accepted,
    Rejected,
}

#[derive(Clone)]
pub struct NoticeTarget {
    pub thread: String,
    pub project_id: String,
    pub worktree_path: Option<String>,
}

/// Exact wire and thread evidence prepared by a fresh native read.
pub struct NoticeAuthorization {
    target: NoticeTarget,
    command: String,
    payload: Box<RawValue>,
    previous: Option<u64>,
    wake: Option<u64>,
}

/// The caller must persist the corresponding send marker before dispatch.
pub struct NoticeDispatch {
    command: String,
    payload: Box<RawValue>,
}

impl NoticeAuthorization {
    #[must_use]
    pub const fn target(&self) -> &NoticeTarget {
        &self.target
    }

    #[must_use]
    pub const fn needs_unsettle(&self) -> bool {
        self.wake.is_some()
    }

    /// Advance the notice marker before persisting and using the permit.
    /// # Errors
    /// Returns an error if the notice changed after authorization.
    pub fn record(self, delivery: &mut QuestionDelivery) -> Result<NoticeDispatch, HostError> {
        if self.wake.is_some()
            || delivery.thread != self.target.thread
            || delivery.command != self.command
            || delivery.payload != self.payload.get()
            || delivery.last_send_at_ms != self.previous
        {
            return Err(HostError::Binding);
        }
        delivery.last_send_at_ms = Some(clock_ms()?);
        Ok(NoticeDispatch {
            command: self.command,
            payload: self.payload,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoticeThread {
    id: String,
    project_id: String,
    worktree_path: Option<String>,
    archived_at: Option<String>,
    deleted_at: Option<String>,
    settled_at: Option<String>,
    settled_override: Option<String>,
    snoozed_until: Option<String>,
}

struct NoticeSnapshot {
    sequence: u64,
    thread: NoticeThread,
    projection: Value,
}

impl T3 {
    /// Read the host's planner candidates. A missing or partial listing cannot
    /// establish that a stronger candidate is absent.
    /// # Errors
    /// Returns an error when the host inventory is unreadable.
    pub async fn planner_threads(&self) -> Result<Vec<PlannerThread>, HostError> {
        let Reply::Value(result) = self
            .rpc
            .call(
                "orchestration.subscribeShell",
                json!({
                    "requestCompletionMarker": true,
                }),
                Read::Shell,
            )
            .await?
        else {
            return Err(HostError::Uncertain);
        };
        let threads = result
            .pointer("/snapshot/threads")
            .ok_or(HostError::Protocol)?;
        serde_json::from_value(threads.clone()).map_err(|_| HostError::Protocol)
    }

    /// Verify the precise delivery target, including threads not in the shell.
    /// # Errors
    /// Returns an error for an unreadable or different thread.
    pub async fn planner_routable(&self, thread: &str) -> Result<bool, HostError> {
        Ok(self.notice_projection(thread).await?.is_some())
    }

    /// Recheck the actual thread and workspace of an authorized notice.
    /// # Errors
    /// Returns an error if the destination changed or could not be read.
    pub async fn check_notice_target(&self, target: &NoticeTarget) -> Result<(), HostError> {
        let snapshot = self
            .notice_projection(&target.thread)
            .await?
            .ok_or(HostError::Binding)?;
        if snapshot.thread.project_id != target.project_id
            || snapshot.thread.worktree_path != target.worktree_path
        {
            return Err(HostError::Binding);
        }
        Ok(())
    }

    /// Freeze a queued planner notification under one native command ID.
    /// # Errors
    /// Returns an error when the request cannot be encoded.
    pub fn prepare_notice(
        thread: String,
        command: String,
        text: &str,
    ) -> Result<QuestionDelivery, HostError> {
        let payload = serde_json::to_string(&json!({
            "type":"message.dispatch", "threadId":thread, "commandId":command,
            "messageId":message_id(&command), "text":text, "attachments":[],
            "createdBy":"user", "creationSource":"server", "dispatchMode":{"type":"queue_after_active"}
        })).map_err(|_| HostError::Protocol)?;
        Ok(QuestionDelivery {
            thread,
            command,
            payload,
            last_send_at_ms: None,
        })
    }

    /// Observe the exact message without treating queue acceptance as delivery.
    /// # Errors
    /// Returns an error if the thread or message cannot be read.
    pub async fn notice_state(
        &self,
        delivery: &QuestionDelivery,
    ) -> Result<NoticeState, HostError> {
        let Some(snapshot) = self.notice_projection(&delivery.thread).await? else {
            return Ok(NoticeState::Gone);
        };
        notice_state(&snapshot.projection, &delivery.command)
    }

    /// Reconcile any preceding send and prepare a dispatch or unsettle.
    /// # Errors
    /// Returns an error when the request is unreadable.
    pub async fn authorize_notice(
        &self,
        delivery: &QuestionDelivery,
    ) -> Result<Option<NoticeAuthorization>, HostError> {
        let now_ms = clock_ms()?;
        let reply_may_arrive = delivery
            .last_send_at_ms
            .is_some_and(|sent| now_ms.saturating_sub(sent) < LATE_REPLY_MS);
        let payload = frozen_payload(delivery)?;
        let Some(snapshot) = self.notice_projection(&delivery.thread).await? else {
            return Ok(None);
        };
        let state = notice_state(&snapshot.projection, &delivery.command)?;
        let ready = match state {
            NoticeState::Absent => !reply_may_arrive,
            NoticeState::Queued => settled(&snapshot.thread),
            _ => false,
        };
        if !ready || snoozed(&snapshot.thread)? {
            return Ok(None);
        }
        let wake = if settled(&snapshot.thread) {
            if snapshot.sequence == 0 {
                return Err(HostError::Uncertain);
            }
            Some(snapshot.sequence)
        } else {
            None
        };
        Ok(Some(NoticeAuthorization {
            target: NoticeTarget {
                thread: snapshot.thread.id,
                project_id: snapshot.thread.project_id,
                worktree_path: snapshot.thread.worktree_path,
            },
            command: delivery.command.clone(),
            payload,
            previous: delivery.last_send_at_ms,
            wake,
        }))
    }

    /// Unsettle an authorized planner destination. Re-read before dispatch.
    /// # Errors
    /// Returns an error when the wake is inapplicable or uncertain.
    pub async fn unsettle_notice(
        &self,
        authorization: &NoticeAuthorization,
    ) -> Result<(), HostError> {
        let sequence = authorization.wake.ok_or(HostError::Binding)?;
        let thread = &authorization.target.thread;
        self.thread_command(json!({
            "type":"thread.unsettle", "threadId":thread,
            "commandId":format!("unsettle:{thread}:{sequence}"), "reason":"user",
        }))
        .await
    }

    /// Send the recorded wire. An exact rejection permits a fresh binding.
    /// # Errors
    /// Returns an error if the outcome is uncertain.
    pub async fn send_notice(&self, dispatch: NoticeDispatch) -> Result<NoticeSend, HostError> {
        match self
            .rpc
            .call(
                "orchestration.dispatchCommand",
                dispatch.payload.as_ref(),
                Read::One,
            )
            .await?
        {
            Reply::Value(_) => Ok(NoticeSend::Accepted),
            Reply::Failure(cause) if dispatch_rejected(&cause, &dispatch.command) => {
                Ok(NoticeSend::Rejected)
            }
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }

    async fn notice_projection(&self, id: &str) -> Result<Option<NoticeSnapshot>, HostError> {
        let result = self
            .rpc
            .call(
                "orchestration.subscribeThread",
                json!({
                    "threadId":id, "requestCompletionMarker":true, "acceptBoundedSnapshot":false,
                }),
                Read::Thread,
            )
            .await?;
        let value = match result {
            Reply::Value(value) => value,
            Reply::Failure(cause) if projection::missing_thread(&cause, id) => return Ok(None),
            Reply::Failure(_) => return Err(HostError::Uncertain),
        };
        if value["hasMoreHistory"] == true
            || value["turnItemsOmitLocalVisible"] == true
            || value.get("idTable").is_some()
        {
            return Err(HostError::Uncertain);
        }
        let Value::Object(mut snapshot) = value else {
            return Err(HostError::Protocol);
        };
        let sequence = snapshot
            .get("snapshotSequence")
            .and_then(Value::as_u64)
            .ok_or(HostError::Protocol)?;
        let projection = snapshot.remove("projection").ok_or(HostError::Protocol)?;
        let thread: NoticeThread = serde_json::from_value(projection["thread"].clone())
            .map_err(|_| HostError::Protocol)?;
        if thread.id != id {
            return Err(HostError::Binding);
        }
        if thread.archived_at.is_some() || thread.deleted_at.is_some() {
            return Ok(None);
        }
        Ok(Some(NoticeSnapshot {
            sequence,
            thread,
            projection,
        }))
    }
}

fn settled(thread: &NoticeThread) -> bool {
    thread.settled_at.is_some() || thread.settled_override.as_deref() == Some("settled")
}

fn snoozed(thread: &NoticeThread) -> Result<bool, HostError> {
    thread.snoozed_until.as_deref().map_or(Ok(false), |end| {
        let end = OffsetDateTime::parse(end, &Rfc3339).map_err(|_| HostError::Protocol)?;
        Ok(end > OffsetDateTime::now_utc())
    })
}

fn frozen_payload(delivery: &QuestionDelivery) -> Result<Box<RawValue>, HostError> {
    let payload: Box<RawValue> =
        serde_json::from_str(&delivery.payload).map_err(|_| HostError::Binding)?;
    let fields: Value = serde_json::from_str(payload.get()).map_err(|_| HostError::Binding)?;
    if fields["threadId"] != delivery.thread
        || fields["commandId"] != delivery.command
        || fields["messageId"] != message_id(&delivery.command)
        || fields["type"] != "message.dispatch"
        || fields["dispatchMode"]["type"] != "queue_after_active"
    {
        return Err(HostError::Binding);
    }
    Ok(payload)
}

fn notice_state(projection: &Value, command: &str) -> Result<NoticeState, HostError> {
    let message = message_id(command);
    let runs = projection["runs"].as_array().ok_or(HostError::Protocol)?;
    let messages = projection["messages"]
        .as_array()
        .ok_or(HostError::Protocol)?;
    let accepted = messages.iter().find(|item| item["id"] == message);
    let run = if let Some(id) = accepted.and_then(|item| item["runId"].as_str()) {
        let run = runs
            .iter()
            .find(|run| run["id"] == id)
            .ok_or(HostError::Uncertain)?;
        if run["userMessageId"] != message {
            return promoted_steer(projection, &message, id);
        }
        Some(run)
    } else {
        runs.iter().find(|run| run["userMessageId"] == message)
    };
    if let Some(run) = run {
        return match (run["status"].as_str(), run.get("startedAt")) {
            (_, Some(Value::String(started)))
                if OffsetDateTime::parse(started, &Rfc3339).is_ok() =>
            {
                Ok(NoticeState::Started)
            }
            (
                Some("failed" | "cancelled" | "completed" | "interrupted" | "rolled_back"),
                Some(Value::Null),
            ) => Ok(NoticeState::Undelivered),
            (Some("preparing" | "queued" | "starting" | "idle"), Some(Value::Null)) => {
                Ok(NoticeState::Queued)
            }
            _ => Err(HostError::Uncertain),
        };
    }
    Ok(if accepted.is_some() {
        NoticeState::Queued
    } else {
        NoticeState::Absent
    })
}

fn promoted_steer(
    projection: &Value,
    message: &str,
    run_id: &str,
) -> Result<NoticeState, HostError> {
    let items = projection["turnItems"]
        .as_array()
        .ok_or(HostError::Uncertain)?;
    let delivered = items.iter().any(|item| {
        item["type"] == "user_message"
            && item["messageId"] == message
            && item["runId"] == run_id
            && item["status"] == "completed"
    });
    Ok(if delivered {
        NoticeState::Started
    } else {
        NoticeState::Queued
    })
}
