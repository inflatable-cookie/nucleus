//! Editor file Tauri commands: list, search, directory, read, save, create,
//! rename, and delete over the editor file domain.
//!
//! Split from the lib.rs god file; behavior unchanged.

use nucleus_server::{
    EditorDirectoryEntry, EditorFileCreateRequest, EditorFileDeleteReceipt, EditorFileDeleteRequest,
    EditorFileEntry, EditorFileRenameRequest, EditorFileSaveRequest, EditorFileSnapshot,
};

use crate::{editor_drafts, DesktopState};

#[tauri::command]
pub(crate) async fn list_editor_files(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    resource_id: Option<String>,
) -> Result<Vec<EditorFileEntry>, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::list_editor_files(&server_state, &project_id, resource_id.as_deref())
    })
    .await
    .map_err(|_| "desktop editor worker failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn search_editor_files(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    resource_id: Option<String>,
    query: String,
    limit: usize,
) -> Result<Vec<EditorFileEntry>, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::search_editor_files(
            &server_state,
            &project_id,
            resource_id.as_deref(),
            &query,
            limit,
        )
    })
    .await
    .map_err(|_| "desktop editor search worker failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn list_editor_directory(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    resource_id: Option<String>,
    directory_path: Option<String>,
) -> Result<Vec<EditorDirectoryEntry>, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::list_editor_directory(
            &server_state,
            &project_id,
            resource_id.as_deref(),
            directory_path.as_deref(),
        )
    })
    .await
    .map_err(|_| "desktop editor directory worker failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn read_editor_file(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    resource_id: Option<String>,
    file_ref: String,
    display_path: Option<String>,
) -> Result<EditorFileSnapshot, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || match display_path {
        Some(display_path) => nucleus_server::read_editor_file_at_path(
            &server_state,
            &project_id,
            resource_id.as_deref(),
            &file_ref,
            &display_path,
        ),
        None => nucleus_server::read_editor_file(
            &server_state,
            &project_id,
            resource_id.as_deref(),
            &file_ref,
        ),
    })
    .await
    .map_err(|_| "desktop editor worker failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn save_editor_file(
    state: tauri::State<'_, DesktopState>,
    request: EditorFileSaveRequest,
) -> Result<EditorFileSnapshot, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::save_editor_file(&server_state, &request)
    })
    .await
    .map_err(|_| "desktop editor worker failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn create_editor_file(
    state: tauri::State<'_, DesktopState>,
    request: EditorFileCreateRequest,
) -> Result<EditorFileSnapshot, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::create_editor_file(&server_state, &request)
    })
    .await
    .map_err(|_| "desktop editor create worker failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn rename_editor_file(
    state: tauri::State<'_, DesktopState>,
    request: EditorFileRenameRequest,
) -> Result<EditorFileSnapshot, String> {
    let server_state = state.server_state.clone();
    let drafts_path = state.editor_drafts_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let renamed = nucleus_server::rename_editor_file(&server_state, &request)?;
        if let Err(error) = editor_drafts::move_file_draft(
            &drafts_path,
            &request.project_id,
            request
                .resource_id
                .as_deref()
                .unwrap_or(&renamed.resource_id),
            &request.file_ref,
            &renamed,
        ) {
            eprintln!("move editor recovery draft after rename failed: {error}");
        }
        Ok(renamed)
    })
    .await
    .map_err(|_| "desktop editor rename worker failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn delete_editor_file(
    state: tauri::State<'_, DesktopState>,
    request: EditorFileDeleteRequest,
) -> Result<EditorFileDeleteReceipt, String> {
    let server_state = state.server_state.clone();
    let drafts_path = state.editor_drafts_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deleted = nucleus_server::delete_editor_file(&server_state, &request)?;
        if let Err(error) = editor_drafts::delete_file_draft(
            &drafts_path,
            &deleted.project_id,
            &deleted.resource_id,
            &deleted.file_ref,
        ) {
            eprintln!("delete editor recovery draft after file removal failed: {error}");
        }
        Ok(deleted)
    })
    .await
    .map_err(|_| "desktop editor delete worker failed".to_owned())?
}
