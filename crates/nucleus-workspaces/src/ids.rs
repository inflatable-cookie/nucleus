//! Product workspace planning identities.

/// Stable workspace layout id.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct WorkspaceLayoutId(pub String);

/// Stable panel id inside a workspace layout.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PanelId(pub String);
