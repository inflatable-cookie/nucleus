use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkspaceUiConfigDto {
    pub schema_version: u32,
    pub active_surface_id: String,
    pub surfaces: Vec<WorkspaceSurfaceDto>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkspaceSurfaceDto {
    pub id: String,
    pub title: String,
    pub kind: String,
    #[serde(default = "default_workspace_surface_layout")]
    pub layout: WorkspaceSurfaceLayoutDto,
    pub regions: WorkspaceRegionsDto,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkspaceSurfaceLayoutDto {
    #[serde(default = "default_left_center_ratio")]
    pub left_center_ratio: f64,
    #[serde(default = "default_center_right_ratio")]
    pub center_right_ratio: f64,
    #[serde(default = "default_center_stack_ratio")]
    pub center_stack_ratio: f64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceRegionsDto {
    pub left: Vec<WorkspacePanelDto>,
    pub right: Vec<WorkspacePanelDto>,
    pub center_top: Vec<WorkspacePanelDto>,
    pub center_bottom: Vec<WorkspacePanelDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspacePanelDto {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub closeable: bool,
    pub movable: bool,
    #[serde(default)]
    pub allowed_regions: Vec<String>,
}

pub fn load_workspace_ui_config() -> Result<WorkspaceUiConfigDto, String> {
    let path = workspace_ui_config_path()?;

    if !path.exists() {
        let config = default_workspace_ui_config();
        write_workspace_ui_config(&path, &config)?;
        return Ok(config);
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("read workspace UI config failed: {error}"))?;
    let decoded = serde_json::from_str::<WorkspaceUiConfigDto>(&raw)
        .map_err(|error| format!("decode workspace UI config failed: {error}"))?;

    Ok(normalize_workspace_ui_config(decoded))
}

pub fn save_workspace_ui_config(
    config: WorkspaceUiConfigDto,
) -> Result<WorkspaceUiConfigDto, String> {
    let normalized = normalize_workspace_ui_config(config);
    let path = workspace_ui_config_path()?;
    write_workspace_ui_config(&path, &normalized)?;
    Ok(normalized)
}

pub fn workspace_ui_config_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set; cannot resolve ~/.nucleus/config/ui.json".to_owned())?;

    Ok(home.join(".nucleus").join("config").join("ui.json"))
}

fn write_workspace_ui_config(path: &PathBuf, config: &WorkspaceUiConfigDto) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "workspace UI config path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create workspace UI config dir failed: {error}"))?;

    let encoded = serde_json::to_string_pretty(config)
        .map_err(|error| format!("encode workspace UI config failed: {error}"))?;
    fs::write(path, format!("{encoded}\n"))
        .map_err(|error| format!("write workspace UI config failed: {error}"))
}

fn normalize_workspace_ui_config(mut config: WorkspaceUiConfigDto) -> WorkspaceUiConfigDto {
    config.schema_version = SCHEMA_VERSION;

    if config.surfaces.is_empty() {
        config.surfaces = default_workspace_ui_config().surfaces;
    }

    if !config
        .surfaces
        .iter()
        .any(|surface| surface.id == config.active_surface_id)
    {
        config.active_surface_id = config
            .surfaces
            .first()
            .map(|surface| surface.id.clone())
            .unwrap_or_else(|| "surface:main".to_owned());
    }

    for surface in &mut config.surfaces {
        surface.layout = normalize_layout(surface.layout.clone());
        normalize_panels(&mut surface.regions.left);
        normalize_panels(&mut surface.regions.right);
        normalize_panels(&mut surface.regions.center_top);
        normalize_panels(&mut surface.regions.center_bottom);
    }

    config
}

fn normalize_panels(panels: &mut Vec<WorkspacePanelDto>) {
    for panel in panels {
        if let Some(canonical_regions) = canonical_allowed_regions_for_kind(&panel.kind) {
            panel.allowed_regions = canonical_regions;
        } else if panel.allowed_regions.is_empty() {
            panel.allowed_regions = all_region_ids();
        }
    }
}

fn normalize_layout(mut layout: WorkspaceSurfaceLayoutDto) -> WorkspaceSurfaceLayoutDto {
    layout.left_center_ratio = clamp_ratio(layout.left_center_ratio);
    layout.center_right_ratio = clamp_ratio(layout.center_right_ratio);
    layout.center_stack_ratio = clamp_ratio(layout.center_stack_ratio);
    layout
}

fn clamp_ratio(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.2, 0.9)
    } else {
        0.74
    }
}

fn default_workspace_ui_config() -> WorkspaceUiConfigDto {
    WorkspaceUiConfigDto {
        schema_version: SCHEMA_VERSION,
        active_surface_id: "surface:main".to_owned(),
        surfaces: vec![WorkspaceSurfaceDto {
            id: "surface:main".to_owned(),
            title: "Main".to_owned(),
            kind: "workspace".to_owned(),
            layout: default_workspace_surface_layout(),
            regions: WorkspaceRegionsDto {
                left: Vec::new(),
                right: vec![panel("panel:context", "context", "Context", true, true)],
                center_top: vec![
                    panel("panel:agent-chat", "agentChat", "Agent Chat", true, true),
                    panel("panel:tasks", "tasks", "Tasks", false, true),
                ],
                center_bottom: vec![panel("panel:terminal", "terminal", "Terminal", true, true)],
            },
        }],
    }
}

fn default_workspace_surface_layout() -> WorkspaceSurfaceLayoutDto {
    WorkspaceSurfaceLayoutDto {
        left_center_ratio: default_left_center_ratio(),
        center_right_ratio: default_center_right_ratio(),
        center_stack_ratio: default_center_stack_ratio(),
    }
}

fn default_left_center_ratio() -> f64 {
    0.2
}

fn default_center_right_ratio() -> f64 {
    0.74
}

fn default_center_stack_ratio() -> f64 {
    0.74
}

fn panel(id: &str, kind: &str, title: &str, closeable: bool, movable: bool) -> WorkspacePanelDto {
    WorkspacePanelDto {
        id: id.to_owned(),
        kind: kind.to_owned(),
        title: title.to_owned(),
        closeable,
        movable,
        allowed_regions: allowed_regions_for_kind(kind),
    }
}

fn allowed_regions_for_kind(kind: &str) -> Vec<String> {
    canonical_allowed_regions_for_kind(kind).unwrap_or_else(all_region_ids)
}

fn canonical_allowed_regions_for_kind(kind: &str) -> Option<Vec<String>> {
    let regions = match kind {
        "agentChat" | "tasks" | "terminal" | "browser" | "editor" => {
            vec!["center_top", "center_bottom"]
        }
        "diff" => vec!["center_top", "center_bottom", "right"],
        "context" => vec!["right"],
        "activity" | "projectActivity" => vec!["left"],
        _ => return None,
    };

    Some(regions.into_iter().map(str::to_owned).collect())
}

fn all_region_ids() -> Vec<String> {
    vec!["left", "right", "center_top", "center_bottom"]
        .into_iter()
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{normalize_workspace_ui_config, WorkspaceSurfaceDto, WorkspaceUiConfigDto};
    use crate::workspace_ui::default_workspace_ui_config;

    #[test]
    fn default_config_has_main_surface_and_four_region_shape() {
        let config = default_workspace_ui_config();

        assert_eq!(config.active_surface_id, "surface:main");
        assert_eq!(config.surfaces.len(), 1);
        assert_eq!(config.surfaces[0].regions.left.len(), 0);
        assert_eq!(config.surfaces[0].regions.right.len(), 1);
        assert_eq!(config.surfaces[0].regions.center_top.len(), 2);
        assert_eq!(config.surfaces[0].regions.center_bottom.len(), 1);
        assert_eq!(
            config.surfaces[0].layout,
            super::default_workspace_surface_layout()
        );
        assert!(config.surfaces[0]
            .regions
            .center_top
            .iter()
            .any(|panel| panel.kind == "tasks" && !panel.closeable));
        assert_eq!(
            config.surfaces[0].regions.center_top[1].allowed_regions,
            vec!["center_top".to_string(), "center_bottom".to_string()]
        );
    }

    #[test]
    fn normalize_restores_missing_active_surface() {
        let mut config = default_workspace_ui_config();
        config.active_surface_id = "surface:missing".to_owned();
        config.surfaces.push(WorkspaceSurfaceDto {
            id: "surface:second".to_owned(),
            title: "Second".to_owned(),
            kind: "workspace".to_owned(),
            layout: config.surfaces[0].layout.clone(),
            regions: config.surfaces[0].regions.clone(),
        });

        let normalized = normalize_workspace_ui_config(config);

        assert_eq!(normalized.active_surface_id, "surface:main");
    }

    #[test]
    fn normalize_restores_empty_surface_list() {
        let normalized = normalize_workspace_ui_config(WorkspaceUiConfigDto {
            schema_version: 99,
            active_surface_id: "surface:missing".to_owned(),
            surfaces: Vec::new(),
        });

        assert_eq!(normalized.schema_version, 1);
        assert_eq!(normalized.active_surface_id, "surface:main");
        assert_eq!(normalized.surfaces.len(), 1);
    }

    #[test]
    fn diff_panels_can_move_to_right_region() {
        assert_eq!(
            super::allowed_regions_for_kind("diff"),
            vec![
                "center_top".to_string(),
                "center_bottom".to_string(),
                "right".to_string()
            ]
        );
    }

    #[test]
    fn normalize_repairs_stale_diff_allowed_regions() {
        let mut config = default_workspace_ui_config();
        config.surfaces[0]
            .regions
            .center_top
            .push(super::WorkspacePanelDto {
                id: "panel:diff".to_owned(),
                kind: "diff".to_owned(),
                title: "Diff".to_owned(),
                closeable: true,
                movable: true,
                allowed_regions: vec!["center_top".to_owned(), "center_bottom".to_owned()],
            });

        let normalized = normalize_workspace_ui_config(config);
        let panel = normalized.surfaces[0]
            .regions
            .center_top
            .iter()
            .find(|panel| panel.kind == "diff")
            .expect("diff panel should remain in center top");

        assert_eq!(
            panel.allowed_regions,
            vec![
                "center_top".to_string(),
                "center_bottom".to_string(),
                "right".to_string()
            ]
        );
    }
}
