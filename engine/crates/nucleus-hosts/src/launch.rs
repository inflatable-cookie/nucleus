use std::path::Path;

use nucleus_core::{LaunchInputs, Run};
use serde::{Deserialize, Serialize};
use serde_json::{
    Value, json,
    value::{RawValue, to_raw_value},
};

use crate::{HostError, ParentRun, parent_thread};

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
                json!({
                    "type": "message.dispatch", "commandId": instance, "threadId": thread,
                    "messageId": message, "text": self.text, "attachments": [],
                    "createdBy": "user", "creationSource": "server", "dispatchMode": {"type": "queue_after_active"},
                }),
            ),
        };
        let wire = Wire {
            binding: self.binding.clone(),
            parent: self.parent.clone(),
            method,
            selection: match &self.dispatch {
                Dispatch::Continue { profile } => profile.as_ref().map(RoleProfile::selection),
                _ => None,
            },
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) parent: Option<String>,
    pub(crate) method: Method,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) selection: Option<Value>,
    pub(crate) payload: Box<RawValue>,
}

impl Wire {
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
        let wire: Self =
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
                payload["type"] == "message.dispatch"
                    && payload["threadId"] == launch.thread
                    && payload["messageId"] == message
                    && payload["dispatchMode"]["type"] == "queue_after_active"
            }
        };
        if matches && payload["commandId"] == launch.instance {
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

pub(crate) fn delegated_child(instance: &str) -> String {
    format!("thread:delegated-task:{instance}")
}

pub(crate) fn message_id(instance: &str) -> String {
    format!("{instance}-message")
}
