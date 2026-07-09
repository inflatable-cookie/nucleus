//! Pure window planning helpers.

use std::collections::BTreeSet;

use crate::geometry::Bounds;
use crate::ids::{DisplayId, WindowId};
use crate::windows::WorkspaceWindowConfig;

/// Input for resolving configured windows against currently available displays.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowPlanInput {
    pub configured_windows: Vec<WorkspaceWindowConfig>,
    pub available_displays: Vec<DisplayId>,
}

/// Resolved window placement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlannedWindow {
    pub window_id: WindowId,
    pub target_display_id: DisplayId,
    pub bounds: Option<Bounds>,
}

/// Output for a deterministic window plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowPlanOutput {
    pub windows: Vec<PlannedWindow>,
    pub primary_window_id: Option<WindowId>,
}

/// Pick the first available display from target plus fallback ids.
pub fn choose_display_id(
    target_display_id: &DisplayId,
    fallback_display_ids: &[DisplayId],
    available_display_ids: &BTreeSet<DisplayId>,
) -> Option<DisplayId> {
    if available_display_ids.contains(target_display_id) {
        return Some(target_display_id.clone());
    }

    fallback_display_ids
        .iter()
        .find(|display_id| available_display_ids.contains(*display_id))
        .cloned()
}

/// Resolve enabled windows against available displays.
///
/// If no configured window can be placed, the first enabled window is placed
/// on the first available display as a bounded derived fallback. If no display
/// is available, no windows are planned.
pub fn plan_windows(input: &WindowPlanInput) -> WindowPlanOutput {
    let available_display_ids: BTreeSet<DisplayId> =
        input.available_displays.iter().cloned().collect();
    let default_display_id = input.available_displays.first().cloned();

    let mut enabled_configs: Vec<&WorkspaceWindowConfig> = input
        .configured_windows
        .iter()
        .filter(|window| window.placement.enabled)
        .collect();
    enabled_configs.sort_by(|a, b| a.id.cmp(&b.id));

    let mut windows: Vec<PlannedWindow> = enabled_configs
        .iter()
        .filter_map(|window| {
            let target_display_id = choose_display_id(
                &window.placement.target_display_id,
                &window.placement.fallback_display_ids,
                &available_display_ids,
            )?;
            let bounds = window
                .placement
                .geometry_by_display_id
                .get(&target_display_id)
                .map(|geometry| geometry.as_bounds());

            Some(PlannedWindow {
                window_id: window.id.clone(),
                target_display_id,
                bounds,
            })
        })
        .collect();
    windows.sort_by(|a, b| a.window_id.cmp(&b.window_id));

    if windows.is_empty() {
        if let (Some(fallback_display_id), Some(primary_config)) =
            (default_display_id, enabled_configs.first())
        {
            let bounds = primary_config
                .placement
                .geometry_by_display_id
                .get(&fallback_display_id)
                .map(|geometry| geometry.as_bounds());

            windows.push(PlannedWindow {
                window_id: primary_config.id.clone(),
                target_display_id: fallback_display_id,
                bounds,
            });
        }
    }

    let primary_window_id = windows.first().map(|window| window.window_id.clone());

    WindowPlanOutput {
        windows,
        primary_window_id,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use super::{choose_display_id, plan_windows, WindowPlanInput};
    use crate::geometry::{Bounds, WindowGeometry};
    use crate::ids::{DisplayId, WindowId};
    use crate::windows::{HostWindowRole, WorkspaceWindowConfig, WorkspaceWindowPlacement};

    fn display(id: &str) -> DisplayId {
        DisplayId(id.to_string())
    }

    fn window(
        id: &str,
        target_display_id: DisplayId,
        fallback_display_ids: Vec<DisplayId>,
        geometry_by_display_id: BTreeMap<DisplayId, WindowGeometry>,
    ) -> WorkspaceWindowConfig {
        WorkspaceWindowConfig {
            id: WindowId(id.to_string()),
            host_role: HostWindowRole::Primary,
            placement: WorkspaceWindowPlacement {
                enabled: true,
                target_display_id,
                fallback_display_ids,
                geometry_by_display_id,
            },
        }
    }

    #[test]
    fn choose_display_id_prefers_target_display() {
        let target = display("display:target");
        let fallback = display("display:fallback");
        let available = BTreeSet::from([target.clone(), fallback.clone()]);

        assert_eq!(
            choose_display_id(&target, &[fallback], &available),
            Some(target)
        );
    }

    #[test]
    fn choose_display_id_uses_first_available_fallback() {
        let target = display("display:missing");
        let unavailable = display("display:unavailable");
        let fallback = display("display:fallback");
        let available = BTreeSet::from([fallback.clone()]);

        assert_eq!(
            choose_display_id(&target, &[unavailable, fallback.clone()], &available),
            Some(fallback)
        );
    }

    #[test]
    fn plan_windows_uses_geometry_for_resolved_display() {
        let target = display("display:target");
        let fallback = display("display:fallback");
        let mut geometry_by_display_id = BTreeMap::new();
        geometry_by_display_id.insert(
            fallback.clone(),
            WindowGeometry {
                x: 20,
                y: 30,
                width: 900,
                height: 700,
            },
        );

        let plan = plan_windows(&WindowPlanInput {
            configured_windows: vec![window(
                "window:primary",
                target,
                vec![fallback.clone()],
                geometry_by_display_id,
            )],
            available_displays: vec![fallback],
        });

        assert_eq!(
            plan.primary_window_id,
            Some(WindowId("window:primary".to_string()))
        );
        assert_eq!(plan.windows.len(), 1);
        assert_eq!(
            plan.windows[0].bounds,
            Some(Bounds {
                x: 20,
                y: 30,
                width: 900,
                height: 700
            })
        );
    }

    #[test]
    fn plan_windows_derives_fallback_when_no_window_is_placeable() {
        let available = display("display:available");
        let mut geometry_by_display_id = BTreeMap::new();
        geometry_by_display_id.insert(
            available.clone(),
            WindowGeometry {
                x: 0,
                y: 0,
                width: 1200,
                height: 800,
            },
        );

        let plan = plan_windows(&WindowPlanInput {
            configured_windows: vec![window(
                "window:primary",
                display("display:missing"),
                Vec::new(),
                geometry_by_display_id,
            )],
            available_displays: vec![available.clone()],
        });

        assert_eq!(plan.windows.len(), 1);
        assert_eq!(plan.windows[0].target_display_id, available);
    }

    #[test]
    fn plan_windows_returns_empty_when_no_display_is_available() {
        let plan = plan_windows(&WindowPlanInput {
            configured_windows: vec![window(
                "window:primary",
                display("display:missing"),
                Vec::new(),
                BTreeMap::new(),
            )],
            available_displays: Vec::new(),
        });

        assert!(plan.windows.is_empty());
        assert_eq!(plan.primary_window_id, None);
    }
}
