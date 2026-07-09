//! Per-project panel placement rules below hosted surfaces.

use std::collections::{BTreeMap, BTreeSet};

use nucleus_projects::ProjectId;

use crate::ids::{PanelId, PanelKey, ProjectPanelLayoutId, SurfaceId};
use crate::regions::RegionId;

/// Local client profile panel rules for one project.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectPanelLayoutRules {
    pub id: ProjectPanelLayoutId,
    pub project_id: ProjectId,
    pub placements: Vec<ProjectPanelPlacement>,
}

/// Placement rule for a product panel inside a hosted surface region.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectPanelPlacement {
    pub panel_id: PanelId,
    pub panel_key: PanelKey,
    pub surface_id: SurfaceId,
    pub region_id: RegionId,
    pub order: u32,
}

/// Resolved project panel skeleton for currently available hosted surfaces.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectPanelResolution {
    pub project_id: ProjectId,
    pub surfaces: Vec<ResolvedSurfacePanels>,
    pub skipped_panel_ids: Vec<PanelId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedSurfacePanels {
    pub surface_id: SurfaceId,
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
        surface_id: SurfaceId,
    ) -> Self {
        Self {
            id,
            project_id,
            placements: vec![
                placement(
                    "agent-chat",
                    "agent-chat",
                    &surface_id,
                    RegionId::CenterTop,
                    0,
                ),
                placement("tasks", "tasks", &surface_id, RegionId::CenterTop, 10),
                placement("context", "context", &surface_id, RegionId::Right, 0),
                placement(
                    "terminal",
                    "terminal",
                    &surface_id,
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
    surface_id: &SurfaceId,
    region_id: RegionId,
    order: u32,
) -> ProjectPanelPlacement {
    ProjectPanelPlacement {
        panel_id: PanelId(format!("panel:{panel_id}")),
        panel_key: PanelKey(panel_key.to_string()),
        surface_id: surface_id.clone(),
        region_id,
        order,
    }
}

/// Resolve project panel rules against hosted surfaces available in the shell.
pub fn resolve_project_panel_layout(
    rules: &ProjectPanelLayoutRules,
    available_surface_ids: &[SurfaceId],
) -> ProjectPanelResolution {
    let available: BTreeSet<SurfaceId> = available_surface_ids.iter().cloned().collect();
    let mut placements_by_surface_region: BTreeMap<
        (SurfaceId, RegionId),
        Vec<&ProjectPanelPlacement>,
    > = BTreeMap::new();
    let mut skipped_panel_ids = Vec::new();

    for placement in &rules.placements {
        if available.contains(&placement.surface_id) {
            placements_by_surface_region
                .entry((placement.surface_id.clone(), placement.region_id))
                .or_default()
                .push(placement);
        } else {
            skipped_panel_ids.push(placement.panel_id.clone());
        }
    }

    let mut surfaces = Vec::new();
    for surface_id in available_surface_ids {
        let mut regions = Vec::new();
        for ((candidate_surface_id, region_id), placements) in &mut placements_by_surface_region {
            if candidate_surface_id != surface_id {
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
            surfaces.push(ResolvedSurfacePanels {
                surface_id: surface_id.clone(),
                regions,
            });
        }
    }

    ProjectPanelResolution {
        project_id: rules.project_id.clone(),
        surfaces,
        skipped_panel_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_project_panel_layout, ProjectPanelLayoutRules, ProjectPanelPlacement,
        ResolvedRegionPanels,
    };
    use crate::ids::{PanelId, PanelKey, ProjectPanelLayoutId, SurfaceId};
    use crate::regions::RegionId;
    use nucleus_projects::ProjectId;

    fn surface(id: &str) -> SurfaceId {
        SurfaceId(id.to_string())
    }

    #[test]
    fn chat_led_shell_resolves_into_hosted_surface_regions() {
        let surface_id = surface("surface:main");
        let rules = ProjectPanelLayoutRules::chat_led_shell(
            ProjectPanelLayoutId("layout:chat-led".to_string()),
            ProjectId("project:nucleus".to_string()),
            surface_id.clone(),
        );

        let resolved = resolve_project_panel_layout(&rules, &[surface_id.clone()]);

        assert_eq!(
            resolved.project_id,
            ProjectId("project:nucleus".to_string())
        );
        assert_eq!(resolved.surfaces.len(), 1);
        assert_eq!(resolved.surfaces[0].surface_id, surface_id);
        assert!(resolved.surfaces[0]
            .regions
            .iter()
            .any(|region| region.region_id == RegionId::CenterTop
                && region.panel_ids
                    == vec![
                        PanelId("panel:agent-chat".to_string()),
                        PanelId("panel:tasks".to_string())
                    ]));
    }

    #[test]
    fn missing_hosted_surface_skips_project_panels() {
        let rules = ProjectPanelLayoutRules::chat_led_shell(
            ProjectPanelLayoutId("layout:chat-led".to_string()),
            ProjectId("project:nucleus".to_string()),
            surface("surface:missing"),
        );

        let resolved = resolve_project_panel_layout(&rules, &[surface("surface:main")]);

        assert!(resolved.surfaces.is_empty());
        assert_eq!(resolved.skipped_panel_ids.len(), 4);
    }

    #[test]
    fn panel_order_is_stable_inside_region() {
        let surface_id = surface("surface:main");
        let rules = ProjectPanelLayoutRules {
            id: ProjectPanelLayoutId("layout:custom".to_string()),
            project_id: ProjectId("project:nucleus".to_string()),
            placements: vec![
                ProjectPanelPlacement {
                    panel_id: PanelId("panel:b".to_string()),
                    panel_key: PanelKey("b".to_string()),
                    surface_id: surface_id.clone(),
                    region_id: RegionId::CenterTop,
                    order: 20,
                },
                ProjectPanelPlacement {
                    panel_id: PanelId("panel:a".to_string()),
                    panel_key: PanelKey("a".to_string()),
                    surface_id: surface_id.clone(),
                    region_id: RegionId::CenterTop,
                    order: 10,
                },
            ],
        };

        let resolved = resolve_project_panel_layout(&rules, &[surface_id]);

        assert_eq!(
            resolved.surfaces[0].regions,
            vec![ResolvedRegionPanels {
                region_id: RegionId::CenterTop,
                panel_ids: vec![
                    PanelId("panel:a".to_string()),
                    PanelId("panel:b".to_string())
                ],
            }]
        );
    }
}
