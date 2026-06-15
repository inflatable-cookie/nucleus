//! Workspace identity types.

/// Stable workspace layout id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct WorkspaceLayoutId(pub String);

/// Stable panel id inside a workspace layout.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct PanelId(pub String);

/// Stable surface id for a tab or view attached to a panel.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct SurfaceId(pub String);
