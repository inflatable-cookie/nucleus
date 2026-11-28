use nucleus_core::QuestionDelivery;
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    DeliverySnooze, HostError, SnoozeUpdate, T3, clock_ms, dispatch_rejected,
    launch::message_id,
    rpc::{CallError, Read, Reply, ThreadFence, ThreadObservation, ThreadReply},
    task_row::same_except_snooze,
    thread_snapshots::ThreadRead,
};

/// Exact thread metadata for a local authority check. It carries no custody proof.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerIdentity {
    pub id: String,
    pub project_id: String,
    pub archived_at: Option<String>,
    pub deleted_at: Option<String>,
    pub provider_instance_id: Option<String>,
    parent_thread_id: Option<String>,
    lineage: Option<PlannerLineage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlannerLineage {
    parent_thread_id: Option<String>,
}

impl PlannerIdentity {
    #[must_use]
    pub fn top_level(id: String, project_id: String, provider_instance_id: Option<String>) -> Self {
        Self {
            id,
            project_id,
            archived_at: None,
            deleted_at: None,
            provider_instance_id,
            parent_thread_id: None,
            lineage: None,
        }
    }

    #[must_use]
    pub fn is_child(&self) -> bool {
        self.parent_thread_id.is_some()
            || self
                .lineage
                .as_ref()
                .is_some_and(|lineage| lineage.parent_thread_id.is_some())
    }

    pub(crate) fn same_role(&self, other: &Self) -> bool {
        self.id == other.id
            && self.project_id == other.project_id
            && self.archived_at == other.archived_at
            && self.deleted_at == other.deleted_at
            && self.provider_instance_id == other.provider_instance_id
            && self.is_child() == other.is_child()
    }
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
pub enum NoticeOutcome {
    Accepted,
    Rejected,
    /// The failure happened before any bytes were written to T3.
    NotSent(HostError),
}

pub struct NoticeObservation {
    pub state: NoticeState,
    pub authorization: Option<NoticeAuthorization>,
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
    planner: Box<PlannerIdentity>,
    command: String,
    payload: Box<RawValue>,
    previous: Option<u64>,
    fence: ThreadFence,
}

/// The caller must persist the corresponding send marker before dispatch.
pub struct NoticeDispatch {
    authorization: NoticeAuthorization,
}

impl NoticeAuthorization {
    #[must_use]
    pub const fn target(&self) -> &NoticeTarget {
        &self.target
    }

    #[must_use]
    pub fn matches_planner(&self, identity: &PlannerIdentity) -> bool {
        self.planner.same_role(identity)
    }

    /// Advance the notice marker before persisting and using the permit.
    /// # Errors
    /// Returns an error if the notice changed after authorization.
    pub fn record(self, delivery: &mut QuestionDelivery) -> Result<NoticeDispatch, HostError> {
        if delivery.thread != self.target.thread
            || delivery.command != self.command
            || delivery.payload != self.payload.get()
            || delivery.last_send_at_ms != self.previous
        {
            return Err(HostError::Binding);
        }
        delivery.last_send_at_ms = Some(clock_ms()?);
        Ok(NoticeDispatch {
            authorization: self,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoticeThread {
    #[serde(flatten)]
    planner: PlannerIdentity,
    worktree_path: Option<String>,
}

struct NoticeSnapshot {
    thread: NoticeThread,
    projection: Value,
    paged: bool,
    omits_turn_items: bool,
}

impl NoticeSnapshot {
    fn state(&self, delivery: &QuestionDelivery) -> Result<NoticeState, HostError> {
        let state = notice_state(&self.projection, &delivery.command, self.omits_turn_items)?;
        if self.paged && state == NoticeState::Absent && delivery.last_send_at_ms.is_some() {
            return Err(HostError::Uncertain);
        }
        Ok(state)
    }
}

impl T3 {
    /// Verify the precise delivery target, including threads not in the shell.
    /// # Errors
    /// Returns an error for an unreadable or different thread.
    pub async fn planner_routable(&self, thread: &str) -> Result<bool, HostError> {
        Ok(self
            .planner_identity(thread)
            .await?
            .is_some_and(|identity| !identity.is_child()))
    }

    /// Read only the thread identity from the synchronized shell snapshot without
    /// contacting the host.
    /// # Errors
    /// Returns an error for a malformed or mismatched shell row.
    pub fn cached_thread_identity(&self, id: &str) -> Result<Option<PlannerIdentity>, HostError> {
        let Some(row) = self.rpc.thread_row(id) else {
            return Ok(None);
        };
        Self::parse_active_identity(&row, id)
    }

    /// Read only the thread identity from a synchronized compact projection.
    /// # Errors
    /// Returns an error for an unreadable or mismatched identity.
    pub async fn planner_identity(&self, id: &str) -> Result<Option<PlannerIdentity>, HostError> {
        let row = if let Some(row) = self.rpc.thread_row(id) {
            (*row).clone()
        } else {
            match self.rpc.thread(id, ThreadRead::Observation).await? {
                ThreadReply::Snapshot(value) => value["projection"]["thread"].clone(),
                ThreadReply::Closed { .. } | ThreadReply::Missing => return Ok(None),
            }
        };
        Self::parse_active_identity(&row, id)
    }

    fn parse_active_identity(row: &Value, id: &str) -> Result<Option<PlannerIdentity>, HostError> {
        let thread: PlannerIdentity =
            serde_json::from_value(row.clone()).map_err(|_| HostError::Protocol)?;
        if thread.id != id {
            return Err(HostError::Binding);
        }
        Ok((thread.archived_at.is_none() && thread.deleted_at.is_none()).then_some(thread))
    }

    /// Recheck the actual thread and workspace of an authorized notice.
    /// # Errors
    /// Returns an error if the destination changed or could not be read.
    pub fn check_notice_target(
        &self,
        authorization: &NoticeAuthorization,
    ) -> Result<(), HostError> {
        let thread = &authorization.target.thread;
        let fence = &authorization.fence;
        self.rpc.with_shell(|shell| {
            let current = self.rpc.fence_at(thread, shell);
            if ((shell.is_some() || !self.rpc.uses_held_shell()) && fence.matches(&current))
                || fence
                    .row
                    .as_deref()
                    .zip(current.row.as_deref())
                    .is_some_and(|(before, after)| same_except_snooze(before, after))
            {
                Ok(())
            } else {
                Err(HostError::Binding)
            }
        })
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

    /// Freeze a top-level planner thread launch with its initial assessment prompt.
    /// # Errors
    /// Returns an error when the request cannot be encoded.
    pub fn prepare_planner_launch(
        thread: String,
        project_id: &str,
        title: &str,
        model_selection: &Value,
        command: String,
        text: &str,
    ) -> Result<QuestionDelivery, HostError> {
        let payload = serde_json::to_string(&json!({
            "commandId": command,
            "threadId": thread,
            "projectId": project_id,
            "title": title,
            "modelSelection": model_selection,
            "runtimeMode": "full-access",
            "interactionMode": "default",
            "workspaceStrategy": {"type": "root"},
            "initialMessage": {"messageId": message_id(&command), "text": text, "attachments": []},
        }))
        .map_err(|_| HostError::Protocol)?;
        Ok(QuestionDelivery {
            thread,
            command,
            payload,
            last_send_at_ms: Some(clock_ms()?),
        })
    }

    /// Launch a frozen top-level planner thread under its command ID.
    /// # Errors
    /// Returns an error on deferral, changed project evidence, or an uncertain reply.
    pub async fn launch_planner_thread(
        &self,
        delivery: &QuestionDelivery,
        project_id: &str,
        expected_root: &str,
    ) -> Result<NoticeOutcome, HostError> {
        let payload = frozen_payload(delivery)?;
        match self
            .rpc
            .call_write(
                "orchestration.launchThread",
                payload.as_ref(),
                Read::Background,
                || {
                    if self
                        .cached_project(project_id)
                        .is_ok_and(|project| project.root == expected_root)
                    {
                        Ok(true)
                    } else {
                        Err(HostError::Deferred {
                            until: tokio::time::Instant::now(),
                        })
                    }
                },
            )
            .await
        {
            Ok(Reply::Value(_)) => Ok(NoticeOutcome::Accepted),
            Ok(Reply::Failure(cause)) if dispatch_rejected(&cause, &delivery.command) => {
                Ok(NoticeOutcome::Rejected)
            }
            Ok(Reply::Failure(_)) => Err(HostError::Uncertain),
            Err(CallError::NotSent(error)) => Ok(NoticeOutcome::NotSent(error)),
            Err(CallError::Unknown(error)) => Err(error),
        }
    }

    /// Reconcile any preceding send and authorize a new dispatch when eligible.
    /// # Errors
    /// Returns an error when the request is unreadable.
    pub async fn authorize_notice(
        &self,
        delivery: &QuestionDelivery,
    ) -> Result<Option<NoticeAuthorization>, HostError> {
        Ok(self.observe_notice(delivery).await?.authorization)
    }

    /// Read the durable notice and any applicable write permit in one snapshot.
    /// # Errors
    /// Returns an error when the request or the native snapshot is unreadable.
    pub async fn observe_notice(
        &self,
        delivery: &QuestionDelivery,
    ) -> Result<NoticeObservation, HostError> {
        self.observe_notice_inner(delivery, false).await
    }

    /// Observe a task-watcher's target thread (top-level or child) without fallback.
    /// # Errors
    /// Returns an error when the request or the native snapshot is unreadable.
    pub async fn observe_watcher_notice(
        &self,
        delivery: &QuestionDelivery,
    ) -> Result<NoticeObservation, HostError> {
        self.observe_notice_inner(delivery, true).await
    }

    async fn observe_notice_inner(
        &self,
        delivery: &QuestionDelivery,
        allow_child: bool,
    ) -> Result<NoticeObservation, HostError> {
        let payload = frozen_payload(delivery)?;
        let id = &delivery.thread;
        let ThreadObservation { reply, fence } =
            self.rpc.observe_thread(id, ThreadRead::Observation).await?;
        let Some(snapshot) = Self::notice_projection(id, reply)? else {
            return Ok(NoticeObservation {
                state: NoticeState::Gone,
                authorization: None,
            });
        };
        if !allow_child && snapshot.thread.planner.is_child() {
            return Err(HostError::Binding);
        }
        let state = snapshot.state(delivery)?;
        if state != NoticeState::Absent || delivery.last_send_at_ms.is_some() {
            return Ok(NoticeObservation {
                state,
                authorization: None,
            });
        }
        if let Some(row) = &fence.row {
            let current =
                NoticeThread::deserialize(row.as_ref()).map_err(|_| HostError::Protocol)?;
            if !snapshot.thread.planner.same_role(&current.planner)
                || snapshot.thread.worktree_path != current.worktree_path
            {
                return Err(HostError::Binding);
            }
        }
        Ok(NoticeObservation {
            state,
            authorization: Some(NoticeAuthorization {
                target: NoticeTarget {
                    thread: snapshot.thread.planner.id.clone(),
                    project_id: snapshot.thread.planner.project_id.clone(),
                    worktree_path: snapshot.thread.worktree_path,
                },
                planner: Box::new(snapshot.thread.planner),
                command: delivery.command.clone(),
                payload,
                previous: delivery.last_send_at_ms,
                fence,
            }),
        })
    }

    /// Queue the recorded wire. T3 clears settlement in the message transaction.
    ///
    /// # Errors
    /// Returns an error on deferral, changed recipient evidence or an uncertain reply.
    pub async fn send_notice(
        &self,
        dispatch: NoticeDispatch,
        mut record_snooze: impl FnMut(SnoozeUpdate) -> Result<(), HostError> + Send,
    ) -> Result<NoticeOutcome, HostError> {
        let authorization = &dispatch.authorization;
        let reply = self
            .rpc
            .call_write(
                "orchestration.dispatchCommand",
                authorization.payload.as_ref(),
                Read::Background,
                || {
                    self.check_notice_target(authorization)
                        .map_err(|_| HostError::Deferred {
                            until: tokio::time::Instant::now(),
                        })?;
                    if let Some(update) = self.capture_snooze(
                        &authorization.target.thread,
                        &authorization.command,
                        &message_id(&authorization.command),
                    )? {
                        record_snooze(update)?;
                    }
                    Ok(true)
                },
            )
            .await;
        let refused = matches!(&reply, Ok(Reply::Failure(cause)) if dispatch_rejected(cause, &authorization.command));
        DeliverySnooze::after_send(
            Some(authorization.command.clone()),
            reply.as_ref().ok().and_then(DeliverySnooze::sequence),
            refused,
            record_snooze,
        );
        match reply {
            Ok(Reply::Value(_)) => Ok(NoticeOutcome::Accepted),
            Ok(Reply::Failure(_)) if refused => Ok(NoticeOutcome::Rejected),
            Ok(Reply::Failure(_)) => Err(HostError::Uncertain),
            Err(CallError::NotSent(error)) => Ok(NoticeOutcome::NotSent(error)),
            Err(CallError::Unknown(error)) => Err(error),
        }
    }

    fn notice_projection(
        id: &str,
        result: ThreadReply,
    ) -> Result<Option<NoticeSnapshot>, HostError> {
        let value = match result {
            ThreadReply::Snapshot(value) => value,
            ThreadReply::Closed { .. } | ThreadReply::Missing => return Ok(None),
        };
        let paged = value["hasMoreHistory"] == true;
        let omits_turn_items = value["turnItemsOmitLocalVisible"] == true;
        if value.get("idTable").is_some() || paged != value["historyCursor"].is_string() {
            return Err(HostError::Uncertain);
        }
        let Value::Object(mut snapshot) = value else {
            return Err(HostError::Protocol);
        };
        snapshot
            .get("snapshotSequence")
            .and_then(Value::as_u64)
            .ok_or(HostError::Protocol)?;
        let projection = snapshot.remove("projection").ok_or(HostError::Protocol)?;
        let thread: NoticeThread = serde_json::from_value(projection["thread"].clone())
            .map_err(|_| HostError::Protocol)?;
        if thread.planner.id != id {
            return Err(HostError::Binding);
        }
        if thread.planner.archived_at.is_some() || thread.planner.deleted_at.is_some() {
            return Ok(None);
        }
        Ok(Some(NoticeSnapshot {
            thread,
            projection,
            paged,
            omits_turn_items,
        }))
    }
}

fn frozen_payload(delivery: &QuestionDelivery) -> Result<Box<RawValue>, HostError> {
    let payload: Box<RawValue> =
        serde_json::from_str(&delivery.payload).map_err(|_| HostError::Binding)?;
    let fields: Value = serde_json::from_str(payload.get()).map_err(|_| HostError::Binding)?;
    let msg = message_id(&delivery.command);
    let is_dispatch = fields["type"] == "message.dispatch"
        && fields["messageId"] == msg
        && fields["dispatchMode"]["type"] == "queue_after_active";
    let is_launch = fields.get("type").is_none()
        && fields["workspaceStrategy"]["type"] == "root"
        && fields["initialMessage"]["messageId"] == msg;
    if fields["threadId"] != delivery.thread
        || fields["commandId"] != delivery.command
        || (!is_dispatch && !is_launch)
    {
        return Err(HostError::Binding);
    }
    Ok(payload)
}

fn notice_state(
    projection: &Value,
    command: &str,
    omits_turn_items: bool,
) -> Result<NoticeState, HostError> {
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
            return promoted_steer(projection, &message, id, omits_turn_items);
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
    omits_turn_items: bool,
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
    if delivered {
        Ok(NoticeState::Started)
    } else if omits_turn_items {
        Err(HostError::Uncertain)
    } else {
        Ok(NoticeState::Queued)
    }
}
