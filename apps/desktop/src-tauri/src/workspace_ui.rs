use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 6;
const MIN_WINDOW_WIDTH: u32 = 900;
const MIN_WINDOW_HEIGHT: u32 = 620;
const MAX_WINDOW_DIMENSION: u32 = 16_384;

static CONFIG_IO_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkspaceUiConfigDto {
    pub schema_version: u32,
    pub window: WorkspaceWindowDto,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkspaceWindowDto {
    pub id: String,
    #[serde(default)]
    pub placement: WorkspaceWindowPlacementDto,
    #[serde(default = "default_workspace_layout")]
    pub layout: WorkspaceLayoutDto,
    pub regions: WorkspaceRegionsDto,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceWindowPlacementDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal_bounds: Option<WorkspaceWindowBoundsDto>,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceWindowBoundsDto {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WorkspaceLayoutDto {
    #[serde(default = "default_left_center_ratio")]
    pub left_center_ratio: f64,
    #[serde(default = "default_center_right_ratio")]
    pub center_right_ratio: f64,
    #[serde(default = "default_center_stack_ratio")]
    pub center_stack_ratio: f64,
    #[serde(default = "default_right_stack_ratio")]
    pub right_stack_ratio: f64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceRegionsDto {
    #[serde(default)]
    pub left: Vec<WorkspacePanelDto>,
    #[serde(default, alias = "right")]
    pub right_top: Vec<WorkspacePanelDto>,
    #[serde(default)]
    pub right_bottom: Vec<WorkspacePanelDto>,
    #[serde(default)]
    pub center_top: Vec<WorkspacePanelDto>,
    #[serde(default)]
    pub center_bottom: Vec<WorkspacePanelDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspacePanelDto {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub closeable: bool,
    pub movable: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub resource_targets: BTreeMap<String, String>,
    #[serde(default)]
    pub allowed_regions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct LegacyWorkspaceUiConfigDto {
    active_surface_id: String,
    surfaces: Vec<LegacyWorkspaceSurfaceDto>,
}

#[derive(Clone, Debug, Deserialize)]
struct LegacyWorkspaceSurfaceDto {
    id: String,
    #[serde(default = "default_workspace_layout")]
    layout: WorkspaceLayoutDto,
    regions: WorkspaceRegionsDto,
}

pub fn load_workspace_ui_config() -> Result<WorkspaceUiConfigDto, String> {
    let _guard = config_io_lock()?;
    load_workspace_ui_config_unlocked()
}

fn load_workspace_ui_config_unlocked() -> Result<WorkspaceUiConfigDto, String> {
    let path = workspace_ui_config_path()?;

    if !path.exists() {
        let config = default_workspace_ui_config();
        write_workspace_ui_config(&path, &config)?;
        return Ok(config);
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("read workspace UI config failed: {error}"))?;
    let (decoded, migrated) = decode_workspace_ui_config(&raw)?;
    let normalized = normalize_workspace_ui_config(decoded);
    if migrated {
        write_workspace_ui_config(&path, &normalized)?;
    }

    Ok(normalized)
}

pub fn save_workspace_ui_config(
    mut config: WorkspaceUiConfigDto,
) -> Result<WorkspaceUiConfigDto, String> {
    let _guard = config_io_lock()?;
    let current = load_workspace_ui_config_unlocked()?;
    preserve_host_owned_placement(&mut config, &current);
    let normalized = normalize_workspace_ui_config(config);
    let path = workspace_ui_config_path()?;
    write_workspace_ui_config(&path, &normalized)?;
    Ok(normalized)
}

fn preserve_host_owned_placement(
    requested: &mut WorkspaceUiConfigDto,
    current: &WorkspaceUiConfigDto,
) {
    requested.window.placement = current.window.placement.clone();
}

pub fn update_workspace_window_placement(
    placement: WorkspaceWindowPlacementDto,
) -> Result<(), String> {
    let _guard = config_io_lock()?;
    let mut config = load_workspace_ui_config_unlocked()?;
    let placement = normalize_window_placement(placement);

    config.window.placement.display_id = placement.display_id;
    config.window.placement.maximized = placement.maximized;
    if placement.normal_bounds.is_some() {
        config.window.placement.normal_bounds = placement.normal_bounds;
    }

    let path = workspace_ui_config_path()?;
    write_workspace_ui_config(&path, &normalize_workspace_ui_config(config))
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
    config.window.placement = normalize_window_placement(config.window.placement);
    config.window.layout = normalize_layout(config.window.layout);
    normalize_region_placements(&mut config.window.regions);
    normalize_memory_panels(&mut config.window.regions);
    normalize_singleton_task_panels(&mut config.window.regions);
    normalize_panels(&mut config.window.regions.left);
    normalize_panels(&mut config.window.regions.right_top);
    normalize_panels(&mut config.window.regions.right_bottom);
    normalize_panels(&mut config.window.regions.center_top);
    normalize_panels(&mut config.window.regions.center_bottom);

    config
}

fn normalize_memory_panels(regions: &mut WorkspaceRegionsDto) {
    for panel in regions
        .center_top
        .iter_mut()
        .chain(regions.center_bottom.iter_mut())
        .chain(regions.right_top.iter_mut())
        .chain(regions.right_bottom.iter_mut())
    {
        if panel.kind == "context" {
            panel.kind = "memory".to_owned();
            if panel.title == "Context" {
                panel.title = "Memory".to_owned();
            }
        }
    }
}

fn normalize_singleton_task_panels(regions: &mut WorkspaceRegionsDto) {
    let mut found_task_panel = false;
    normalize_task_panels(&mut regions.center_top, &mut found_task_panel);
    normalize_task_panels(&mut regions.center_bottom, &mut found_task_panel);
    normalize_task_panels(&mut regions.right_top, &mut found_task_panel);
    normalize_task_panels(&mut regions.right_bottom, &mut found_task_panel);
}

fn normalize_task_panels(panels: &mut Vec<WorkspacePanelDto>, found: &mut bool) {
    panels.retain_mut(|panel| {
        if panel.kind != "tasks" {
            return true;
        }
        if *found {
            return false;
        }
        *found = true;
        panel.closeable = true;
        true
    });
}

fn normalize_region_placements(regions: &mut WorkspaceRegionsDto) {
    let left_panels = std::mem::take(&mut regions.left);
    for panel in left_panels {
        if is_activity_panel(&panel) {
            regions.left.push(panel);
        } else {
            regions.center_top.push(panel);
        }
    }

    for activity_panel in take_activity_panels(&mut regions.center_top)
        .into_iter()
        .chain(take_activity_panels(&mut regions.center_bottom))
        .chain(take_activity_panels(&mut regions.right_top))
        .chain(take_activity_panels(&mut regions.right_bottom))
    {
        regions.left.push(activity_panel);
    }
}

fn take_activity_panels(panels: &mut Vec<WorkspacePanelDto>) -> Vec<WorkspacePanelDto> {
    let (activity_panels, workspace_panels) = std::mem::take(panels)
        .into_iter()
        .partition(is_activity_panel);
    *panels = workspace_panels;
    activity_panels
}

fn is_activity_panel(panel: &WorkspacePanelDto) -> bool {
    matches!(panel.kind.as_str(), "activity" | "projectActivity")
}

fn normalize_window_placement(
    mut placement: WorkspaceWindowPlacementDto,
) -> WorkspaceWindowPlacementDto {
    placement.display_id = placement
        .display_id
        .map(|display_id| display_id.trim().to_owned())
        .filter(|display_id| !display_id.is_empty());
    placement.normal_bounds = placement.normal_bounds.map(|mut bounds| {
        bounds.width = bounds.width.clamp(MIN_WINDOW_WIDTH, MAX_WINDOW_DIMENSION);
        bounds.height = bounds.height.clamp(MIN_WINDOW_HEIGHT, MAX_WINDOW_DIMENSION);
        bounds
    });
    placement
}

fn config_io_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    CONFIG_IO_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "workspace UI config lock is poisoned".to_owned())
}

fn decode_workspace_ui_config(raw: &str) -> Result<(WorkspaceUiConfigDto, bool), String> {
    let value = serde_json::from_str::<serde_json::Value>(raw)
        .map_err(|error| format!("decode workspace UI config failed: {error}"))?;
    let is_legacy = value.get("surfaces").is_some();

    if !is_legacy {
        let migrated = value
            .get("schema_version")
            .and_then(serde_json::Value::as_u64)
            != Some(u64::from(SCHEMA_VERSION));
        let decoded = serde_json::from_value::<WorkspaceUiConfigDto>(value)
            .map_err(|error| format!("decode workspace UI config failed: {error}"))?;
        return Ok((decoded, migrated));
    }

    let legacy = serde_json::from_value::<LegacyWorkspaceUiConfigDto>(value)
        .map_err(|error| format!("decode legacy workspace UI config failed: {error}"))?;
    let selected = legacy
        .surfaces
        .iter()
        .find(|surface| surface.id == legacy.active_surface_id)
        .or_else(|| legacy.surfaces.first());
    let window = selected
        .map(|surface| WorkspaceWindowDto {
            id: "window:primary".to_owned(),
            placement: WorkspaceWindowPlacementDto::default(),
            layout: surface.layout.clone(),
            regions: surface.regions.clone(),
        })
        .unwrap_or_else(|| default_workspace_ui_config().window);

    Ok((
        WorkspaceUiConfigDto {
            schema_version: SCHEMA_VERSION,
            window,
        },
        true,
    ))
}

fn normalize_panels(panels: &mut Vec<WorkspacePanelDto>) {
    for panel in panels {
        panel.allowed_regions = allowed_regions_for_kind(&panel.kind);
    }
}

fn normalize_layout(mut layout: WorkspaceLayoutDto) -> WorkspaceLayoutDto {
    layout.left_center_ratio = clamp_ratio(layout.left_center_ratio);
    layout.center_right_ratio = clamp_ratio(layout.center_right_ratio);
    layout.center_stack_ratio = clamp_ratio(layout.center_stack_ratio);
    layout.right_stack_ratio = clamp_ratio(layout.right_stack_ratio);
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
        window: WorkspaceWindowDto {
            id: "window:primary".to_owned(),
            placement: WorkspaceWindowPlacementDto::default(),
            layout: default_workspace_layout(),
            regions: WorkspaceRegionsDto {
                left: Vec::new(),
                right_top: vec![panel("panel:memory", "memory", "Memory", true, true)],
                right_bottom: Vec::new(),
                center_top: vec![
                    panel("panel:agent-chat", "agentChat", "Agent Chat", true, true),
                    panel("panel:tasks", "tasks", "Tasks", true, true),
                ],
                center_bottom: vec![panel("panel:terminal", "terminal", "Terminal", true, true)],
            },
        },
    }
}

fn default_workspace_layout() -> WorkspaceLayoutDto {
    WorkspaceLayoutDto {
        left_center_ratio: default_left_center_ratio(),
        center_right_ratio: default_center_right_ratio(),
        center_stack_ratio: default_center_stack_ratio(),
        right_stack_ratio: default_right_stack_ratio(),
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

fn default_right_stack_ratio() -> f64 {
    0.74
}

fn panel(id: &str, kind: &str, title: &str, closeable: bool, movable: bool) -> WorkspacePanelDto {
    WorkspacePanelDto {
        id: id.to_owned(),
        kind: kind.to_owned(),
        title: title.to_owned(),
        closeable,
        movable,
        resource_targets: BTreeMap::new(),
        allowed_regions: allowed_regions_for_kind(kind),
    }
}

fn allowed_regions_for_kind(kind: &str) -> Vec<String> {
    let regions = match kind {
        "activity" | "projectActivity" => vec!["left"],
        _ => main_region_ids(),
    };

    regions.into_iter().map(str::to_owned).collect()
}

fn main_region_ids() -> Vec<&'static str> {
    vec!["center_top", "center_bottom", "right_top", "right_bottom"]
}

#[cfg(test)]
mod tests {
    use super::{
        decode_workspace_ui_config, normalize_workspace_ui_config, preserve_host_owned_placement,
    };
    use crate::workspace_ui::{default_workspace_ui_config, SCHEMA_VERSION};

    #[test]
    fn default_config_has_primary_window_and_five_region_shape() {
        let config = default_workspace_ui_config();

        assert_eq!(config.schema_version, SCHEMA_VERSION);
        assert_eq!(config.window.id, "window:primary");
        assert_eq!(config.window.regions.left.len(), 0);
        assert_eq!(config.window.regions.right_top.len(), 1);
        assert_eq!(config.window.regions.right_top[0].kind, "memory");
        assert_eq!(config.window.regions.right_top[0].title, "Memory");
        assert_eq!(config.window.regions.right_bottom.len(), 0);
        assert_eq!(config.window.regions.center_top.len(), 2);
        assert_eq!(config.window.regions.center_bottom.len(), 1);
        assert_eq!(config.window.layout, super::default_workspace_layout());
        assert!(config
            .window
            .regions
            .center_top
            .iter()
            .any(|panel| panel.kind == "tasks" && panel.closeable));
        assert_eq!(
            config.window.regions.center_top[1].allowed_regions,
            vec![
                "center_top".to_string(),
                "center_bottom".to_string(),
                "right_top".to_string(),
                "right_bottom".to_string(),
            ]
        );
    }

    #[test]
    fn panel_resource_targets_round_trip_per_project() {
        let mut config = default_workspace_ui_config();
        let panel = config
            .window
            .regions
            .center_top
            .first_mut()
            .expect("workspace panel");
        panel.resource_targets = std::collections::BTreeMap::from([
            ("project:one".to_owned(), "resource:alpha".to_owned()),
            ("project:two".to_owned(), "resource:beta".to_owned()),
        ]);

        let raw = serde_json::to_string(&config).expect("encode config");
        let (decoded, migrated) = decode_workspace_ui_config(&raw).expect("decode config");
        let restored = &decoded.window.regions.center_top[0].resource_targets;

        assert!(!migrated);
        assert_eq!(
            restored.get("project:one").map(String::as_str),
            Some("resource:alpha")
        );
        assert_eq!(
            restored.get("project:two").map(String::as_str),
            Some("resource:beta")
        );
    }

    #[test]
    fn task_panel_is_closeable_and_normalized_to_one_instance() {
        let mut config = default_workspace_ui_config();
        let mut duplicate = config.window.regions.center_top[1].clone();
        config.window.regions.center_top[1].closeable = false;
        duplicate.id = "panel:tasks:duplicate".to_owned();
        config.window.regions.right_bottom.push(duplicate);

        let normalized = normalize_workspace_ui_config(config);
        let task_panels = normalized
            .window
            .regions
            .center_top
            .iter()
            .chain(normalized.window.regions.center_bottom.iter())
            .chain(normalized.window.regions.right_top.iter())
            .chain(normalized.window.regions.right_bottom.iter())
            .filter(|panel| panel.kind == "tasks")
            .collect::<Vec<_>>();

        assert_eq!(task_panels.len(), 1);
        assert_eq!(task_panels[0].id, "panel:tasks");
        assert!(task_panels[0].closeable);
    }

    #[test]
    fn legacy_config_flattens_the_active_surface_into_the_primary_window() {
        let raw = r#"{
          "schema_version": 1,
          "active_surface_id": "surface:second",
          "surfaces": [
            {
              "id": "surface:main",
              "title": "Main",
              "kind": "workspace",
              "layout": {"left_center_ratio": 0.2, "center_right_ratio": 0.7, "center_stack_ratio": 0.7},
              "regions": {"left": [], "right": [], "center_top": [], "center_bottom": []}
            },
            {
              "id": "surface:second",
              "title": "Second",
              "kind": "workspace",
              "layout": {"left_center_ratio": 0.3, "center_right_ratio": 0.6, "center_stack_ratio": 0.5},
              "regions": {
                "left": [],
                "right": [],
                "center_top": [{"id":"panel:editor","kind":"editor","title":"Editor","closeable":true,"movable":true,"allowed_regions":[]}],
                "center_bottom": []
              }
            }
          ]
        }"#;

        let (config, migrated) = decode_workspace_ui_config(raw).expect("legacy config migrates");
        let normalized = normalize_workspace_ui_config(config);

        assert!(migrated);
        assert_eq!(normalized.schema_version, SCHEMA_VERSION);
        assert_eq!(normalized.window.id, "window:primary");
        assert_eq!(
            normalized.window.placement,
            super::WorkspaceWindowPlacementDto::default()
        );
        assert_eq!(normalized.window.layout.left_center_ratio, 0.3);
        assert_eq!(normalized.window.regions.center_top[0].kind, "editor");
        assert_eq!(
            normalized.window.regions.center_top[0].allowed_regions,
            vec![
                "center_top".to_string(),
                "center_bottom".to_string(),
                "right_top".to_string(),
                "right_bottom".to_string(),
            ]
        );
    }

    #[test]
    fn schema_two_config_gains_empty_native_window_placement() {
        let raw = r#"{
          "schema_version": 2,
          "window": {
            "id": "window:primary",
            "layout": {"left_center_ratio": 0.2, "center_right_ratio": 0.74, "center_stack_ratio": 0.74},
            "regions": {"left": [], "right": [], "center_top": [], "center_bottom": []}
          }
        }"#;

        let (config, migrated) = decode_workspace_ui_config(raw).expect("schema two decodes");
        let normalized = normalize_workspace_ui_config(config);

        assert!(migrated);
        assert_eq!(normalized.schema_version, SCHEMA_VERSION);
        assert_eq!(
            normalized.window.placement,
            super::WorkspaceWindowPlacementDto::default()
        );
        assert!(normalized.window.regions.right_top.is_empty());
        assert!(normalized.window.regions.right_bottom.is_empty());
        assert_eq!(normalized.window.layout.right_stack_ratio, 0.74);
    }

    #[test]
    fn schema_three_right_region_migrates_to_right_top() {
        let raw = r#"{
          "schema_version": 3,
          "window": {
            "id": "window:primary",
            "placement": {"maximized": false},
            "layout": {"left_center_ratio": 0.2, "center_right_ratio": 0.74, "center_stack_ratio": 0.6},
            "regions": {
              "left": [],
              "right": [{"id":"panel:context","kind":"context","title":"Context","closeable":true,"movable":true,"allowed_regions":["right"]}],
              "center_top": [],
              "center_bottom": []
            }
          }
        }"#;

        let (config, migrated) = decode_workspace_ui_config(raw).expect("schema three decodes");
        let normalized = normalize_workspace_ui_config(config);

        assert!(migrated);
        assert_eq!(normalized.window.regions.right_top.len(), 1);
        assert!(normalized.window.regions.right_bottom.is_empty());
        assert_eq!(normalized.window.regions.right_top[0].kind, "memory");
        assert_eq!(normalized.window.regions.right_top[0].title, "Memory");
        assert_eq!(normalized.window.regions.right_top[0].id, "panel:context");
        assert_eq!(normalized.window.layout.right_stack_ratio, 0.74);
        assert_eq!(
            normalized.window.regions.right_top[0].allowed_regions,
            vec![
                "center_top".to_string(),
                "center_bottom".to_string(),
                "right_top".to_string(),
                "right_bottom".to_string(),
            ]
        );
    }

    #[test]
    fn schema_four_context_panel_migrates_to_memory_in_place() {
        let raw = r#"{
          "schema_version": 4,
          "window": {
            "id": "window:primary",
            "placement": {"maximized": false},
            "layout": {"left_center_ratio": 0.2, "center_right_ratio": 0.74, "center_stack_ratio": 0.6, "right_stack_ratio": 0.5},
            "regions": {
              "left": [],
              "right_top": [],
              "right_bottom": [{"id":"window:primary:panel:context:42","kind":"context","title":"Context","closeable":true,"movable":true,"allowed_regions":["center_top","center_bottom","right_top","right_bottom"]}],
              "center_top": [],
              "center_bottom": []
            }
          }
        }"#;

        let (config, migrated) = decode_workspace_ui_config(raw).expect("schema four decodes");
        let normalized = normalize_workspace_ui_config(config);
        let panel = &normalized.window.regions.right_bottom[0];

        assert!(migrated);
        assert_eq!(panel.id, "window:primary:panel:context:42");
        assert_eq!(panel.kind, "memory");
        assert_eq!(panel.title, "Memory");
        assert!(panel.closeable);
        assert!(panel.movable);
    }

    #[test]
    fn placement_normalization_repairs_dimensions_and_display_id() {
        let mut config = default_workspace_ui_config();
        config.window.placement = super::WorkspaceWindowPlacementDto {
            display_id: Some("  display:main  ".to_owned()),
            normal_bounds: Some(super::WorkspaceWindowBoundsDto {
                x: -100,
                y: 40,
                width: 100,
                height: 99_999,
            }),
            maximized: true,
        };

        let normalized = normalize_workspace_ui_config(config);
        let bounds = normalized.window.placement.normal_bounds.unwrap();

        assert_eq!(
            normalized.window.placement.display_id.as_deref(),
            Some("display:main")
        );
        assert_eq!(bounds.width, super::MIN_WINDOW_WIDTH);
        assert_eq!(bounds.height, super::MAX_WINDOW_DIMENSION);
        assert!(normalized.window.placement.maximized);
    }

    #[test]
    fn renderer_config_save_preserves_host_owned_placement() {
        let mut current = default_workspace_ui_config();
        current.window.placement = super::WorkspaceWindowPlacementDto {
            display_id: Some("display:current".to_owned()),
            normal_bounds: Some(super::WorkspaceWindowBoundsDto {
                x: 20,
                y: 30,
                width: 1200,
                height: 800,
            }),
            maximized: false,
        };
        let mut requested = default_workspace_ui_config();
        requested.window.placement.display_id = Some("display:stale".to_owned());
        requested.window.layout.left_center_ratio = 0.4;

        preserve_host_owned_placement(&mut requested, &current);

        assert_eq!(requested.window.placement, current.window.placement);
        assert_eq!(requested.window.layout.left_center_ratio, 0.4);
    }

    #[test]
    fn workspace_panels_can_move_to_all_main_regions() {
        assert_eq!(
            super::allowed_regions_for_kind("diff"),
            vec![
                "center_top".to_string(),
                "center_bottom".to_string(),
                "right_top".to_string(),
                "right_bottom".to_string(),
            ]
        );
    }

    #[test]
    fn normalize_repairs_stale_diff_allowed_regions() {
        let mut config = default_workspace_ui_config();
        config
            .window
            .regions
            .center_top
            .push(super::WorkspacePanelDto {
                id: "panel:diff".to_owned(),
                kind: "diff".to_owned(),
                title: "Diff".to_owned(),
                closeable: true,
                movable: true,
                resource_targets: std::collections::BTreeMap::from([(
                    "project:multi".to_owned(),
                    "resource:second".to_owned(),
                )]),
                allowed_regions: vec!["center_top".to_owned(), "center_bottom".to_owned()],
            });

        let normalized = normalize_workspace_ui_config(config);
        let panel = normalized
            .window
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
                "right_top".to_string(),
                "right_bottom".to_string(),
            ]
        );
        assert_eq!(
            panel
                .resource_targets
                .get("project:multi")
                .map(String::as_str),
            Some("resource:second")
        );
    }

    #[test]
    fn normalization_keeps_activity_left_and_workspace_tabs_in_main_regions() {
        let mut config = default_workspace_ui_config();
        config.window.regions.left.push(super::WorkspacePanelDto {
            id: "panel:legacy-left-editor".to_owned(),
            kind: "editor".to_owned(),
            title: "Editor".to_owned(),
            closeable: true,
            movable: true,
            resource_targets: std::collections::BTreeMap::new(),
            allowed_regions: vec!["left".to_owned()],
        });
        config
            .window
            .regions
            .right_bottom
            .push(super::WorkspacePanelDto {
                id: "panel:activity".to_owned(),
                kind: "activity".to_owned(),
                title: "Activity".to_owned(),
                closeable: false,
                movable: false,
                resource_targets: std::collections::BTreeMap::new(),
                allowed_regions: vec!["right_bottom".to_owned()],
            });

        let normalized = normalize_workspace_ui_config(config);

        assert!(normalized
            .window
            .regions
            .center_top
            .iter()
            .any(|panel| panel.id == "panel:legacy-left-editor"));
        assert!(normalized
            .window
            .regions
            .left
            .iter()
            .any(|panel| panel.id == "panel:activity"));
        assert!(normalized.window.regions.right_bottom.is_empty());
    }
}
