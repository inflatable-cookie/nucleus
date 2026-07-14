//! Project workspace layout records.

use std::time::SystemTime;

use nucleus_projects::ProjectId;

use crate::ids::{PanelId, WorkspaceLayoutId};
use crate::panels::Panel;

/// Persisted workspace layout attached to a project.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceLayout {
    pub id: WorkspaceLayoutId,
    pub project_id: ProjectId,
    pub display_name: String,
    pub status: WorkspaceLayoutStatus,
    pub panels: Vec<Panel>,
    pub focused_panel_id: Option<PanelId>,
    pub client_scope: ClientScope,
    pub timestamps: WorkspaceTimestamps,
}

/// Layout lifecycle state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspaceLayoutStatus {
    Active,
    Saved,
    Archived,
}

/// Client surface where a layout is intended to render.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientScope {
    Universal,
    Desktop,
    Web,
    Mobile,
    Cli,
}

/// Workspace layout timestamps.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceTimestamps {
    pub created_at: Option<SystemTime>,
    pub updated_at: Option<SystemTime>,
    pub last_used_at: Option<SystemTime>,
}
