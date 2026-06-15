//! Server authority declarations.

/// Area of system state owned by the server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthorityArea {
    Projects,
    RepoMembership,
    Tasks,
    AgentSessions,
    WorkspaceLayouts,
    TerminalAttachments,
    BrowserAttachments,
    HarnessProcesses,
    ModelRoutes,
}

/// Declares which state areas this server instance owns.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerAuthority {
    pub runtime_instance_id: String,
    pub areas: Vec<AuthorityArea>,
}
