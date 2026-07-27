use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 10;
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
    #[serde(default)]
    pub active_panels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct WorkspaceUiStoreDto {
    schema_version: u32,
    window: WorkspaceHostWindowDto,
    #[serde(default)]
    project_layouts: BTreeMap<String, WorkspaceProjectLayoutDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_legacy_layout: Option<WorkspaceProjectLayoutDto>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct WorkspaceHostWindowDto {
    id: String,
    #[serde(default)]
    placement: WorkspaceWindowPlacementDto,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct WorkspaceProjectLayoutDto {
    #[serde(default = "default_workspace_layout")]
    layout: WorkspaceLayoutDto,
    regions: WorkspaceRegionsDto,
    #[serde(default)]
    active_panels: BTreeMap<String, String>,
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
    // Renderer code indexes this map directly. Always serialize an empty map
    // so an optional persisted field never becomes an optional IPC field.
    #[serde(default)]
    pub resource_targets: BTreeMap<String, String>,
    #[serde(default)]
    pub editor_file: Option<WorkspaceEditorFileDto>,
    #[serde(default)]
    pub forge_diff: Option<WorkspaceForgeDiffDto>,
    #[serde(default)]
    pub allowed_regions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceEditorFileDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    pub file_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkspaceForgeDiffDto {
    pub resource_id: String,
    pub path: String,
    #[serde(default = "default_forge_diff_scope")]
    pub scope: String,
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

pub fn load_workspace_ui_config(
    path: &Path,
    project_id: &str,
) -> Result<WorkspaceUiConfigDto, String> {
    validate_project_id(project_id)?;
    let _guard = config_io_lock()?;
    let mut store = load_workspace_ui_store_unlocked(path)?;
    let changed = ensure_project_layout(&mut store, project_id);

    if changed {
        write_workspace_ui_store(path, &store)?;
    }

    materialize_project_config(&store, project_id)
}

pub fn load_workspace_window_placement(path: &Path) -> Result<WorkspaceWindowPlacementDto, String> {
    let _guard = config_io_lock()?;
    Ok(load_workspace_ui_store_unlocked(path)?.window.placement)
}

fn load_workspace_ui_store_unlocked(path: &Path) -> Result<WorkspaceUiStoreDto, String> {
    if !path.exists() {
        let store = default_workspace_ui_store();
        write_workspace_ui_store(path, &store)?;
        return Ok(store);
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("read workspace UI config failed: {error}"))?;
    let (decoded, migrated) = decode_workspace_ui_store(&raw)?;
    let normalized = normalize_workspace_ui_store(decoded);
    if migrated {
        write_workspace_ui_store(path, &normalized)?;
    }

    Ok(normalized)
}

pub fn save_workspace_ui_config(
    path: &Path,
    project_id: &str,
    config: WorkspaceUiConfigDto,
) -> Result<WorkspaceUiConfigDto, String> {
    validate_project_id(project_id)?;
    let _guard = config_io_lock()?;
    let mut store = load_workspace_ui_store_unlocked(path)?;
    apply_project_config(&mut store, project_id, config);
    write_workspace_ui_store(path, &store)?;
    materialize_project_config(&store, project_id)
}

pub fn update_workspace_window_placement(
    path: &Path,
    placement: WorkspaceWindowPlacementDto,
) -> Result<(), String> {
    let _guard = config_io_lock()?;
    let mut store = load_workspace_ui_store_unlocked(path)?;
    let placement = normalize_window_placement(placement);

    store.window.placement.display_id = placement.display_id;
    store.window.placement.maximized = placement.maximized;
    if placement.normal_bounds.is_some() {
        store.window.placement.normal_bounds = placement.normal_bounds;
    }

    write_workspace_ui_store(path, &normalize_workspace_ui_store(store))
}

fn write_workspace_ui_store(path: &Path, store: &WorkspaceUiStoreDto) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "workspace UI config path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create workspace UI config dir failed: {error}"))?;

    let encoded = serde_json::to_string_pretty(store)
        .map_err(|error| format!("encode workspace UI config failed: {error}"))?;
    fs::write(path, format!("{encoded}\n"))
        .map_err(|error| format!("write workspace UI config failed: {error}"))
}

fn normalize_workspace_ui_store(mut store: WorkspaceUiStoreDto) -> WorkspaceUiStoreDto {
    store.schema_version = SCHEMA_VERSION;
    store.window.placement = normalize_window_placement(store.window.placement);
    store.project_layouts = store
        .project_layouts
        .into_iter()
        .filter(|(project_id, _)| !project_id.trim().is_empty())
        .map(|(project_id, layout)| (project_id, normalize_project_layout(layout)))
        .collect();
    store.pending_legacy_layout = store.pending_legacy_layout.map(normalize_project_layout);
    store
}

fn normalize_project_layout(mut project: WorkspaceProjectLayoutDto) -> WorkspaceProjectLayoutDto {
    project.layout = normalize_layout(project.layout);
    normalize_region_placements(&mut project.regions);
    normalize_memory_panels(&mut project.regions);
    normalize_singleton_task_panels(&mut project.regions);
    normalize_panels(&mut project.regions.left);
    normalize_panels(&mut project.regions.right_top);
    normalize_panels(&mut project.regions.right_bottom);
    normalize_panels(&mut project.regions.center_top);
    normalize_panels(&mut project.regions.center_bottom);
    normalize_active_panels(&mut project);
    project
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

fn validate_project_id(project_id: &str) -> Result<(), String> {
    if project_id.trim().is_empty() {
        Err("project id is required to load workspace UI config".to_owned())
    } else {
        Ok(())
    }
}

fn ensure_project_layout(store: &mut WorkspaceUiStoreDto, project_id: &str) -> bool {
    if store.project_layouts.contains_key(project_id) {
        return false;
    }

    let layout = store
        .pending_legacy_layout
        .take()
        .unwrap_or_else(default_project_layout);
    store
        .project_layouts
        .insert(project_id.to_owned(), normalize_project_layout(layout));
    true
}

fn apply_project_config(
    store: &mut WorkspaceUiStoreDto,
    project_id: &str,
    config: WorkspaceUiConfigDto,
) {
    store.project_layouts.insert(
        project_id.to_owned(),
        normalize_project_layout(WorkspaceProjectLayoutDto {
            layout: config.window.layout,
            regions: config.window.regions,
            active_panels: config.window.active_panels,
        }),
    );
    store.pending_legacy_layout = None;
}

fn decode_workspace_ui_store(raw: &str) -> Result<(WorkspaceUiStoreDto, bool), String> {
    let value = serde_json::from_str::<serde_json::Value>(raw)
        .map_err(|error| format!("decode workspace UI config failed: {error}"))?;
    let is_legacy = value.get("surfaces").is_some();

    if !is_legacy && value.get("project_layouts").is_some() {
        let stored_version = value
            .get("schema_version")
            .and_then(serde_json::Value::as_u64);
        let decoded = serde_json::from_value::<WorkspaceUiStoreDto>(value)
            .map_err(|error| format!("decode workspace UI config failed: {error}"))?;
        return Ok((decoded, stored_version != Some(u64::from(SCHEMA_VERSION))));
    }

    if !is_legacy {
        let decoded = serde_json::from_value::<WorkspaceUiConfigDto>(value)
            .map_err(|error| format!("decode workspace UI config failed: {error}"))?;
        return Ok((migrate_single_layout(decoded), true));
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
            active_panels: BTreeMap::new(),
        })
        .unwrap_or_else(|| WorkspaceWindowDto {
            id: "window:primary".to_owned(),
            placement: WorkspaceWindowPlacementDto::default(),
            layout: default_workspace_layout(),
            regions: default_project_layout().regions,
            active_panels: BTreeMap::new(),
        });

    Ok((
        migrate_single_layout(WorkspaceUiConfigDto {
            schema_version: SCHEMA_VERSION,
            window,
        }),
        true,
    ))
}

fn migrate_single_layout(config: WorkspaceUiConfigDto) -> WorkspaceUiStoreDto {
    WorkspaceUiStoreDto {
        schema_version: SCHEMA_VERSION,
        window: WorkspaceHostWindowDto {
            id: config.window.id,
            placement: config.window.placement,
        },
        project_layouts: BTreeMap::new(),
        pending_legacy_layout: Some(WorkspaceProjectLayoutDto {
            layout: config.window.layout,
            regions: config.window.regions,
            active_panels: config.window.active_panels,
        }),
    }
}

fn materialize_project_config(
    store: &WorkspaceUiStoreDto,
    project_id: &str,
) -> Result<WorkspaceUiConfigDto, String> {
    let project = store
        .project_layouts
        .get(project_id)
        .ok_or_else(|| format!("workspace layout is missing for project {project_id}"))?;

    Ok(WorkspaceUiConfigDto {
        schema_version: SCHEMA_VERSION,
        window: WorkspaceWindowDto {
            id: store.window.id.clone(),
            placement: store.window.placement.clone(),
            layout: project.layout.clone(),
            regions: project.regions.clone(),
            active_panels: project.active_panels.clone(),
        },
    })
}

fn normalize_panels(panels: &mut Vec<WorkspacePanelDto>) {
    for panel in panels {
        panel.allowed_regions = allowed_regions_for_kind(&panel.kind);
        panel.editor_file = if panel.kind == "editor" {
            panel.editor_file.take().and_then(normalize_editor_file)
        } else {
            None
        };
        panel.forge_diff = if panel.kind == "forgeDiff" {
            panel.forge_diff.take().and_then(normalize_forge_diff)
        } else {
            None
        };
    }
}

fn normalize_editor_file(mut file: WorkspaceEditorFileDto) -> Option<WorkspaceEditorFileDto> {
    file.resource_id = file
        .resource_id
        .map(|resource_id| resource_id.trim().to_owned())
        .filter(|resource_id| !resource_id.is_empty());
    file.file_ref = file.file_ref.trim().to_owned();
    file.display_path = file
        .display_path
        .map(|display_path| display_path.trim().to_owned())
        .filter(|display_path| !display_path.is_empty());

    if file.file_ref.is_empty() || file.file_ref.len() > 512 {
        return None;
    }
    if file
        .resource_id
        .as_ref()
        .is_some_and(|resource_id| resource_id.len() > 512)
    {
        return None;
    }
    if file
        .display_path
        .as_ref()
        .is_some_and(|display_path| display_path.len() > 4096)
    {
        return None;
    }

    Some(file)
}

fn normalize_forge_diff(mut diff: WorkspaceForgeDiffDto) -> Option<WorkspaceForgeDiffDto> {
    diff.resource_id = diff.resource_id.trim().to_owned();
    diff.path = diff.path.trim().to_owned();
    diff.scope = match diff.scope.trim() {
        "staged" => "staged".to_owned(),
        "working" => "working".to_owned(),
        _ => default_forge_diff_scope(),
    };
    if diff.resource_id.is_empty()
        || diff.resource_id.len() > 512
        || diff.path.is_empty()
        || diff.path.len() > 4096
    {
        return None;
    }
    Some(diff)
}

fn default_forge_diff_scope() -> String {
    "all".to_owned()
}

fn normalize_active_panels(project: &mut WorkspaceProjectLayoutDto) {
    project.active_panels.retain(|region, panel_id| {
        panels_for_region(&project.regions, region)
            .is_some_and(|panels| panels.iter().any(|panel| panel.id == *panel_id))
    });
}

fn panels_for_region<'a>(
    regions: &'a WorkspaceRegionsDto,
    region: &str,
) -> Option<&'a [WorkspacePanelDto]> {
    match region {
        "left" => Some(&regions.left),
        "center_top" => Some(&regions.center_top),
        "center_bottom" => Some(&regions.center_bottom),
        "right_top" => Some(&regions.right_top),
        "right_bottom" => Some(&regions.right_bottom),
        _ => None,
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

fn default_workspace_ui_store() -> WorkspaceUiStoreDto {
    WorkspaceUiStoreDto {
        schema_version: SCHEMA_VERSION,
        window: WorkspaceHostWindowDto {
            id: "window:primary".to_owned(),
            placement: WorkspaceWindowPlacementDto::default(),
        },
        project_layouts: BTreeMap::new(),
        pending_legacy_layout: None,
    }
}

fn default_project_layout() -> WorkspaceProjectLayoutDto {
    WorkspaceProjectLayoutDto {
        layout: default_workspace_layout(),
        regions: WorkspaceRegionsDto {
            left: Vec::new(),
            right_top: Vec::new(),
            right_bottom: Vec::new(),
            center_top: vec![panel(
                "panel:agent-chat",
                "agentChat",
                "Agent Chat",
                true,
                true,
            )],
            center_bottom: Vec::new(),
        },
        active_panels: BTreeMap::from([("center_top".to_owned(), "panel:agent-chat".to_owned())]),
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
        editor_file: None,
        forge_diff: None,
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
fn default_workspace_ui_config() -> WorkspaceUiConfigDto {
    let mut store = default_workspace_ui_store();
    ensure_project_layout(&mut store, "project:test");
    materialize_project_config(&store, "project:test").expect("default project config")
}

#[cfg(test)]
fn decode_workspace_ui_config(raw: &str) -> Result<(WorkspaceUiConfigDto, bool), String> {
    let (store, migrated) = decode_workspace_ui_store(raw)?;
    let mut store = normalize_workspace_ui_store(store);
    ensure_project_layout(&mut store, "project:test");
    materialize_project_config(&store, "project:test").map(|config| (config, migrated))
}

#[cfg(test)]
fn normalize_workspace_ui_config(config: WorkspaceUiConfigDto) -> WorkspaceUiConfigDto {
    let mut store = normalize_workspace_ui_store(migrate_single_layout(config));
    ensure_project_layout(&mut store, "project:test");
    materialize_project_config(&store, "project:test").expect("normalized project config")
}

#[cfg(test)]
fn preserve_host_owned_placement(
    requested: &mut WorkspaceUiConfigDto,
    current: &WorkspaceUiConfigDto,
) {
    requested.window.placement = current.window.placement.clone();
}

#[cfg(test)]
mod tests;
