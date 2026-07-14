use std::sync::Arc;

use tauri::ipc::Channel;

use nucleus_server::{
    TerminalEvent, TerminalEventSink, TerminalOpenRequest, TerminalSessionSnapshot,
};

use crate::DesktopState;

#[tauri::command]
pub fn terminal_open_or_attach(
    state: tauri::State<'_, DesktopState>,
    request: TerminalOpenRequest,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalSessionSnapshot, String> {
    let sink: TerminalEventSink = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    state
        .terminal
        .open_or_attach(&state.server_state, request, sink)
}

#[tauri::command]
pub fn terminal_write(
    state: tauri::State<'_, DesktopState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    state.terminal.write(&session_id, &data)
}

#[tauri::command]
pub fn terminal_resize(
    state: tauri::State<'_, DesktopState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    state.terminal.resize(&session_id, rows, cols)
}

#[tauri::command]
pub fn terminal_close(
    state: tauri::State<'_, DesktopState>,
    session_id: String,
) -> Result<(), String> {
    state.terminal.close(&session_id)
}

#[tauri::command]
pub fn terminal_close_for_panel(
    state: tauri::State<'_, DesktopState>,
    project_id: String,
    panel_id: String,
) -> Result<(), String> {
    state.terminal.close_for_panel(&project_id, &panel_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_commands_keep_paths_and_shells_out_of_client_input() {
        let request = TerminalOpenRequest {
            project_id: "project:nucleus-local".to_owned(),
            panel_id: "terminal:main".to_owned(),
            rows: 24,
            cols: 80,
        };
        let encoded = serde_json::to_string(&request).expect("encode");

        assert!(!encoded.contains("workingDirectory"));
        assert!(!encoded.contains("shell"));
        assert!(!encoded.contains("command"));
    }
}
