//! Browser panel Tauri commands and runtime installation.
//!
//! Split from the browser_panel god file; behavior unchanged.

use longhorn_native_content::{
    NativeContentConnectRequest, NativeContentConnectResult,
    NativeContentContentSizeDecisionRequest, NativeContentContentSizeDecisionResult,
    NativeContentDesiredUpdateRequest, NativeContentDesiredUpdateResult, NativeContentIslandId,
    NativeContentSnapshotRequest, NativeContentSnapshotResult,
};
use tauri::{AppHandle, Manager, Wry};

use super::cursor::reset_cursor;
use super::runtime::BrowserPanelRuntime;
use super::url::{child_label, normalize_http_url, validate_island_id};

pub fn install(app: &mut tauri::App<Wry>) {
    app.manage(BrowserPanelRuntime::new(app.handle().clone()));
}

#[tauri::command]
pub fn longhorn_native_content_connect(
    state: tauri::State<'_, BrowserPanelRuntime>,
    request: NativeContentConnectRequest,
) -> Result<NativeContentConnectResult, String> {
    state.connect(request)
}

#[tauri::command]
pub fn longhorn_native_content_snapshot(
    state: tauri::State<'_, BrowserPanelRuntime>,
    request: NativeContentSnapshotRequest,
) -> Result<NativeContentSnapshotResult, String> {
    state.snapshot(request)
}

#[tauri::command]
pub fn longhorn_native_content_update_desired(
    state: tauri::State<'_, BrowserPanelRuntime>,
    request: NativeContentDesiredUpdateRequest,
) -> Result<NativeContentDesiredUpdateResult, String> {
    state.update_desired(request)
}

#[tauri::command]
pub fn longhorn_native_content_decide_size(
    state: tauri::State<'_, BrowserPanelRuntime>,
    request: NativeContentContentSizeDecisionRequest,
) -> Result<NativeContentContentSizeDecisionResult, String> {
    state.decide_content_size(request)
}

#[tauri::command]
pub fn browser_panel_destroy(
    state: tauri::State<'_, BrowserPanelRuntime>,
    island_id: NativeContentIslandId,
) -> Result<(), String> {
    state.destroy(&island_id)
}

#[tauri::command]
pub fn browser_panel_hide_for_unmount(
    state: tauri::State<'_, BrowserPanelRuntime>,
    island_id: NativeContentIslandId,
) -> Result<(), String> {
    state.hide_for_unmount(&island_id)
}

#[tauri::command]
pub fn browser_panel_reset_cursor(
    app: AppHandle,
    island_id: NativeContentIslandId,
) -> Result<(), String> {
    validate_island_id(&island_id)?;
    reset_cursor(&app)
}

#[tauri::command]
pub fn browser_panel_navigate(
    app: AppHandle,
    island_id: NativeContentIslandId,
    url: String,
) -> Result<String, String> {
    let url = normalize_http_url(&url)?;
    browser_webview(&app, &island_id)?
        .navigate(url.clone())
        .map_err(|error| format!("browser navigation failed: {error}"))?;
    Ok(url.to_string())
}

#[tauri::command]
pub fn browser_panel_action(
    app: AppHandle,
    island_id: NativeContentIslandId,
    action: String,
) -> Result<(), String> {
    let webview = browser_webview(&app, &island_id)?;
    match action.as_str() {
        "back" => webview.eval("history.back()"),
        "forward" => webview.eval("history.forward()"),
        "reload" => webview.reload(),
        _ => return Err("unsupported browser action".to_owned()),
    }
    .map_err(|error| format!("browser action failed: {error}"))
}

#[tauri::command]
pub fn browser_panel_current_url(
    app: AppHandle,
    island_id: NativeContentIslandId,
) -> Result<String, String> {
    browser_webview(&app, &island_id)?
        .url()
        .map(|url| url.to_string())
        .map_err(|error| format!("browser URL read failed: {error}"))
}

fn browser_webview(
    app: &AppHandle,
    island_id: &NativeContentIslandId,
) -> Result<tauri::Webview<Wry>, String> {
    validate_island_id(island_id)?;
    app.get_webview(child_label(island_id)?.as_str())
        .ok_or_else(|| "browser view is not available".to_owned())
}
