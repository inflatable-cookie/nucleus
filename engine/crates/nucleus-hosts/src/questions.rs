use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_core::QuestionDelivery;
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};

use crate::{
    HostError, LATE_REPLY_MS, T3,
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
    pub archived_at: Option<String>,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeState {
    Gone,
    Absent,
    Queued,
    Started,
}

pub struct NoticeAuthorization {
    thread: String,
    command: String,
    previous: Option<u64>,
    now_ms: u64,
}

impl NoticeAuthorization {
    /// Advance the notice marker before persisting and using the permit.
    /// # Errors
    /// Returns an error if the notice changed after authorization.
    pub fn record(&self, delivery: &mut QuestionDelivery) -> Result<(), HostError> {
        if delivery.thread != self.thread
            || delivery.command != self.command
            || delivery.last_send_at_ms != self.previous
        {
            return Err(HostError::Binding);
        }
        delivery.last_send_at_ms = Some(self.now_ms);
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoticeThread {
    id: String,
    archived_at: Option<String>,
    deleted_at: Option<String>,
    settled_at: Option<String>,
    settled_override: Option<String>,
    snoozed_until: Option<String>,
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
                Read::Snapshot,
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
        let Some((_, projection)) = self.notice_projection(&delivery.thread).await? else {
            return Ok(NoticeState::Gone);
        };
        notice_state(&projection, &delivery.command)
    }

    /// Permit a new send only after the preceding late reply can be reconciled.
    /// # Errors
    /// Returns an error when the request is unreadable.
    pub async fn authorize_notice(
        &self,
        delivery: &QuestionDelivery,
    ) -> Result<Option<NoticeAuthorization>, HostError> {
        let clock = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| HostError::Uncertain)?;
        let now_ms = u64::try_from(clock.as_millis()).map_err(|_| HostError::Uncertain)?;
        if delivery
            .last_send_at_ms
            .is_some_and(|sent| now_ms.saturating_sub(sent) < LATE_REPLY_MS)
        {
            return Ok(None);
        }
        let Some((thread, projection)) = self.notice_projection(&delivery.thread).await? else {
            return Ok(None);
        };
        let state = notice_state(&projection, &delivery.command)?;
        let due = thread.snoozed_until.is_none()
            && (state == NoticeState::Absent || state == NoticeState::Queued && settled(&thread));
        Ok(due.then(|| NoticeAuthorization {
            thread: delivery.thread.clone(),
            command: delivery.command.clone(),
            previous: delivery.last_send_at_ms,
            now_ms,
        }))
    }

    /// Unsettle the exact planner thread, then queue its durable message.
    /// # Errors
    /// Returns an error if the target is unreadable or the outcome is uncertain.
    pub async fn send_notice(
        &self,
        delivery: &QuestionDelivery,
        authorization: NoticeAuthorization,
    ) -> Result<(), HostError> {
        if delivery.thread != authorization.thread
            || delivery.command != authorization.command
            || delivery.last_send_at_ms != Some(authorization.now_ms)
        {
            return Err(HostError::Binding);
        }
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
        let Some((mut thread, mut projection)) = self.notice_projection(&delivery.thread).await?
        else {
            return Err(HostError::Uncertain);
        };
        if thread.snoozed_until.is_some() {
            return Err(HostError::Uncertain);
        }
        if settled(&thread) {
            self.thread_command(json!({
                "type":"thread.unsettle", "threadId":delivery.thread,
                "commandId":format!("{}-unsettle", delivery.command), "reason":"user",
            }))
            .await?;
            let Some(fresh) = self.notice_projection(&delivery.thread).await? else {
                return Err(HostError::Uncertain);
            };
            (thread, projection) = fresh;
            if settled(&thread) || thread.snoozed_until.is_some() {
                return Err(HostError::Uncertain);
            }
        }
        if notice_state(&projection, &delivery.command)? != NoticeState::Absent {
            return Ok(());
        }
        match self
            .rpc
            .call("orchestration.dispatchCommand", payload.as_ref(), Read::One)
            .await?
        {
            Reply::Value(_) => Ok(()),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }

    async fn notice_projection(
        &self,
        id: &str,
    ) -> Result<Option<(NoticeThread, Value)>, HostError> {
        let result = self
            .rpc
            .call(
                "orchestration.subscribeThread",
                json!({
                    "threadId":id, "requestCompletionMarker":true, "acceptBoundedSnapshot":false,
                }),
                Read::Snapshot,
            )
            .await?;
        let value = match result {
            Reply::Value(value) => value,
            Reply::Failure(cause) if projection::missing_thread(&cause, id) => return Ok(None),
            Reply::Failure(_) => return Err(HostError::Uncertain),
        };
        if value["hasMoreHistory"] == true || value.get("idTable").is_some() {
            return Err(HostError::Uncertain);
        }
        let Value::Object(mut snapshot) = value else {
            return Err(HostError::Protocol);
        };
        let projection = snapshot.remove("projection").ok_or(HostError::Protocol)?;
        let thread: NoticeThread = serde_json::from_value(projection["thread"].clone())
            .map_err(|_| HostError::Protocol)?;
        if thread.id != id {
            return Err(HostError::Binding);
        }
        if thread.archived_at.is_some() || thread.deleted_at.is_some() {
            return Ok(None);
        }
        Ok(Some((thread, projection)))
    }
}

fn settled(thread: &NoticeThread) -> bool {
    thread.settled_at.is_some() || thread.settled_override.as_deref() == Some("settled")
}

fn notice_state(projection: &Value, command: &str) -> Result<NoticeState, HostError> {
    let message = message_id(command);
    let runs = projection["runs"].as_array().ok_or(HostError::Protocol)?;
    let messages = projection["messages"]
        .as_array()
        .ok_or(HostError::Protocol)?;
    let accepted = messages.iter().find(|item| item["id"] == message);
    let associated = accepted.and_then(|item| item["runId"].as_str());
    if let Some(run) = runs
        .iter()
        .find(|run| run["userMessageId"] == message || associated.is_some_and(|id| run["id"] == id))
    {
        return match run["status"].as_str() {
            Some("running" | "waiting" | "completed" | "interrupted") => Ok(NoticeState::Started),
            Some("failed" | "cancelled") if run["startedAt"].is_string() => {
                Ok(NoticeState::Started)
            }
            Some(
                "failed" | "cancelled" | "preparing" | "queued" | "starting" | "idle"
                | "rolled_back",
            ) => Ok(NoticeState::Queued),
            _ => Err(HostError::Uncertain),
        };
    }
    Ok(if accepted.is_some() {
        NoticeState::Queued
    } else {
        NoticeState::Absent
    })
}
