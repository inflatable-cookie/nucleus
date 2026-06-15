//! Server event envelope types.

use nucleus_agent_protocol::RuntimeEventIdentity;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;
use nucleus_workspaces::WorkspaceLayoutId;

use crate::ids::{ClientId, ServerEventId};

/// Event emitted by the server for clients to render or reconcile.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerEvent {
    pub id: ServerEventId,
    pub visible_to_client_ids: Vec<ClientId>,
    pub kind: ServerEventKind,
}

/// Top-level server event categories.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerEventKind {
    ProjectChanged(ProjectId),
    TaskChanged(TaskId),
    WorkspaceChanged(WorkspaceLayoutId),
    AgentRuntimeEvent(RuntimeEventIdentity),
    ClientConnected(ClientId),
    ClientDisconnected(ClientId),
    Warning(String),
    Error(String),
}
