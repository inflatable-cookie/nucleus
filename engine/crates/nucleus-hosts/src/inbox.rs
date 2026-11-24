use std::collections::BTreeSet;

use nucleus_core::acp::is_inbox_field;
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    HostError, T3, message_id,
    projection::missing_thread,
    rpc::{Read, Reply},
};

pub const INBOX_THREAD: &str = "thread:nucleus-rust-inbox";
const PROJECT: &str = "project:nucleus-rust-inbox";
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
    Ready(BTreeSet<String>),
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
        let Some(snapshot) = self.inbox_projection(target).await? else {
            return Ok(InboxStep::Wait);
        };
        let thread = inbox_thread(&snapshot);
        if !thread["archivedAt"].is_null() || !pinned(thread)? {
            return Ok(InboxStep::Wait);
        }
        match reconcile(&snapshot, pending) {
            Err(HostError::Protocol) if snapshot["hasMoreHistory"] == true => {
                let complete = self
                    .inbox_thread(INBOX_THREAD, false)
                    .await?
                    .ok_or(HostError::Uncertain)?;
                if complete["snapshotSequence"] != snapshot["snapshotSequence"]
                    || complete["hasMoreHistory"] == true
                {
                    return Err(HostError::Uncertain);
                }
                reconcile(&complete, pending)
            }
            result => result,
        }
    }

    /// Observe the exact Rust Inbox without mutating either Inbox.
    /// # Errors
    /// Returns an error when the thread does not match the installed destination.
    pub async fn inbox_status(&self, target: &InboxTarget<'_>) -> Result<InboxStatus, HostError> {
        let Some(snapshot) = self.inbox_projection(target).await? else {
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
        let Some(snapshot) = self.inbox_projection(target).await? else {
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
        let Some(snapshot) = self.inbox_projection(target).await? else {
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

    async fn inbox_projection(&self, target: &InboxTarget<'_>) -> Result<Option<Value>, HostError> {
        let Some(snapshot) = self.inbox_thread(INBOX_THREAD, true).await? else {
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

    async fn inbox_thread(&self, id: &str, bounded: bool) -> Result<Option<Value>, HostError> {
        match self
            .rpc
            .call(
                "orchestration.subscribeThread",
            json!({"threadId":id,"requestCompletionMarker":true,"acceptBoundedSnapshot":bounded}),
                Read::Thread,
            )
            .await?
        {
            Reply::Value(value) => Ok(Some(value)),
            Reply::Failure(cause) if missing_thread(&cause, id) => Ok(None),
            Reply::Failure(_) => Err(HostError::Protocol),
        }
    }

    async fn inbox_shell(&self) -> Result<Value, HostError> {
        let Reply::Value(snapshot) = self.rpc.call(
            "orchestration.subscribeShell",
            json!({"requestCompletionMarker":true,"omitIdleSubagents":true,"omitOlderSettled":true}),
            Read::Shell,
        ).await? else { return Err(HostError::Protocol) };
        Ok(snapshot)
    }

    async fn prepare_inbox_launch(
        &self,
        target: &InboxTarget<'_>,
        shell: &Value,
    ) -> Result<InboxWrite, HostError> {
        let projects = shell["snapshot"]["projects"]
            .as_array()
            .ok_or(HostError::Protocol)?;
        let mut found = projects.iter().filter(|project| project["id"] == PROJECT);
        match found.next() {
            None if !projects
                .iter()
                .any(|project| project["workspaceRoot"] == target.root) =>
            {
                return Ok(InboxWrite::new(
                    "projects.mutate",
                    "nucleus-rust-inbox-project".into(),
                    json!({"type":"project.create","projectId":PROJECT,"title":TITLE,"workspaceRoot":target.root}),
                ));
            }
            Some(project)
                if project["workspaceRoot"] == target.root
                    && found.next().is_none()
                    && project["archivedAt"].is_null()
                    && project["deletedAt"].is_null() => {}
            _ => return Err(HostError::Binding),
        }
        if !self.read_catalog().await?.supports_parent(target.provider) {
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
    if snapshot["turnItemsOmitLocalVisible"] == true || !snapshot["idTable"].is_null() {
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
    let live = |run: &Value| {
        matches!(
            run["status"].as_str(),
            Some("preparing" | "queued" | "starting" | "running" | "waiting")
        )
    };
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
                .any(|run| live(run) && run["id"] == item["runId"])
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
    if !pending.is_empty() && !runs.iter().any(live) {
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
    Ok(InboxStep::Ready(present))
}
