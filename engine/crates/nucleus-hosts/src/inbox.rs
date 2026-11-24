use std::collections::BTreeSet;

use nucleus_core::acp::is_inbox_field;
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    HostError, T3, message_id,
    rpc::{Read, Reply, ThreadFence, ThreadObservation, ThreadReply},
    thread_snapshots::ThreadRead,
};

mod preview;

pub use preview::InboxPreviewError;

pub const INBOX_THREAD: &str = "thread:nucleus-rust-inbox";
pub(crate) const PROJECT: &str = "project:nucleus-rust-inbox";
const TITLE: &str = "Nucleus Inbox";
const PROMPT: &str = "Open the Nucleus Inbox.";

pub struct InboxTarget<'a> {
    pub root: &'a str,
    pub provider: &'a str,
}

pub enum InboxStep {
    /// The Rust Inbox has no verified pin.
    Wait,
    /// One idempotent native mutation. The next observation confirms its effect.
    Write(InboxWrite),
    /// The Inbox is pinned and idle, with no live cards.
    Wake(InboxWrite),
    /// Pending forms already visible on the current native turn.
    Ready {
        forms: BTreeSet<String>,
        commands: Vec<InboxOperatorMessage>,
        active_run: Option<String>,
    },
}

/// A direct UI message on a live or queued run of the exact pinned Inbox.
#[derive(Debug, PartialEq, Eq)]
pub struct InboxOperatorMessage {
    pub id: String,
    pub run_id: String,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxStatus {
    Missing,
    Unpinned,
    Pinned,
    Archived,
}

pub struct InboxWrite {
    method: &'static str,
    id: String,
    payload: Value,
    fence: Option<(ThreadFence, String)>,
}

impl InboxWrite {
    fn new(method: &'static str, id: String, mut payload: Value) -> Self {
        payload["commandId"] = json!(&id);
        Self {
            method,
            id,
            payload,
            fence: None,
        }
    }

    #[must_use]
    pub fn command_id(&self) -> &str {
        &self.id
    }
}

impl T3 {
    /// Confirm the Inbox run identity against the synchronized shell without a host read.
    #[must_use]
    pub fn inbox_run_is_active(&self, run_id: &str) -> bool {
        self.rpc.thread_row(INBOX_THREAD).is_some_and(|row| {
            row["activeRunId"] == run_id
                && row["pinnedAt"].is_string()
                && row["archivedAt"].is_null()
                && row["deletedAt"].is_null()
        })
    }

    /// Resolve the live, pinned Inbox and prepare at most one turn effect.
    /// # Errors
    /// Returns an error when the native destination or requests cannot be established.
    pub async fn prepare_inbox(
        &self,
        target: &InboxTarget<'_>,
        pending: &BTreeSet<String>,
    ) -> Result<InboxStep, HostError> {
        if self.rpc.uses_held_shell() && self.rpc.thread_row(INBOX_THREAD).is_none() {
            return Ok(InboxStep::Wait);
        }
        let ThreadObservation { reply, fence } = self
            .rpc
            .observe_thread(INBOX_THREAD, ThreadRead::Inbox)
            .await?;
        let ThreadReply::Snapshot(snapshot) = reply else {
            return Ok(InboxStep::Wait);
        };
        let thread = inbox_thread(&snapshot);
        Self::verify_inbox_thread(target, thread)?;
        if !thread["archivedAt"].is_null() || !pinned(thread)? {
            return Ok(InboxStep::Wait);
        }
        self.check_project(PROJECT, target.root).await?;
        let active_run = fence
            .row
            .as_ref()
            .and_then(|row| row["activeRunId"].as_str());
        let mut step = reconcile(&snapshot, pending, active_run)?;
        if let InboxStep::Wake(write) | InboxStep::Write(write) = &mut step {
            write.fence = Some((fence, target.root.into()));
        }
        Ok(step)
    }

    /// Observe the exact Rust Inbox without mutating either Inbox.
    /// # Errors
    /// Returns an error when the thread does not match the installed destination.
    pub async fn inbox_status(&self, target: &InboxTarget<'_>) -> Result<InboxStatus, HostError> {
        Ok(self.inbox_status_with_favicon(target).await?.0)
    }

    /// Observe Inbox status and favicon from one synchronized project inventory.
    /// # Errors
    /// Returns an error if the Inbox does not belong to the expected project.
    pub async fn inbox_status_with_favicon(
        &self,
        target: &InboxTarget<'_>,
    ) -> Result<(InboxStatus, Option<String>), HostError> {
        let shell = self.inbox_shell().await?;
        let project = owned_inbox_project(&shell, target.root)?;
        let Some((thread, _)) = self.inbox_setup_thread(&shell).await? else {
            return Ok((InboxStatus::Missing, favicon(project)));
        };
        Self::verify_inbox_thread(target, &thread)?;
        if project.is_none() {
            return Err(HostError::Binding);
        }
        Ok((read_status(&thread)?, favicon(project)))
    }

    /// Read the favicon configured on the fixed Rust Inbox project.
    /// # Errors
    /// Returns an error if the native project cannot be verified.
    #[cfg(test)]
    pub(crate) async fn inbox_favicon(
        &self,
        target: &InboxTarget<'_>,
    ) -> Result<Option<String>, HostError> {
        let shell = self.inbox_shell().await?;
        Ok(favicon(owned_inbox_project(&shell, target.root)?))
    }

    /// Prepare a favicon update on the fixed Rust Inbox project when it differs.
    /// # Errors
    /// Returns an error if the project or its observed revision cannot be verified.
    #[cfg(test)]
    pub(crate) async fn prepare_inbox_favicon(
        &self,
        target: &InboxTarget<'_>,
        desired: Option<&str>,
    ) -> Result<Option<InboxWrite>, HostError> {
        let shell = self.inbox_shell().await?;
        favicon_write(owned_inbox_project(&shell, target.root)?, desired)
    }

    /// Prepare a setup mutation using one project inventory per observation.
    ///
    /// # Errors
    /// Returns an error when the project, thread or provider cannot be verified.
    pub async fn prepare_inbox_setup(
        &self,
        target: &InboxTarget<'_>,
        desired: Option<&str>,
    ) -> Result<Option<InboxWrite>, HostError> {
        let shell = self.inbox_shell().await?;
        let project = owned_inbox_project(&shell, target.root)?;
        let Some((thread, sequence)) = self.inbox_setup_thread(&shell).await? else {
            return if desired.is_some() {
                self.prepare_inbox_launch(target, project).await.map(Some)
            } else {
                favicon_write(project, desired)
            };
        };
        Self::verify_inbox_thread(target, &thread)?;
        if project.is_none() {
            return Err(HostError::Binding);
        }
        let archived = !thread["archivedAt"].is_null();
        let pinned = pinned(&thread)?;
        let action = match (desired.is_some(), archived, pinned) {
            (true, true, _) => "unarchive",
            (true, false, false) => "pin",
            (false, _, true) => "unpin",
            (false, false, false) => "archive",
            _ => return favicon_write(project, desired),
        };
        let sequence = sequence.ok_or(HostError::Protocol)?;
        Ok(Some(command(
            format!("nucleus-rust-inbox-{action}-{sequence}"),
            json!({"type":format!("thread.{action}"),"threadId":INBOX_THREAD}),
        )))
    }

    fn verify_inbox_thread(target: &InboxTarget<'_>, thread: &Value) -> Result<(), HostError> {
        if thread["id"] != INBOX_THREAD
            || thread["projectId"] != PROJECT
            || thread["providerInstanceId"] != target.provider
            || thread["modelSelection"]["instanceId"] != target.provider
            || thread["modelSelection"]["model"] != "nucleus"
            || !thread["deletedAt"].is_null()
            || !thread["worktreePath"].is_null()
            || !thread["parentThreadId"].is_null()
            || !thread["lineage"]["parentThreadId"].is_null()
        {
            return Err(HostError::Binding);
        }
        Ok(())
    }

    async fn inbox_setup_thread(
        &self,
        shell: &Value,
    ) -> Result<Option<(Value, Option<u64>)>, HostError> {
        let inventory = &shell["snapshot"];
        let mut rows = ["threads", "archivedThreads"]
            .into_iter()
            .flat_map(|key| inventory[key].as_array().into_iter().flatten())
            .filter(|row| row["id"] == INBOX_THREAD);
        if let Some(row) = rows.next() {
            if rows.next().is_some() {
                return Err(HostError::Protocol);
            }
            let sequence = inventory["snapshotSequence"]
                .as_u64()
                .or_else(|| shell["snapshotSequence"].as_u64());
            return Ok(row["deletedAt"].is_null().then(|| (row.clone(), sequence)));
        }
        Ok(
            match self.rpc.thread(INBOX_THREAD, ThreadRead::Exact).await? {
                ThreadReply::Snapshot(snapshot) => Some((
                    inbox_thread(&snapshot).clone(),
                    snapshot["snapshotSequence"].as_u64(),
                )),
                ThreadReply::Closed { row, sequence } if row["deletedAt"].is_null() => {
                    Some((row, sequence))
                }
                _ => None,
            },
        )
    }

    async fn inbox_shell(&self) -> Result<Value, HostError> {
        self.rpc.shell(
            json!({"requestCompletionMarker":true,"omitIdleSubagents":true,"omitOlderSettled":true}),
        ).await
    }

    async fn prepare_inbox_launch(
        &self,
        target: &InboxTarget<'_>,
        project: Option<&Value>,
    ) -> Result<InboxWrite, HostError> {
        if project.is_none() {
            return Ok(InboxWrite::new(
                "projects.mutate",
                "nucleus-rust-inbox-project".into(),
                json!({"type":"project.create","projectId":PROJECT,"title":TITLE,"workspaceRoot":target.root}),
            ));
        }
        if !self
            .rpc
            .profile_catalog()
            .await?
            .supports_parent(target.provider)
        {
            return Err(HostError::Configuration);
        }
        let key = "nucleus-rust-inbox-launch";
        Ok(InboxWrite::new(
            "orchestration.launchThread",
            key.into(),
            json!({
                "threadId":INBOX_THREAD,"projectId":PROJECT,"title":TITLE,
                "modelSelection":selection(target.provider),"runtimeMode":"full-access",
                "interactionMode":"default","workspaceStrategy":{"type":"root"},
                "initialMessage":{"messageId":message_id(key),"text":PROMPT,"attachments":[]}
            }),
        ))
    }

    /// Execute the next write from a freshly reconciled Inbox observation.
    /// # Errors
    /// Returns an error if the host did not acknowledge the command.
    pub async fn write_inbox(&self, write: InboxWrite) -> Result<(), HostError> {
        let class = if write.fence.is_some() {
            Read::Background
        } else {
            Read::One
        };
        match self
            .rpc
            .call_guarded(write.method, write.payload, class, || {
                let Some((fence, root)) = &write.fence else {
                    return Ok(true);
                };
                if !self.rpc.with_shell(|shell| {
                    self.rpc.fence_at(INBOX_THREAD, shell).matches(fence)
                        && (!self.rpc.uses_held_shell()
                            || shell
                                .and_then(|shell| shell.project(PROJECT))
                                .is_some_and(|project| project.root == *root))
                }) {
                    return Err(HostError::Binding);
                }
                Ok(self.rpc.claim_effect(&write.id))
            })
            .await?
        {
            Reply::Value(_) => Ok(()),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }
}

fn owned_inbox_project<'a>(shell: &'a Value, root: &str) -> Result<Option<&'a Value>, HostError> {
    let projects = shell["snapshot"]["projects"]
        .as_array()
        .ok_or(HostError::Protocol)?;
    let mut found = projects.iter().filter(|project| project["id"] == PROJECT);
    match found.next() {
        Some(project)
            if project["workspaceRoot"] == root
                && found.next().is_none()
                && project["archivedAt"].is_null()
                && project["deletedAt"].is_null() =>
        {
            Ok(Some(project))
        }
        None if !projects
            .iter()
            .any(|project| project["workspaceRoot"] == root) =>
        {
            Ok(None)
        }
        _ => Err(HostError::Binding),
    }
}

fn favicon(project: Option<&Value>) -> Option<String> {
    project
        .and_then(|project| project["faviconPath"].as_str())
        .map(str::to_owned)
}

fn favicon_write(
    project: Option<&Value>,
    desired: Option<&str>,
) -> Result<Option<InboxWrite>, HostError> {
    let Some(project) = project else {
        return if desired.is_none() {
            Ok(None)
        } else {
            Err(HostError::Binding)
        };
    };
    if project["faviconPath"].as_str() == desired {
        return Ok(None);
    }
    let revision = project["updatedAt"].as_str().ok_or(HostError::Protocol)?;
    let action = if desired.is_some() { "set" } else { "clear" };
    Ok(Some(InboxWrite::new(
        "projects.mutate",
        format!("nucleus-rust-inbox-favicon-{action}-{revision}"),
        json!({"type":"project.update","projectId":PROJECT,"faviconPath":desired}),
    )))
}

fn read_status(thread: &Value) -> Result<InboxStatus, HostError> {
    let is_pinned = pinned(thread)?;
    Ok(if !thread["archivedAt"].is_null() {
        InboxStatus::Archived
    } else if is_pinned {
        InboxStatus::Pinned
    } else {
        InboxStatus::Unpinned
    })
}

fn inbox_thread(snapshot: &Value) -> &Value {
    &snapshot["projection"]["thread"]
}

fn selection(provider: &str) -> Value {
    json!({"instanceId":provider,"model":"nucleus"})
}

fn pinned(thread: &Value) -> Result<bool, HostError> {
    match thread.get("pinnedAt") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::String(at)) if !at.is_empty() => Ok(true),
        _ => Err(HostError::Protocol),
    }
}

fn command(id: String, payload: Value) -> InboxWrite {
    InboxWrite::new("orchestration.dispatchCommand", id, payload)
}

fn reconcile(
    snapshot: &Value,
    pending: &BTreeSet<String>,
    active_run: Option<&str>,
) -> Result<InboxStep, HostError> {
    if !snapshot["idTable"].is_null() {
        return Err(HostError::Protocol);
    }
    let projection = &snapshot["projection"];
    let runs = projection["runs"].as_array().ok_or(HostError::Protocol)?;
    let requests = projection["runtimeRequests"]
        .as_array()
        .ok_or(HostError::Protocol)?;
    let items = projection["turnItems"]
        .as_array()
        .ok_or(HostError::Protocol)?;
    let mut present = BTreeSet::new();
    for request in requests
        .iter()
        .filter(|request| request["status"] == "pending")
    {
        if request["kind"] != "user_input" {
            return Err(HostError::Protocol);
        }
        let id = request["id"].as_str().ok_or(HostError::Protocol)?;
        let item = items
            .iter()
            .find(|item| item["type"] == "user_input_request" && item["requestId"] == id)
            .ok_or(HostError::Protocol)?;
        let Some(field) = item["questions"]
            .as_array()
            .filter(|questions| questions.len() == 1)
            .and_then(|questions| questions[0]["id"].as_str())
            .filter(|field| is_inbox_field(field))
        else {
            return Err(HostError::Protocol);
        };
        if request["responseCapability"]["type"] == "live"
            && runs
                .iter()
                .any(|run| live_run(run) && run["id"] == item["runId"])
            && pending.contains(field)
            && present.insert(field.to_owned())
        {
            continue;
        }
        return Ok(InboxStep::Write(command(
            format!("nucleus-rust-inbox-settle-{id}"),
            json!({
                "type":"runtime-request.respond","threadId":INBOX_THREAD,
                "requestId":id,"decision":"cancel"
            }),
        )));
    }
    if !pending.is_empty() && !runs.iter().any(live_run) {
        let sequence = snapshot["snapshotSequence"]
            .as_u64()
            .ok_or(HostError::Protocol)?;
        let key = format!("nucleus-rust-inbox-wake-{sequence}");
        let message = message_id(&key);
        return Ok(InboxStep::Wake(command(
            key,
            json!({
                "type":"message.dispatch","threadId":INBOX_THREAD,
                "messageId":message,"text":PROMPT,"attachments":[],
                "createdBy":"user","creationSource":"server","dispatchMode":{"type":"queue_after_active"}
            }),
        )));
    }
    Ok(InboxStep::Ready {
        forms: present,
        commands: operator_messages(&projection["messages"], runs),
        active_run: active_run
            .filter(|id| {
                runs.iter().any(|run| {
                    run["id"].as_str() == Some(*id) && live_run(run) && run["status"] != "queued"
                })
            })
            .map(str::to_owned),
    })
}

fn live_run(run: &Value) -> bool {
    matches!(
        run["status"].as_str(),
        Some("preparing" | "queued" | "starting" | "running" | "waiting")
    )
}

fn operator_messages(messages: &Value, runs: &[Value]) -> Vec<InboxOperatorMessage> {
    messages
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| {
            message["threadId"] == INBOX_THREAD
                && message["role"] == "user"
                && message["createdBy"] == "user"
                && message["creationSource"] == "web"
                && message["senderThreadId"].is_null()
                && message["linkedSender"].is_null()
                && message["runId"].is_string()
                && runs
                    .iter()
                    .any(|run| live_run(run) && run["id"] == message["runId"])
        })
        .filter_map(|message| {
            Some(InboxOperatorMessage {
                id: message["id"].as_str()?.to_owned(),
                run_id: message["runId"].as_str()?.to_owned(),
                text: message["text"].as_str()?.to_owned(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_direct_live_operator_messages_can_reach_the_inbox_parser() {
        let runs = [
            json!({"id": "queued", "status": "queued"}),
            json!({"id": "complete", "status": "completed"}),
        ];
        let original = json!({
            "threadId": INBOX_THREAD,
            "id": "operator-message",
            "runId": "queued",
            "role": "user",
            "createdBy": "user",
            "creationSource": "web",
            "text": "ui",
        });
        let mut records = vec![original.clone()];
        for (field, value) in [
            ("createdBy", json!("agent")),
            ("creationSource", json!("mcp")),
            ("senderThreadId", json!("agent")),
            ("linkedSender", json!({"threadId": "relayed"})),
            ("runId", json!("complete")),
            ("threadId", json!("a-different-thread")),
        ] {
            let mut message = original.clone();
            message["id"] = json!(field);
            message[field] = value;
            records.push(message);
        }
        let commands = operator_messages(&json!(records), &runs);
        assert_eq!(
            commands,
            [InboxOperatorMessage {
                id: "operator-message".into(),
                run_id: "queued".into(),
                text: "ui".into(),
            }]
        );
    }
}
