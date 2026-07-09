//! Workspace window configuration records.

use std::collections::BTreeMap;

use crate::geometry::WindowGeometry;
use crate::ids::{DisplayId, HostWindowId, WindowId, WindowInstanceId};

/// Host role for a native window.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum HostWindowRole {
    /// Long-lived primary host slot.
    #[default]
    Primary,
    /// Additional host window created from local shell layout state.
    Secondary,
    /// Additional optional host window after the secondary slot.
    Tertiary,
}

/// Local client profile placement config for a workspace window.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceWindowPlacement {
    pub enabled: bool,
    pub target_display_id: DisplayId,
    pub fallback_display_ids: Vec<DisplayId>,
    pub geometry_by_display_id: BTreeMap<DisplayId, WindowGeometry>,
}

/// Stable workspace window config. This is persisted local layout state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceWindowConfig {
    pub id: WindowId,
    pub host_role: HostWindowRole,
    pub placement: WorkspaceWindowPlacement,
}

/// Host-provided runtime window instance. The host handle is not durable
/// layout identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostWindowInstance {
    pub window_instance_id: WindowInstanceId,
    pub host_window_id: HostWindowId,
    pub role: HostWindowRole,
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{HostWindowRole, WorkspaceWindowConfig, WorkspaceWindowPlacement};
    use crate::geometry::WindowGeometry;
    use crate::ids::{DisplayId, WindowId};

    #[test]
    fn window_config_keeps_stable_id_separate_from_host_handles() {
        let display_id = DisplayId("display:main".to_string());
        let mut geometry_by_display_id = BTreeMap::new();
        geometry_by_display_id.insert(
            display_id.clone(),
            WindowGeometry {
                x: 0,
                y: 0,
                width: 1280,
                height: 900,
            },
        );

        let config = WorkspaceWindowConfig {
            id: WindowId("window:primary".to_string()),
            host_role: HostWindowRole::Primary,
            placement: WorkspaceWindowPlacement {
                enabled: true,
                target_display_id: display_id.clone(),
                fallback_display_ids: Vec::new(),
                geometry_by_display_id,
            },
        };

        assert_eq!(config.id, WindowId("window:primary".to_string()));
        assert_eq!(config.placement.target_display_id, display_id);
    }
}
