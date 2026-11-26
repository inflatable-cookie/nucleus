use std::path::Path;

use nucleus_core::{LaunchInputs, Run};
use serde::{Deserialize, Serialize};
use serde_json::{
    Value, json,
    value::{RawValue, to_raw_value},
};

use crate::{HostError, ParentRun, T3, parent_thread};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub project_id: String,
    pub worktree_path: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleProfile {
    pub instance_id: String,
    pub model: String,
    pub runtime_mode: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<ModelOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelOption {
    pub id: String,
    pub value: Value,
}

impl RoleProfile {
    fn selection(&self) -> Value {
        let mut selection = json!({"instanceId": self.instance_id, "model": self.model});
        if !self.options.is_empty() {
            selection["options"] = json!(self.options);
        }
        selection
    }
}

#[derive(Clone)]
pub enum Dispatch {
    Create {
        title: String,
        profile: RoleProfile,
    },
    Delegate {
        title: String,
        profile: RoleProfile,
        parent: ParentRun,
    },
    Continue {
        profile: Option<RoleProfile>,
    },
}

#[derive(Clone)]
pub struct RunRequest {
    pub binding: Binding,
    pub dispatch: Dispatch,
    pub parent: Option<String>,
    pub text: String,
}

impl RunRequest {
    /// Freeze the native method and exact payload before reserving a run.
    /// Use the instance from `Task::next_launch_instance` on that same task row.
    ///
    /// # Errors
    /// Returns an error if the run request cannot be encoded.
    pub fn inputs(
        &self,
        instance: &str,
        thread: String,
        started_at: u64,
    ) -> Result<LaunchInputs, HostError> {
        let message = message_id(instance);
        let selection = match &self.dispatch {
            Dispatch::Continue { profile } => profile.as_ref().map(RoleProfile::selection),
            _ => None,
        };
        let (method, payload) = match &self.dispatch {
            Dispatch::Create { title, profile } => (
                Method::Create,
                json!({
                    "commandId": instance, "threadId": thread, "projectId": self.binding.project_id, "title": title,
                    "modelSelection": profile.selection(),
                    "runtimeMode": profile.runtime_mode, "interactionMode": "default",
                    "workspaceStrategy": {
                        "type": "existing_worktree", "worktreePath": self.binding.worktree_path, "branch": self.binding.branch,
                    },
                    "initialMessage": {"messageId": message, "text": self.text, "attachments": []},
                }),
            ),
            Dispatch::Delegate {
                title,
                profile,
                parent,
            } => (
                Method::Delegate,
                json!({
                    "type":"delegated_task.request", "commandId":instance,
                    "createdBy":"user", "creationSource":"server",
                    "parentThreadId":parent.thread, "parentRunId":parent.run, "parentNodeId":parent.node,
                    "task":self.text,"title":title,
                    "modelSelection":profile.selection(),
                    "runtimeMode":profile.runtime_mode,"interactionMode":"default",
                    "completionWake":"settled_only"
                }),
            ),
            Dispatch::Continue { .. } => (
                Method::Continue,
                continuation_payload(instance, &thread, &self.text, selection.as_ref()),
            ),
        };
        let wire = Wire {
            binding: self.binding.clone(),
            pinned: false,
            parent: self.parent.clone(),
            method,
            selection,
            payload: to_raw_value(&payload).map_err(|_| HostError::Configuration)?,
        };
        let input = serde_json::to_string(&wire).map_err(|_| HostError::Configuration)?;
        Ok(LaunchInputs {
            thread,
            started_at,
            input,
            scratch: None,
        })
    }
}

impl T3 {
    /// Freeze a report reminder with the exact previous role's wire selection.
    ///
    /// # Errors
    /// Returns an error if the prior reservation's thread or route is invalid.
    pub fn prepare_report_reminder(
        run: &Run,
        binding: &Binding,
        instance: &str,
        started_at: u64,
        text: &str,
    ) -> Result<LaunchInputs, HostError> {
        let prior = Wire::read(run)?;
        if prior.binding != *binding {
            return Err(HostError::Binding);
        }
        let thread = run.launch().thread.clone();
        let selection = prior.model_selection()?.ok_or(HostError::Binding)?;
        let payload = continuation_payload(instance, &thread, text, Some(&selection));
        let wire = Wire {
            pinned: false,
            selection: Some(selection),
            binding: prior.binding,
            parent: prior.parent,
            method: Method::Continue,
            payload: to_raw_value(&payload).map_err(|_| HostError::Configuration)?,
        };
        Ok(LaunchInputs {
            thread,
            started_at,
            input: serde_json::to_string(&wire).map_err(|_| HostError::Configuration)?,
            scratch: None,
        })
    }
}

fn continuation_payload(
    instance: &str,
    thread: &str,
    text: &str,
    selection: Option<&Value>,
) -> Value {
    let mut payload = json!({
        "type": "message.dispatch", "commandId": instance, "threadId": thread,
        "messageId": message_id(instance), "text": text, "attachments": [],
        "createdBy": "user", "creationSource": "server", "dispatchMode": {"type": "queue_after_active"},
    });
    if let Some(selection) = selection {
        payload["modelSelection"] = selection.clone();
    }
    payload
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Method {
    Create,
    Delegate,
    Continue,
}

impl Method {
    pub(crate) const fn rpc(self) -> &'static str {
        match self {
            Self::Create => "orchestration.launchThread",
            Self::Delegate | Self::Continue => "orchestration.dispatchCommand",
        }
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Wire {
    pub(crate) binding: Binding,
    #[serde(skip)]
    pub(crate) pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) parent: Option<String>,
    pub(crate) method: Method,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) selection: Option<Value>,
    pub(crate) payload: Box<RawValue>,
}

impl Wire {
    pub(crate) fn assignment_too_large(&self) -> bool {
        let Ok(payload) = serde_json::from_str::<Value>(self.payload.get()) else {
            return false;
        };
        let text = match self.method {
            Method::Delegate => payload["task"].as_str(),
            Method::Create => payload["initialMessage"]["text"].as_str(),
            Method::Continue => payload["text"].as_str(),
        };
        text.is_some_and(|text| crate::assignment_units(text) > crate::T3_ASSIGNMENT_LIMIT)
    }

    pub(crate) fn delegated_parent_run(&self) -> Result<Option<String>, HostError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ParentRunId {
            parent_run_id: String,
        }
        if self.method != Method::Delegate {
            return Ok(None);
        }
        let parent: ParentRunId =
            serde_json::from_str(self.payload.get()).map_err(|_| HostError::Configuration)?;
        Ok(Some(parent.parent_run_id))
    }

    fn model_selection(&self) -> Result<Option<Value>, HostError> {
        if self.method == Method::Continue {
            return Ok(self.selection.clone());
        }
        let payload: Value =
            serde_json::from_str(self.payload.get()).map_err(|_| HostError::Configuration)?;
        Ok(payload.get("modelSelection").cloned())
    }

    pub(crate) fn diagnostic(&self) -> String {
        let selection = self.model_selection().ok().flatten().unwrap_or(Value::Null);
        let operation = match self.method {
            Method::Create => self.method.rpc(),
            Method::Delegate => "orchestration.dispatchCommand delegated_task.request",
            Method::Continue => "orchestration.dispatchCommand message.dispatch",
        };
        format!(
            "{operation} instance={:?} model={:?}",
            selection["instanceId"].as_str(),
            selection["model"].as_str()
        )
    }

    pub(crate) fn message_id(&self, instance: &str) -> String {
        if self.method == Method::Delegate {
            format!("message:delegated-task:{instance}")
        } else {
            message_id(instance)
        }
    }

    pub(crate) fn read(run: &Run) -> Result<Self, HostError> {
        let launch = run.launch();
        let mut wire: Self =
            serde_json::from_str(&launch.input).map_err(|_| HostError::Configuration)?;
        let payload: Value =
            serde_json::from_str(wire.payload.get()).map_err(|_| HostError::Configuration)?;
        if wire
            .parent
            .as_ref()
            .is_some_and(|parent| *parent != parent_thread(Path::new(&wire.binding.worktree_path)))
        {
            return Err(HostError::Binding);
        }
        let message = wire.message_id(&launch.instance);
        let matches = match wire.method {
            Method::Create => {
                let workspace = &payload["workspaceStrategy"];
                payload["threadId"] == launch.thread
                    && wire.parent.is_none()
                    && payload["projectId"] == wire.binding.project_id
                    && workspace["type"] == "existing_worktree"
                    && workspace["worktreePath"] == wire.binding.worktree_path
                    && workspace["branch"] == wire.binding.branch
                    && payload["initialMessage"]["messageId"] == message
            }
            Method::Delegate => {
                payload["type"] == "delegated_task.request"
                    && wire.parent.as_deref() == payload["parentThreadId"].as_str()
                    && wire.parent.is_some()
                    && payload.get("workspaceStrategy").is_none()
                    && payload["completionWake"] == "settled_only"
                    && launch.thread == delegated_child(&launch.instance)
            }
            Method::Continue => {
                if let Some(selection) = payload.get("modelSelection") {
                    let valid = wire.selection.as_ref() == Some(selection)
                        && selection["instanceId"]
                            .as_str()
                            .is_some_and(|id| !id.is_empty())
                        && selection["model"]
                            .as_str()
                            .is_some_and(|model| !model.is_empty());
                    if !valid {
                        return Err(HostError::Binding);
                    }
                    wire.pinned = true;
                }
                payload["type"] == "message.dispatch"
                    && payload["threadId"] == launch.thread
                    && payload["messageId"] == message
                    && payload["dispatchMode"]["type"] == "queue_after_active"
            }
        };
        let reminder_matches = run.report_reminder_for().is_none() || wire.pinned;
        if matches && reminder_matches && payload["commandId"] == launch.instance {
            Ok(wire)
        } else {
            Err(HostError::Binding)
        }
    }
}

/// Read the provider instance frozen in a T3 reservation.
///
/// # Errors
/// Returns an error if the reservation is not a valid T3 request.
pub fn launch_provider_instance(run: &Run) -> Result<Option<String>, HostError> {
    let wire = Wire::read(run)?;
    let selection = wire.model_selection()?;
    Ok(selection
        .as_ref()
        .and_then(|selection| selection["instanceId"].as_str())
        .filter(|instance| !instance.is_empty())
        .map(str::to_owned))
}

/// Name the frozen native operation and profile without including its payload.
#[must_use]
pub fn launch_diagnostic(run: &Run) -> String {
    Wire::read(run).map_or_else(
        |_| "invalid T3 launch binding".into(),
        |wire| wire.diagnostic(),
    )
}

const DELEGATED_THREAD_PREFIX: &str = "thread:delegated-task:";

/// The instance whose fresh launch owns this deterministic native child.
#[must_use]
pub fn child_origin_instance(thread: &str) -> Option<&str> {
    thread
        .strip_prefix(DELEGATED_THREAD_PREFIX)
        .filter(|instance| !instance.is_empty())
}

/// Whether a worker reservation predates the explicit T3 provider and model pin.
/// Whether a worker run continues a retained thread. Such a run reuses the
/// task parent's turn instead of holding it at launch.
#[must_use]
pub fn retained_worker_continuation(run: &Run) -> bool {
    run.launch().role == nucleus_core::Role::Worker
        && Wire::read(run).is_ok_and(|wire| wire.method == Method::Continue)
}

#[must_use]
pub fn unpinned_worker_continuation(run: &Run) -> bool {
    run.launch().role == nucleus_core::Role::Worker
        && Wire::read(run).is_ok_and(|wire| wire.method == Method::Continue && !wire.pinned)
}

pub(crate) fn delegated_child(instance: &str) -> String {
    format!("{DELEGATED_THREAD_PREFIX}{instance}")
}

pub(crate) fn message_id(instance: &str) -> String {
    format!("{instance}-message")
}
