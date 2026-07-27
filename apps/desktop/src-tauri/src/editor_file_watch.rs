use std::sync::Arc;

use nucleus_server::EditorFileWatchEventSink;
use tauri::ipc::Channel;

use crate::DesktopState;

#[tauri::command]
pub fn editor_file_watch_start(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    resource_ids: Vec<String>,
    on_event: Channel<nucleus_server::EditorFileWatchEvent>,
) -> Result<String, String> {
    let sink: EditorFileWatchEventSink = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    state
        .editor_file_watch
        .start(&state.server_state, &project_id, &resource_ids, sink)
}

#[tauri::command]
pub fn editor_file_watch_stop(
    state: tauri::State<'_, DesktopState>,
    subscription_id: String,
) -> Result<(), String> {
    state.editor_file_watch.stop(&subscription_id)
}
