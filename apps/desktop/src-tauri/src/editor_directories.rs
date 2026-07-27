use nucleus_server::{
    EditorDirectoryCreateRequest, EditorDirectoryDeleteReceipt, EditorDirectoryDeleteRequest,
    EditorDirectoryReceipt, EditorDirectoryRenameReceipt, EditorDirectoryRenameRequest,
};

use crate::{editor_drafts, DesktopState};

#[tauri::command]
pub async fn create_editor_directory(
    state: tauri::State<'_, DesktopState>,
    request: EditorDirectoryCreateRequest,
) -> Result<EditorDirectoryReceipt, String> {
    let server_state = state.server_state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        nucleus_server::create_editor_directory(&server_state, &request)
    })
    .await
    .map_err(|_| "desktop editor folder create worker failed".to_owned())?
}

#[tauri::command]
pub async fn rename_editor_directory(
    state: tauri::State<'_, DesktopState>,
    request: EditorDirectoryRenameRequest,
) -> Result<EditorDirectoryRenameReceipt, String> {
    let server_state = state.server_state.clone();
    let drafts_path = state.editor_drafts_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let renamed = nucleus_server::rename_editor_directory(&server_state, &request)?;
        for moved in &renamed.files {
            if let Err(error) = editor_drafts::move_file_draft_after_directory_rename(
                &drafts_path,
                &renamed.project_id,
                &renamed.resource_id,
                moved,
            ) {
                eprintln!("move editor recovery draft after folder rename failed: {error}");
            }
        }
        Ok(renamed)
    })
    .await
    .map_err(|_| "desktop editor folder rename worker failed".to_owned())?
}

#[tauri::command]
pub async fn delete_editor_directory(
    state: tauri::State<'_, DesktopState>,
    request: EditorDirectoryDeleteRequest,
) -> Result<EditorDirectoryDeleteReceipt, String> {
    let server_state = state.server_state.clone();
    let drafts_path = state.editor_drafts_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deleted = nucleus_server::delete_editor_directory(&server_state, &request)?;
        for file in &deleted.files {
            if let Err(error) = editor_drafts::delete_file_draft(
                &drafts_path,
                &deleted.project_id,
                &deleted.resource_id,
                &file.file_ref,
            ) {
                eprintln!("delete editor recovery draft after folder removal failed: {error}");
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|_| "desktop editor folder delete worker failed".to_owned())?
}
