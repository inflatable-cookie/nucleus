use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::dto::{
    WorkspaceLayoutDto, WorkspacePanelDto, WorkspaceRegionsDto, WorkspaceWindowPlacementDto,
};

pub const LEGACY_SCHEMA_VERSION: u32 = 10;
const WINDOW_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LegacyProjectLayoutsStore {
    pub schema_version: u32,
    #[serde(default)]
    pub project_layouts: BTreeMap<String, LegacyProjectLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_legacy_layout: Option<LegacyProjectLayout>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LegacyProjectLayout {
    #[serde(default = "default_workspace_layout")]
    pub layout: WorkspaceLayoutDto,
    pub regions: WorkspaceRegionsDto,
    #[serde(default)]
    pub active_panels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct LegacyWorkspaceStore {
    schema_version: u32,
    window: LegacyHostWindow,
    #[serde(default)]
    project_layouts: BTreeMap<String, LegacyProjectLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_legacy_layout: Option<LegacyProjectLayout>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct LegacyWindowStore {
    schema_version: u32,
    window: LegacyHostWindow,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct LegacyHostWindow {
    id: String,
    #[serde(default)]
    placement: WorkspaceWindowPlacementDto,
}

#[derive(Clone, Debug, Deserialize)]
struct LegacySingleConfig {
    window: LegacyWindow,
}

#[derive(Clone, Debug, Deserialize)]
struct LegacyWindow {
    id: String,
    #[serde(default)]
    placement: WorkspaceWindowPlacementDto,
    #[serde(default = "default_workspace_layout")]
    layout: WorkspaceLayoutDto,
    regions: WorkspaceRegionsDto,
    #[serde(default)]
    active_panels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize)]
struct LegacySurfaceConfig {
    schema_version: u32,
    active_surface_id: String,
    surfaces: Vec<LegacySurface>,
}

#[derive(Clone, Debug, Deserialize)]
struct LegacySurface {
    id: String,
    #[serde(default = "default_workspace_layout")]
    layout: WorkspaceLayoutDto,
    regions: WorkspaceRegionsDto,
}

pub fn decode_project_layout_source(bytes: &[u8]) -> Result<LegacyProjectLayoutsStore, String> {
    let value = serde_json::from_slice::<serde_json::Value>(bytes)
        .map_err(|error| format!("decode legacy project layouts failed: {error}"))?;
    let stored_version = stored_version(&value)?;
    if stored_version > u64::from(LEGACY_SCHEMA_VERSION) {
        return Err(format!(
            "workspace project layout schema {stored_version} is newer than supported schema {LEGACY_SCHEMA_VERSION}"
        ));
    }

    if value.get("project_layouts").is_some() && value.get("window").is_none() {
        let store = serde_json::from_value::<LegacyProjectLayoutsStore>(value)
            .map_err(|error| format!("decode legacy project layouts failed: {error}"))?;
        return Ok(normalize_project_store(store));
    }

    decode_workspace_store_value(value).map(|store| {
        normalize_project_store(LegacyProjectLayoutsStore {
            schema_version: LEGACY_SCHEMA_VERSION,
            project_layouts: store.project_layouts,
            pending_legacy_layout: store.pending_legacy_layout,
        })
    })
}

pub fn split_legacy_workspace_ui_document(raw: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let value = serde_json::from_slice::<serde_json::Value>(raw)
        .map_err(|error| format!("decode workspace UI config failed: {error}"))?;
    let store = normalize_workspace_store(decode_workspace_store_value(value)?);
    let window = LegacyWindowStore {
        schema_version: WINDOW_SCHEMA_VERSION,
        window: store.window,
    };
    let projects = LegacyProjectLayoutsStore {
        schema_version: LEGACY_SCHEMA_VERSION,
        project_layouts: store.project_layouts,
        pending_legacy_layout: store.pending_legacy_layout,
    };
    Ok((encoded(&window)?, encoded(&projects)?))
}

fn decode_workspace_store_value(value: serde_json::Value) -> Result<LegacyWorkspaceStore, String> {
    let version = stored_version(&value)?;
    if version > u64::from(LEGACY_SCHEMA_VERSION) {
        return Err(format!(
            "workspace UI config schema {version} is newer than supported schema {LEGACY_SCHEMA_VERSION}"
        ));
    }
    if value.get("surfaces").is_some() {
        return decode_surface_store(value);
    }
    if value.get("project_layouts").is_some() {
        return serde_json::from_value(value)
            .map_err(|error| format!("decode workspace UI config failed: {error}"));
    }
    let single = serde_json::from_value::<LegacySingleConfig>(value)
        .map_err(|error| format!("decode workspace UI config failed: {error}"))?;
    Ok(LegacyWorkspaceStore {
        schema_version: LEGACY_SCHEMA_VERSION,
        window: LegacyHostWindow {
            id: single.window.id,
            placement: single.window.placement,
        },
        project_layouts: BTreeMap::new(),
        pending_legacy_layout: Some(LegacyProjectLayout {
            layout: single.window.layout,
            regions: single.window.regions,
            active_panels: single.window.active_panels,
        }),
    })
}

fn decode_surface_store(value: serde_json::Value) -> Result<LegacyWorkspaceStore, String> {
    let legacy = serde_json::from_value::<LegacySurfaceConfig>(value)
        .map_err(|error| format!("decode legacy workspace UI config failed: {error}"))?;
    let selected = legacy
        .surfaces
        .iter()
        .find(|surface| surface.id == legacy.active_surface_id)
        .or_else(|| legacy.surfaces.first());
    let project = selected
        .map(|surface| LegacyProjectLayout {
            layout: surface.layout.clone(),
            regions: surface.regions.clone(),
            active_panels: BTreeMap::new(),
        })
        .unwrap_or_else(default_project_layout);
    Ok(LegacyWorkspaceStore {
        schema_version: legacy.schema_version,
        window: LegacyHostWindow {
            id: "window:primary".to_owned(),
            placement: WorkspaceWindowPlacementDto::default(),
        },
        project_layouts: BTreeMap::new(),
        pending_legacy_layout: Some(project),
    })
}

fn normalize_workspace_store(mut store: LegacyWorkspaceStore) -> LegacyWorkspaceStore {
    store.schema_version = LEGACY_SCHEMA_VERSION;
    store.project_layouts = store
        .project_layouts
        .into_iter()
        .filter(|(project_id, _)| !project_id.trim().is_empty())
        .map(|(project_id, layout)| (project_id, normalize_project_layout(layout)))
        .collect();
    store.pending_legacy_layout = store.pending_legacy_layout.map(normalize_project_layout);
    store
}

fn normalize_project_store(mut store: LegacyProjectLayoutsStore) -> LegacyProjectLayoutsStore {
    store.schema_version = LEGACY_SCHEMA_VERSION;
    store.project_layouts = store
        .project_layouts
        .into_iter()
        .filter(|(project_id, _)| !project_id.trim().is_empty())
        .map(|(project_id, layout)| (project_id, normalize_project_layout(layout)))
        .collect();
    store.pending_legacy_layout = store.pending_legacy_layout.map(normalize_project_layout);
    store
}

pub fn normalize_project_layout(mut project: LegacyProjectLayout) -> LegacyProjectLayout {
    project.layout.left_center_ratio = clamp_ratio(project.layout.left_center_ratio, 0.2);
    project.layout.center_right_ratio = clamp_ratio(project.layout.center_right_ratio, 0.74);
    project.layout.center_stack_ratio = clamp_ratio(project.layout.center_stack_ratio, 0.74);
    project.layout.right_stack_ratio = clamp_ratio(project.layout.right_stack_ratio, 0.74);
    normalize_region_placements(&mut project.regions);
    normalize_memory_panels(&mut project.regions);
    normalize_singleton_tasks(&mut project.regions);
    normalize_active_panels(&mut project);
    project
}

fn normalize_region_placements(regions: &mut WorkspaceRegionsDto) {
    let left = std::mem::take(&mut regions.left);
    for panel in left {
        if is_activity_panel(&panel) {
            regions.left.push(panel);
        } else {
            regions.center_top.push(panel);
        }
    }
    for panel in take_activity(&mut regions.center_top)
        .into_iter()
        .chain(take_activity(&mut regions.center_bottom))
        .chain(take_activity(&mut regions.right_top))
        .chain(take_activity(&mut regions.right_bottom))
    {
        regions.left.push(panel);
    }
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

fn normalize_singleton_tasks(regions: &mut WorkspaceRegionsDto) {
    let mut found = false;
    for panels in [
        &mut regions.center_top,
        &mut regions.center_bottom,
        &mut regions.right_top,
        &mut regions.right_bottom,
    ] {
        panels.retain_mut(|panel| {
            if panel.kind != "tasks" {
                return true;
            }
            if found {
                return false;
            }
            found = true;
            panel.closeable = true;
            true
        });
    }
}

fn normalize_active_panels(project: &mut LegacyProjectLayout) {
    project.active_panels.retain(|region, panel_id| {
        project
            .regions
            .get(region)
            .is_some_and(|panels| panels.iter().any(|panel| panel.id == *panel_id))
    });
}

fn take_activity(panels: &mut Vec<WorkspacePanelDto>) -> Vec<WorkspacePanelDto> {
    let (activity, workspace) = std::mem::take(panels)
        .into_iter()
        .partition(is_activity_panel);
    *panels = workspace;
    activity
}

fn is_activity_panel(panel: &WorkspacePanelDto) -> bool {
    matches!(panel.kind.as_str(), "activity" | "projectActivity")
}

fn clamp_ratio(value: f64, default: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.2, 0.9)
    } else {
        default
    }
}

fn default_project_layout() -> LegacyProjectLayout {
    LegacyProjectLayout {
        layout: default_workspace_layout(),
        regions: WorkspaceRegionsDto {
            left: Vec::new(),
            right_top: Vec::new(),
            right_bottom: Vec::new(),
            center_top: vec![WorkspacePanelDto {
                id: "panel:agent-chat".to_owned(),
                kind: "agentChat".to_owned(),
                title: "Agent Chat".to_owned(),
                closeable: true,
                movable: true,
                resource_targets: BTreeMap::new(),
                editor_file: None,
                forge_diff: None,
                run_review: None,
                allowed_regions: Vec::new(),
            }],
            center_bottom: Vec::new(),
        },
        active_panels: BTreeMap::from([("center_top".to_owned(), "panel:agent-chat".to_owned())]),
    }
}

fn default_workspace_layout() -> WorkspaceLayoutDto {
    WorkspaceLayoutDto {
        left_center_ratio: 0.2,
        center_right_ratio: 0.74,
        center_stack_ratio: 0.74,
        right_stack_ratio: 0.74,
    }
}

fn stored_version(value: &serde_json::Value) -> Result<u64, String> {
    value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "workspace UI config schema_version is required".to_owned())
}

fn encoded(value: &impl Serialize) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("encode split workspace UI state failed: {error}"))?;
    bytes.push(b'\n');
    Ok(bytes)
}
