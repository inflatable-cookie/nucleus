//! Workspace layout Tauri commands: snapshot, panel preparation, layout
//! mutation, and project context updates, with layout-change events.
//!
//! Split from the lib.rs god file; behavior unchanged.

use tauri::Emitter;

use crate::workspace_ui;
use crate::DesktopState;

const WORKSPACE_LAYOUT_CHANGED_EVENT: &str = "nucleus://workspace-layout";

#[tauri::command]
pub(crate) async fn workspace_layout_snapshot(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
) -> Result<workspace_ui::WorkspaceLayoutSnapshotDto, String> {
    let runtime = state.workspace_ui.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.snapshot(&project_id))
        .await
        .map_err(|_| "desktop layout snapshot worker failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn prepare_workspace_panel(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    presentation: workspace_ui::WorkspacePanelPresentationInputDto,
) -> Result<workspace_ui::WorkspacePreparedPanelDto, String> {
    let runtime = state.workspace_ui.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.prepare_panel(&project_id, presentation))
        .await
        .map_err(|_| "desktop panel preparation worker failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn mutate_workspace_layout(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    mutation: workspace_ui::WorkspaceLayoutMutationDto,
) -> Result<workspace_ui::WorkspaceLayoutMutationResponseDto, String> {
    let runtime = state.workspace_ui.clone();
    let response =
        tauri::async_runtime::spawn_blocking(move || runtime.dispatch(&project_id, mutation))
            .await
            .map_err(|_| "desktop layout command worker failed".to_owned())??;
    app.emit(WORKSPACE_LAYOUT_CHANGED_EVENT, response.snapshot.clone())
        .map_err(|error| format!("emit desktop layout snapshot failed: {error}"))?;
    Ok(response)
}

#[tauri::command]
pub(crate) async fn update_workspace_panel_presentation(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    panel_instance_id: String,
    presentation: workspace_ui::WorkspacePanelPresentationInputDto,
) -> Result<workspace_ui::WorkspaceLayoutSnapshotDto, String> {
    let runtime = state.workspace_ui.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        runtime.update_panel_presentation(&project_id, &panel_instance_id, presentation)
    })
    .await
    .map_err(|_| "desktop panel presentation worker failed".to_owned())??;
    app.emit(WORKSPACE_LAYOUT_CHANGED_EVENT, snapshot.clone())
        .map_err(|error| format!("emit desktop layout snapshot failed: {error}"))?;
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn update_workspace_project_context(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    context: workspace_ui::WorkspaceProjectContextDto,
) -> Result<workspace_ui::WorkspaceLayoutSnapshotDto, String> {
    let runtime = state.workspace_ui.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        runtime.update_project_context(&project_id, context)
    })
    .await
    .map_err(|_| "desktop workspace context worker failed".to_owned())??;
    app.emit(WORKSPACE_LAYOUT_CHANGED_EVENT, snapshot.clone())
        .map_err(|error| format!("emit desktop layout snapshot failed: {error}"))?;
    Ok(snapshot)
}
