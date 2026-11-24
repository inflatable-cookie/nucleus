use std::collections::BTreeSet;

use nucleus_core::acp::is_inbox_field;
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    HostError, T3, message_id,
    projection::missing_thread,
    rpc::{Read, Reply, ThreadReply},
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
    },
}

/// A direct UI message on a live or queued run of the exact pinned Inbox.
#[derive(Debug, PartialEq, Eq)]
pub struct InboxOperatorMessage {
    pub id: String,
    pub text: String,
}

pub enum InboxLifecycle {
    Complete,
    Write(InboxWrite),
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
}

impl InboxWrite {
    fn new(method: &'static str, id: String, mut payload: Value) -> Self {
        payload["commandId"] = json!(&id);
        Self {
            method,
            id,
            payload,
        }
    }

    #[must_use]
    pub fn command_id(&self) -> &str {
        &self.id
    }
}

impl T3 {
    /// Resolve the live, pinned Inbox and prepare at most one turn effect.
    /// # Errors
    /// Returns an error when the native destination or requests cannot be established.
    pub async fn prepare_inbox(
        &self,
        target: &InboxTarget<'_>,
        pending: &BTreeSet<String>,
    ) -> Result<InboxStep, HostError> {
        let Some(snapshot) = self
            .inbox_projection(target, ThreadRead::Observation)
            .await?
        else {
            return Ok(InboxStep::Wait);
        };
        let thread = inbox_thread(&snapshot);
        if !thread["archivedAt"].is_null() || !pinned(thread)? {
            return Ok(InboxStep::Wait);
        }
        reconcile(&snapshot, pending)
    }

    /// Observe the exact Rust Inbox without mutating either Inbox.
    /// # Errors
    /// Returns an error when the thread does not match the installed destination.
    pub async fn inbox_status(&self, target: &InboxTarget<'_>) -> Result<InboxStatus, HostError> {
        let Some(snapshot) = self.inbox_projection(target, ThreadRead::Exact).await? else {
            return Ok(InboxStatus::Missing);
        };
        let thread = inbox_thread(&snapshot);
        let pinned = pinned(thread)?;
        if !thread["archivedAt"].is_null() {
            Ok(InboxStatus::Archived)
        } else if pinned {
            Ok(InboxStatus::Pinned)
        } else {
            Ok(InboxStatus::Unpinned)
        }
    }

    /// Prepare one explicit install step for the Rust Inbox.
    /// # Errors
    /// Returns an error if the project, provider or native thread cannot be verified.
    pub async fn prepare_inbox_install(
        &self,
        target: &InboxTarget<'_>,
    ) -> Result<InboxLifecycle, HostError> {
        let Some(snapshot) = self.inbox_projection(target, ThreadRead::Exact).await? else {
            let shell = self.inbox_shell().await?;
            return self
                .prepare_inbox_launch(target, &shell)
                .await
                .map(InboxLifecycle::Write);
        };
        let thread = inbox_thread(&snapshot);
        let action = if !thread["archivedAt"].is_null() {
            "unarchive"
        } else if !pinned(thread)? {
            "pin"
        } else {
            return Ok(InboxLifecycle::Complete);
        };
        lifecycle_write(&snapshot, action)
    }

    /// Prepare one explicit removal step for the Rust Inbox alone.
    /// # Errors
    /// Returns an error if native ownership cannot be verified.
    pub async fn prepare_inbox_retire(
        &self,
        target: &InboxTarget<'_>,
    ) -> Result<InboxLifecycle, HostError> {
        let Some(snapshot) = self.inbox_projection(target, ThreadRead::Exact).await? else {
            return Ok(InboxLifecycle::Complete);
        };
        let thread = inbox_thread(&snapshot);
        let action = if pinned(thread)? {
            "unpin"
        } else if thread["archivedAt"].is_null() {
            "archive"
        } else {
            return Ok(InboxLifecycle::Complete);
        };
        lifecycle_write(&snapshot, action)
    }

    /// Read the favicon configured on the fixed Rust Inbox project.
    /// # Errors
    /// Returns an error if the native project cannot be verified.
    pub async fn inbox_favicon(
        &self,
        target: &InboxTarget<'_>,
    ) -> Result<Option<String>, HostError> {
        let shell = self.inbox_shell().await?;
        Ok(owned_inbox_project(&shell, target.root)?
            .and_then(|project| project["faviconPath"].as_str())
            .map(str::to_owned))
    }

    /// Prepare a favicon update on the fixed Rust Inbox project when it differs.
    /// # Errors
    /// Returns an error if the project or its observed revision cannot be verified.
    pub async fn prepare_inbox_favicon(
        &self,
        target: &InboxTarget<'_>,
        desired: Option<&str>,
    ) -> Result<Option<InboxWrite>, HostError> {
        let shell = self.inbox_shell().await?;
        let Some(project) = owned_inbox_project(&shell, target.root)? else {
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

    async fn inbox_projection(
        &self,
        target: &InboxTarget<'_>,
        policy: ThreadRead,
    ) -> Result<Option<Value>, HostError> {
        let Some(snapshot) = self.inbox_thread(policy).await? else {
            return Ok(None);
        };
        let thread = inbox_thread(&snapshot);
        if thread["id"] != INBOX_THREAD
            || thread["projectId"] != PROJECT
            || thread["providerInstanceId"] != target.provider
            || thread["modelSelection"]["instanceId"] != target.provider
            || thread["modelSelection"]["model"] != "nucleus"
            || !thread["deletedAt"].is_null()
            || !thread["parentThreadId"].is_null()
            || !thread["lineage"]["parentThreadId"].is_null()
        {
            return Err(HostError::Binding);
        }
        self.check_project(PROJECT, target.root).await?;
        Ok(Some(snapshot))
    }

    async fn inbox_thread(&self, policy: ThreadRead) -> Result<Option<Value>, HostError> {
        match self.rpc.thread(INBOX_THREAD, policy).await? {
            ThreadReply::Closed { row, .. } if !row["deletedAt"].is_null() => Ok(None),
            ThreadReply::Closed { row, sequence } => Ok(Some(json!({
                "snapshotSequence": sequence, "projection": {"thread":row}
            }))),
            ThreadReply::Snapshot(Reply::Value(value)) => Ok(Some(value)),
            ThreadReply::Snapshot(Reply::Failure(cause))
                if missing_thread(&cause, INBOX_THREAD) =>
            {
                Ok(None)
            }
            ThreadReply::Snapshot(Reply::Failure(_)) => Err(HostError::Protocol),
        }
    }

    async fn inbox_shell(&self) -> Result<Value, HostError> {
        self.rpc.shell(
            json!({"requestCompletionMarker":true,"omitIdleSubagents":true,"omitOlderSettled":true}),
        ).await
    }

    async fn prepare_inbox_launch(
        &self,
        target: &InboxTarget<'_>,
        shell: &Value,
    ) -> Result<InboxWrite, HostError> {
        if owned_inbox_project(shell, target.root)?.is_none() {
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
        match self
            .rpc
            .call(write.method, write.payload, Read::One)
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

fn inbox_thread(snapshot: &Value) -> &Value {
    &snapshot["projection"]["thread"]
}

fn lifecycle_write(snapshot: &Value, action: &str) -> Result<InboxLifecycle, HostError> {
    let sequence = snapshot["snapshotSequence"]
        .as_u64()
        .ok_or(HostError::Protocol)?;
    Ok(InboxLifecycle::Write(command(
        format!("nucleus-rust-inbox-{action}-{sequence}"),
        json!({"type":format!("thread.{action}"),"threadId":INBOX_THREAD}),
    )))
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

fn reconcile(snapshot: &Value, pending: &BTreeSet<String>) -> Result<InboxStep, HostError> {
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
                text: "ui".into(),
            }]
        );
    }
}
