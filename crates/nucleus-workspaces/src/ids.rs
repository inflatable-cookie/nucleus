//! Workspace identity types.

/// Stable workspace layout id.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct WorkspaceLayoutId(pub String);

/// Stable per-project panel layout id in local client profile state.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ProjectPanelLayoutId(pub String);

/// Stable panel id inside a workspace layout.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PanelId(pub String);

/// Stable panel kind/key understood by the product shell.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PanelKey(pub String);

/// Stable display id known to a local client profile.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DisplayId(pub String);

/// Stable workspace window id stored in local client profile layout state.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct WindowId(pub String);

/// Runtime-local window instance id used while resolving a shell layout.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct WindowInstanceId(pub String);

/// Host-native window handle. This is runtime-local and must not be persisted
/// as layout identity.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct HostWindowId(pub String);

/// Local client profile id for user/device-scoped layout authority.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ClientProfileId(pub String);

/// Signature for the current local display arrangement.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DisplayArrangementSignature(pub String);
