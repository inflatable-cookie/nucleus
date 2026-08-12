//! Browser panel event emission: state, native-content changed, evidence,
//! and policy events to the host window.
//!
//! Split from the browser_panel god file; behavior unchanged.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url};

use super::{BROWSER_STATE_EVENT, HOST_WINDOW_LABEL, NATIVE_CONTENT_CHANGED_EVENT, NATIVE_CONTENT_EVIDENCE_EVENT};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPanelStateEvent {
    island_id: String,
    url: String,
    loading: Option<bool>,
    notice: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNativeContentEvidence {
    island_id: String,
    phase: &'static str,
    detail: serde_json::Value,
}

pub(super) fn emit_changed(app: &AppHandle, event: &longhorn_native_content::NativeContentChangedEvent) {
    let _ = app.emit_to(HOST_WINDOW_LABEL, NATIVE_CONTENT_CHANGED_EVENT, event);
}

pub(super) fn emit_evidence(
    app: &AppHandle,
    island_id: &longhorn_native_content::NativeContentIslandId,
    phase: &'static str,
    detail: impl Serialize,
) {
    let detail = serde_json::to_value(detail)
        .unwrap_or_else(|error| serde_json::json!({ "serializationError": error.to_string() }));
    let _ = app.emit_to(
        HOST_WINDOW_LABEL,
        NATIVE_CONTENT_EVIDENCE_EVENT,
        BrowserNativeContentEvidence {
            island_id: island_id.to_string(),
            phase,
            detail,
        },
    );
}

pub(super) fn emit_policy_event(
    app: &AppHandle,
    island_id: &longhorn_native_content::NativeContentIslandId,
    event: longhorn_tauri_native_content_child_view::ChildViewPolicyEvent,
) {
    match event {
        longhorn_tauri_native_content_child_view::ChildViewPolicyEvent::PageLoadStarted { url } => {
            emit_state(app, island_id, &url, Some(true), None)
        }
        longhorn_tauri_native_content_child_view::ChildViewPolicyEvent::PageLoadFinished { url } => {
            emit_state(app, island_id, &url, Some(false), None)
        }
        longhorn_tauri_native_content_child_view::ChildViewPolicyEvent::PopupDenied { url } => {
            emit_state(
                app,
                island_id,
                &url,
                None,
                Some("Popup blocked. Open the destination explicitly in this tab."),
            )
        }
        longhorn_tauri_native_content_child_view::ChildViewPolicyEvent::DownloadDenied { url } => {
            emit_state(
                app,
                island_id,
                &url,
                None,
                Some("Downloads are not enabled in Nucleus yet."),
            )
        }
        longhorn_tauri_native_content_child_view::ChildViewPolicyEvent::DocumentTitleChanged {
            title,
        } => {
            if let Some(prefix) = super::cursor::cursor_title_prefix() {
                if let Some(cursor) = title.strip_prefix(prefix) {
                    #[cfg(target_os = "macos")]
                    if let Some(icon) = super::cursor::cursor_icon(cursor) {
                        if let Some(window) = app.get_window(HOST_WINDOW_LABEL) {
                            let _ = window.set_cursor_icon(icon);
                        }
                    }
                }
            }
        }
    }
}

fn emit_state(
    app: &AppHandle,
    island_id: &longhorn_native_content::NativeContentIslandId,
    url: &Url,
    loading: Option<bool>,
    notice: Option<&'static str>,
) {
    let _ = app.emit_to(
        HOST_WINDOW_LABEL,
        BROWSER_STATE_EVENT,
        BrowserPanelStateEvent {
            island_id: island_id.to_string(),
            url: url.to_string(),
            loading,
            notice,
        },
    );
}
