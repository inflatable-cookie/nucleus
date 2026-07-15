//! Per-project panel placement rules inside workspace windows.

use std::collections::{BTreeMap, BTreeSet};

use nucleus_projects::ProjectId;

use crate::ids::{PanelId, PanelKey, ProjectPanelLayoutId, WindowId};
use crate::regions::RegionId;

/// Local client profile panel rules for one project.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectPanelLayoutRules {
    pub id: ProjectPanelLayoutId,
    pub project_id: ProjectId,
    pub placements: Vec<ProjectPanelPlacement>,
}

/// Placement rule for a product panel inside a window region.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectPanelPlacement {
    pub panel_id: PanelId,
    pub panel_key: PanelKey,
    pub window_id: WindowId,
    pub region_id: RegionId,
    pub order: u32,
}

/// Resolved project panel skeleton for currently available windows.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectPanelResolution {
    pub project_id: ProjectId,
    pub windows: Vec<ResolvedWindowPanels>,
    pub skipped_panel_ids: Vec<PanelId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedWindowPanels {
    pub window_id: WindowId,
    pub regions: Vec<ResolvedRegionPanels>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedRegionPanels {
    pub region_id: RegionId,
    pub panel_ids: Vec<PanelId>,
}

impl ProjectPanelLayoutRules {
    /// First product shell shape for chat-led, task-backed workflow.
    pub fn chat_led_shell(
        id: ProjectPanelLayoutId,
        project_id: ProjectId,
        window_id: WindowId,
    ) -> Self {
        Self {
            id,
            project_id,
            placements: vec![
                placement(
                    "agent-chat",
                    "agent-chat",
                    &window_id,
                    RegionId::CenterTop,
                    0,
                ),
                placement("tasks", "tasks", &window_id, RegionId::CenterTop, 10),
                placement("memory", "memory", &window_id, RegionId::RightTop, 0),
                placement(
                    "terminal",
                    "terminal",
                    &window_id,
                    RegionId::CenterBottom,
                    0,
                ),
            ],
        }
    }
}

fn placement(
    panel_id: &str,
    panel_key: &str,
    window_id: &WindowId,
    region_id: RegionId,
    order: u32,
) -> ProjectPanelPlacement {
    ProjectPanelPlacement {
        panel_id: PanelId(format!("panel:{panel_id}")),
        panel_key: PanelKey(panel_key.to_string()),
        window_id: window_id.clone(),
        region_id,
        order,
    }
}

/// Resolve project panel rules against windows available in the shell.
pub fn resolve_project_panel_layout(
    rules: &ProjectPanelLayoutRules,
    available_window_ids: &[WindowId],
) -> ProjectPanelResolution {
    let available: BTreeSet<WindowId> = available_window_ids.iter().cloned().collect();
    let mut placements_by_window_region: BTreeMap<
        (WindowId, RegionId),
        Vec<&ProjectPanelPlacement>,
    > = BTreeMap::new();
    let mut skipped_panel_ids = Vec::new();

    for placement in &rules.placements {
        if available.contains(&placement.window_id) {
            placements_by_window_region
                .entry((placement.window_id.clone(), placement.region_id))
                .or_default()
                .push(placement);
        } else {
            skipped_panel_ids.push(placement.panel_id.clone());
        }
    }

    let mut windows = Vec::new();
    for window_id in available_window_ids {
        let mut regions = Vec::new();
        for ((candidate_window_id, region_id), placements) in &mut placements_by_window_region {
            if candidate_window_id != window_id {
                continue;
            }

            placements.sort_by(|a, b| {
                a.order
                    .cmp(&b.order)
                    .then_with(|| a.panel_id.cmp(&b.panel_id))
            });
            regions.push(ResolvedRegionPanels {
                region_id: *region_id,
                panel_ids: placements
                    .iter()
                    .map(|placement| placement.panel_id.clone())
                    .collect(),
            });
        }

        if !regions.is_empty() {
            regions.sort_by(|a, b| a.region_id.cmp(&b.region_id));
            windows.push(ResolvedWindowPanels {
                window_id: window_id.clone(),
                regions,
            });
        }
    }

    ProjectPanelResolution {
        project_id: rules.project_id.clone(),
        windows,
        skipped_panel_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_project_panel_layout, ProjectPanelLayoutRules, ProjectPanelPlacement};
    use crate::ids::{PanelId, PanelKey, ProjectPanelLayoutId, WindowId};
    use crate::regions::RegionId;
    use nucleus_projects::ProjectId;

    fn window(id: &str) -> WindowId {
        WindowId(id.to_string())
    }

    #[test]
    fn chat_led_shell_resolves_into_window_regions() {
        let window_id = window("window:primary");
        let rules = ProjectPanelLayoutRules::chat_led_shell(
            ProjectPanelLayoutId("layout:chat-led".to_string()),
            ProjectId("project:nucleus".to_string()),
            window_id.clone(),
        );

        let resolved = resolve_project_panel_layout(&rules, std::slice::from_ref(&window_id));

        assert_eq!(resolved.windows.len(), 1);
        assert_eq!(resolved.windows[0].window_id, window_id);
        assert!(resolved.windows[0].regions.iter().any(|region| {
            region.region_id == RegionId::CenterTop
                && region.panel_ids
                    == vec![
                        PanelId("panel:agent-chat".to_string()),
                        PanelId("panel:tasks".to_string()),
                    ]
        }));
    }

    #[test]
    fn missing_window_skips_project_panels() {
        let rules = ProjectPanelLayoutRules::chat_led_shell(
            ProjectPanelLayoutId("layout:chat-led".to_string()),
            ProjectId("project:nucleus".to_string()),
            window("window:missing"),
        );

        let resolved = resolve_project_panel_layout(&rules, &[window("window:primary")]);

        assert!(resolved.windows.is_empty());
        assert_eq!(resolved.skipped_panel_ids.len(), 4);
    }

    #[test]
    fn panel_order_is_stable_inside_region() {
        let window_id = window("window:primary");
        let rules = ProjectPanelLayoutRules {
            id: ProjectPanelLayoutId("layout:custom".to_string()),
            project_id: ProjectId("project:nucleus".to_string()),
            placements: vec![
                ProjectPanelPlacement {
                    panel_id: PanelId("panel:later".to_string()),
                    panel_key: PanelKey("later".to_string()),
                    window_id: window_id.clone(),
                    region_id: RegionId::RightTop,
                    order: 20,
                },
                ProjectPanelPlacement {
                    panel_id: PanelId("panel:first".to_string()),
                    panel_key: PanelKey("first".to_string()),
                    window_id: window_id.clone(),
                    region_id: RegionId::RightTop,
                    order: 10,
                },
            ],
        };

        let resolved = resolve_project_panel_layout(&rules, &[window_id]);
        let right_top = resolved.windows[0]
            .regions
            .iter()
            .find(|region| region.region_id == RegionId::RightTop)
            .expect("right top region resolves");

        assert_eq!(
            right_top.panel_ids,
            vec![
                PanelId("panel:first".to_string()),
                PanelId("panel:later".to_string()),
            ]
        );
    }
}
