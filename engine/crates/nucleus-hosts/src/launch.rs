use nucleus_core::{LaunchInputs, Run};
use serde::{Deserialize, Serialize};
use serde_json::{
    Value, json,
    value::{RawValue, to_raw_value},
};

use crate::HostError;

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
}

#[derive(Clone)]
pub enum Dispatch {
    Create { title: String, profile: RoleProfile },
    Continue,
}

#[derive(Clone)]
pub struct RunRequest {
    pub binding: Binding,
    pub dispatch: Dispatch,
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
                    "modelSelection": {"instanceId": profile.instance_id, "model": profile.model},
                    "runtimeMode": profile.runtime_mode, "interactionMode": "default",
                    "workspaceStrategy": {
                        "type": "existing_worktree", "worktreePath": self.binding.worktree_path, "branch": self.binding.branch,
                    },
                    "initialMessage": {"messageId": message, "text": self.text, "attachments": []},
                }),
            ),
            Dispatch::Continue => (
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
            method,
            payload: to_raw_value(&payload).map_err(|_| HostError::Configuration)?,
        };
        let input = serde_json::to_string(&wire).map_err(|_| HostError::Configuration)?;
        Ok(LaunchInputs {
            thread,
            started_at,
            input,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Method {
    Create,
    Continue,
}

impl Method {
    pub(crate) const fn rpc(self) -> &'static str {
        match self {
            Self::Create => "orchestration.launchThread",
            Self::Continue => "orchestration.dispatchCommand",
        }
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Wire {
    pub(crate) binding: Binding,
    pub(crate) method: Method,
    pub(crate) payload: Box<RawValue>,
}

impl Wire {
    pub(crate) fn read(run: &Run) -> Result<Self, HostError> {
        let launch = run.launch();
        let wire: Self =
            serde_json::from_str(&launch.input).map_err(|_| HostError::Configuration)?;
        let payload: Value =
            serde_json::from_str(wire.payload.get()).map_err(|_| HostError::Configuration)?;
        let message = message_id(&launch.instance);
        let matches = match wire.method {
            Method::Create => {
                let workspace = &payload["workspaceStrategy"];
                payload["projectId"] == wire.binding.project_id
                    && workspace["type"] == "existing_worktree"
                    && workspace["worktreePath"] == wire.binding.worktree_path
                    && workspace["branch"] == wire.binding.branch
                    && payload["initialMessage"]["messageId"] == message
            }
            Method::Continue => {
                payload["type"] == "message.dispatch"
                    && payload["messageId"] == message
                    && payload["dispatchMode"]["type"] == "queue_after_active"
            }
        };
        if matches
            && payload["commandId"] == launch.instance
            && payload["threadId"] == launch.thread
        {
            Ok(wire)
        } else {
            Err(HostError::Binding)
        }
    }
}

pub(crate) fn message_id(instance: &str) -> String {
    format!("{instance}-message")
}
