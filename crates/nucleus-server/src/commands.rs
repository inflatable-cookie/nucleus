//! Server command envelope types.

use nucleus_agent_protocol::{AdapterIdentity, AgentSessionId, ModelRoute};
use nucleus_projects::{Project, ProjectId, RepoMembershipId, RepoRepairAction};
use nucleus_tasks::{Task, TaskId};
use nucleus_workspaces::{WorkspaceLayout, WorkspaceLayoutId};

use crate::ids::{ClientId, ServerCommandId};

/// Command sent by a control-plane client to the server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerCommand {
    pub id: ServerCommandId,
    pub client_id: ClientId,
    pub kind: ServerCommandKind,
}

/// Top-level command categories.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServerCommandKind {
    Project(ProjectCommand),
    Task(TaskCommand),
    Workspace(WorkspaceCommand),
    AgentSession(AgentSessionCommand),
    ConfigureModelRoute(ModelRoute),
}

/// Project state commands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectCommand {
    Create(Project),
    Update(Project),
    Park(ProjectId),
    Archive(ProjectId),
    RepairRepo {
        project_id: ProjectId,
        repo_id: RepoMembershipId,
        action: RepoRepairAction,
    },
}

/// Task state commands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskCommand {
    Create(Task),
    Update(Task),
    Start(TaskId),
    Block { task_id: TaskId, reason: String },
    Complete(TaskId),
    Archive(TaskId),
}

/// Workspace layout commands.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspaceCommand {
    Save(WorkspaceLayout),
    Activate(WorkspaceLayoutId),
    Archive(WorkspaceLayoutId),
}

/// Agent session commands routed through adapter instances.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentSessionCommand {
    RegisterAdapter(AdapterIdentity),
    StartSession {
        adapter_id: String,
        project_id: ProjectId,
    },
    CancelActiveTurn {
        session_id: AgentSessionId,
    },
    CloseSession {
        session_id: AgentSessionId,
    },
}
