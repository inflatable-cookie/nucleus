use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::*;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestorePreparationDto {
    request_id: String,
    archive_sha256: String,
    domains: Vec<String>,
    confirmation_digest: String,
    restart_required: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RestoreConfirmationDto {
    request_id: String,
    archive_sha256: String,
    confirmation_digest: String,
}

pub(crate) struct NucleusRestoreState {
    profile: DesktopProfile,
    selection: std::sync::Mutex<Option<PreparedRestoreSelection>>,
}

impl NucleusRestoreState {
    fn new(profile: DesktopProfile) -> Self {
        Self {
            profile,
            selection: std::sync::Mutex::new(None),
        }
    }
}

pub(in crate::config_operations) fn install(app: &tauri::App, profile: DesktopProfile) {
    app.manage(NucleusRestoreState::new(profile));
}

#[tauri::command]
pub(crate) async fn nucleus_config_restore_prepare(
    window: WebviewWindow,
    state: tauri::State<'_, NucleusRestoreState>,
) -> Result<Option<RestorePreparationDto>, String> {
    authorize(&window)?;
    if let Ok(mut selection) = state.selection.lock() {
        *selection = None;
    }
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose Nucleus backup to restore")
        .pick_file(move |selected| {
            let _ = sender.try_send(selected);
        });
    let Some(selected) = receiver.recv().await else {
        return Err("restore picker closed without a result".to_owned());
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("restore picker path is invalid: {error}"))?;
    let profile = state.profile.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || prepare_selection(&profile, &path))
        .await
        .map_err(|error| format!("restore inspection worker failed: {error}"))??;
    let dto = RestorePreparationDto {
        request_id: prepared.request_id.clone(),
        archive_sha256: prepared.archive_sha256.clone(),
        domains: prepared.domains.clone(),
        confirmation_digest: prepared.confirmation_digest.clone(),
        restart_required: true,
    };
    *state
        .selection
        .lock()
        .map_err(|_| "restore selection lock is poisoned".to_owned())? = Some(prepared);
    Ok(Some(dto))
}

#[tauri::command]
pub(crate) fn nucleus_config_restore_status(
    window: WebviewWindow,
    state: tauri::State<'_, NucleusRestoreState>,
) -> Result<Option<RestoreBootReceipt>, String> {
    authorize(&window)?;
    read_receipt(&state.profile)
}

#[tauri::command]
pub(crate) async fn nucleus_config_restore_confirm(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, NucleusRestoreState>,
    confirmation: RestoreConfirmationDto,
) -> Result<(), String> {
    authorize(&window)?;
    let selection = state
        .selection
        .lock()
        .map_err(|_| "restore selection lock is poisoned".to_owned())?
        .take()
        .ok_or_else(|| "restore selection expired".to_owned())?;
    if confirmation.request_id != selection.request_id
        || confirmation.archive_sha256 != selection.archive_sha256
        || confirmation.confirmation_digest != selection.confirmation_digest
    {
        return Err("restore confirmation does not match inspected evidence".to_owned());
    }
    let profile = state.profile.clone();
    tauri::async_runtime::spawn_blocking(move || schedule_selection(&profile, &selection))
        .await
        .map_err(|error| format!("restore scheduling worker failed: {error}"))??;
    app.request_restart();
    Ok(())
}

fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("restore commands are not authorized for this window".to_owned())
    }
}
