use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

use longhorn_core::{
    ClientPoint, ClientRect, ClientSize, NativeContentRequestId, RoundingMode, ScaleFactor,
    WindowId,
};
use longhorn_native_content::{
    AttachGeneration, DesiredPresence, DesiredState, DesiredUpdate, DesiredVisibility, FocusIntent,
    InputRoutingMode, NativeContentAuthorityEpoch, NativeContentConnectRequest,
    NativeContentConnectResult, NativeContentContentSizeDecisionRequest,
    NativeContentContentSizeDecisionResult, NativeContentCoordinator,
    NativeContentDesiredUpdateRequest, NativeContentDesiredUpdateResult, NativeContentIslandId,
    NativeContentKindId, NativeContentProtocolVersion, NativeContentSnapshotRequest,
    NativeContentSnapshotResult, VisibilityReasonId,
};
use longhorn_tauri_native_content_child_view::{
    ChildViewAdapter, ChildViewAdapterEvent, ChildViewLabel, ChildViewPolicyEvent,
    ChildViewPolicyHooks, ChildViewSpec, TauriChildViewRuntime, CHILD_VIEW_CAPABILITIES,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Url, Wry};

const ISLAND_ID_PREFIX: &str = "island:nucleus-browser:";
const WEBVIEW_LABEL_PREFIX: &str = "nucleus-browser-";
const BROWSER_STATE_EVENT: &str = "nucleus://browser-state";
const NATIVE_CONTENT_CHANGED_EVENT: &str = "longhorn://native-content/changed";
const NATIVE_CONTENT_EVIDENCE_EVENT: &str = "nucleus://browser-native-content-evidence";
const HOST_WINDOW_ID: &str = "window:nucleus-main";
const HOST_WINDOW_LABEL: &str = "main";
const DEFAULT_BROWSER_URL: &str = "https://example.com";

#[cfg(target_os = "macos")]
const CURSOR_TITLE_PREFIX: &str = "__NUCLEUS_CURSOR__:";
#[cfg(target_os = "macos")]
const CURSOR_BRIDGE_SCRIPT: &str = r#"
(() => {
  const prefix = "__NUCLEUS_CURSOR__:";
  let lastCursor = "";
  const normalizeCursor = (target) => {
    if (!(target instanceof Element)) return "default";
    let cursor = getComputedStyle(target).cursor || "default";
    if (cursor.includes(",")) cursor = cursor.slice(cursor.lastIndexOf(",") + 1).trim();
    if (cursor === "auto") {
      if (target.closest("a[href], area[href], [role='link']")) return "pointer";
      return "default";
    }
    return cursor;
  };
  const report = (target) => {
    const cursor = normalizeCursor(target);
    if (cursor === lastCursor) return;
    lastCursor = cursor;
    document.title = prefix + cursor;
  };
  addEventListener("pointermove", (event) => report(event.target), { capture: true, passive: true });
  addEventListener("pointerover", (event) => report(event.target), { capture: true, passive: true });
  addEventListener("pointerout", (event) => {
    if (!event.relatedTarget) report(null);
  }, { capture: true, passive: true });
})();
"#;

type Adapter = ChildViewAdapter<TauriChildViewRuntime<Wry>>;

struct BrowserIsland {
    host: longhorn_native_content::NativeContentProtocolHost,
    adapter: Adapter,
}

struct BrowserPanelRuntimeInner {
    islands: HashMap<NativeContentIslandId, BrowserIsland>,
    last_generation: HashMap<NativeContentIslandId, AttachGeneration>,
}

#[derive(Clone)]
pub struct BrowserPanelRuntime {
    app: AppHandle<Wry>,
    inner: Arc<Mutex<BrowserPanelRuntimeInner>>,
}

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

impl BrowserPanelRuntime {
    fn new(app: AppHandle<Wry>) -> Self {
        Self {
            app,
            inner: Arc::new(Mutex::new(BrowserPanelRuntimeInner {
                islands: HashMap::new(),
                last_generation: HashMap::new(),
            })),
        }
    }

    fn ensure_island(&self, island_id: &NativeContentIslandId) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "browser runtime is unavailable")?;
        if inner.islands.contains_key(island_id) {
            return Ok(());
        }
        let generation = inner
            .last_generation
            .get(island_id)
            .copied()
            .map(|value| value.checked_next())
            .transpose()
            .map_err(string_error)?
            .unwrap_or(AttachGeneration::INITIAL);
        let island = self.create_island(island_id.clone(), generation)?;
        inner.last_generation.insert(island_id.clone(), generation);
        inner.islands.insert(island_id.clone(), island);
        Ok(())
    }

    fn create_island(
        &self,
        island_id: NativeContentIslandId,
        generation: AttachGeneration,
    ) -> Result<BrowserIsland, String> {
        validate_island_id(&island_id)?;
        let source = normalize_http_url(DEFAULT_BROWSER_URL)?;
        let app = self.app.clone();
        let observation_app = self.app.clone();
        let weak_inner = Arc::downgrade(&self.inner);
        let observed_island_id = island_id.clone();
        let policy_hooks = ChildViewPolicyHooks::new(
            cursor_initialization_script(),
            Arc::new(move |event| {
                emit_policy_event(&app, &observed_island_id, event.clone());
                if matches!(event, ChildViewPolicyEvent::PageLoadFinished { .. }) {
                    queue_observation_refresh(
                        observation_app.clone(),
                        weak_inner.clone(),
                        observed_island_id.clone(),
                    );
                }
            }),
        )
        .map_err(string_error)?;
        let host_window_id = WindowId::new(HOST_WINDOW_ID).map_err(string_error)?;
        let spec = ChildViewSpec::new(
            island_id.clone(),
            host_window_id.clone(),
            ChildViewLabel::new(HOST_WINDOW_LABEL).map_err(string_error)?,
            child_label(&island_id)?,
            source,
            None,
            Arc::new(is_supported_http_url),
            policy_hooks,
        )
        .map_err(string_error)?;
        let evidence_app = self.app.clone();
        let evidence_island_id = island_id.clone();
        let adapter = ChildViewAdapter::new(
            TauriChildViewRuntime::new(self.app.clone()),
            spec,
            Arc::new(move |event: ChildViewAdapterEvent| {
                emit_evidence(&evidence_app, &evidence_island_id, "adapter", event);
            }),
        );
        let desired = DesiredState::new(
            island_id,
            NativeContentKindId::new("nucleus:browser").map_err(string_error)?,
            CHILD_VIEW_CAPABILITIES,
            DesiredUpdate::new(
                generation,
                host_window_id,
                ClientRect::new(
                    ClientPoint::new(0.0, 0.0).map_err(string_error)?,
                    ClientSize::new(1.0, 1.0).map_err(string_error)?,
                ),
                ScaleFactor::from_thousandths(1000).map_err(string_error)?,
                RoundingMode::Nearest,
                DesiredPresence::Present,
                DesiredVisibility::Hidden {
                    reason: VisibilityReasonId::new("nucleus:bootstrap").map_err(string_error)?,
                },
                FocusIntent::Unchanged,
                InputRoutingMode::NativeDirect,
            ),
        )
        .map_err(string_error)?;
        Ok(BrowserIsland {
            host: longhorn_native_content::NativeContentProtocolHost::new(
                NativeContentAuthorityEpoch::new(1).map_err(string_error)?,
                NativeContentCoordinator::new(desired),
            ),
            adapter,
        })
    }

    fn connect(
        &self,
        request: NativeContentConnectRequest,
    ) -> Result<NativeContentConnectResult, String> {
        self.ensure_island(&request.island_id)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "browser runtime is unavailable")?;
        let island = inner
            .islands
            .get_mut(&request.island_id)
            .ok_or("browser island is unavailable")?;
        Ok(island.host.connect(request))
    }

    fn snapshot(
        &self,
        request: NativeContentSnapshotRequest,
    ) -> Result<NativeContentSnapshotResult, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "browser runtime is unavailable")?;
        let island = inner
            .islands
            .get(&request.island_id)
            .ok_or("browser island is unavailable")?;
        Ok(island.host.snapshot(request))
    }

    fn update_desired(
        &self,
        request: NativeContentDesiredUpdateRequest,
    ) -> Result<NativeContentDesiredUpdateResult, String> {
        let island_id = request.island_id.clone();
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "browser runtime is unavailable")?;
        let island = inner
            .islands
            .get_mut(&island_id)
            .ok_or("browser island is unavailable")?;
        let result = island.host.update_desired(request);
        let NativeContentDesiredUpdateResult::Committed { event, .. } = &result else {
            return Ok(result);
        };
        emit_changed(&self.app, event.as_ref());
        let plan = island.host.coordinator().plan().map_err(string_error)?;
        let receipt = island
            .adapter
            .apply(island.host.coordinator(), &plan)
            .map_err(string_error)?;
        emit_evidence(&self.app, &island_id, "apply", receipt);
        admit_fresh_observation(&self.app, &island_id, island)?;
        Ok(result)
    }

    fn decide_content_size(
        &self,
        request: NativeContentContentSizeDecisionRequest,
    ) -> Result<NativeContentContentSizeDecisionResult, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "browser runtime is unavailable")?;
        let island = inner
            .islands
            .get(&request.island_id)
            .ok_or("browser island is unavailable")?;
        Ok(island.host.decide_content_size(request))
    }

    fn destroy(&self, island_id: &NativeContentIslandId) -> Result<(), String> {
        validate_island_id(island_id)?;
        let island = self
            .inner
            .lock()
            .map_err(|_| "browser runtime is unavailable")?
            .islands
            .remove(island_id);
        if let Some(island) = island {
            let receipt = island.adapter.teardown().map_err(string_error)?;
            emit_evidence(&self.app, island_id, "teardown", receipt);
        }
        reset_cursor(&self.app)
    }

    fn hide_for_unmount(&self, island_id: &NativeContentIslandId) -> Result<(), String> {
        let request = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "browser runtime is unavailable")?;
            let island = inner
                .islands
                .get(island_id)
                .ok_or("browser island is unavailable")?;
            let Some(client_epoch) = island.host.client_epoch() else {
                return Ok(());
            };
            let desired = island.host.coordinator().desired();
            NativeContentDesiredUpdateRequest {
                protocol_version: NativeContentProtocolVersion::CURRENT,
                request_id: NativeContentRequestId::new(format!(
                    "request:nucleus-browser:unmount:{}",
                    desired.revision().get(),
                ))
                .map_err(string_error)?,
                island_id: island_id.clone(),
                client_epoch,
                expected_desired_revision: desired.revision(),
                update: DesiredUpdate::new(
                    desired.generation(),
                    desired.host_window_id().clone(),
                    desired.viewport(),
                    desired.scale(),
                    desired.rounding(),
                    desired.presence(),
                    DesiredVisibility::Hidden {
                        reason: VisibilityReasonId::new("nucleus:unmounted")
                            .map_err(string_error)?,
                    },
                    desired.focus(),
                    desired.input_routing(),
                ),
            }
        };
        match self.update_desired(request)? {
            NativeContentDesiredUpdateResult::Committed { .. } => Ok(()),
            NativeContentDesiredUpdateResult::Rejected { rejection, .. } => Err(rejection.message),
        }
    }

    pub fn teardown(&self) {
        let islands = self
            .inner
            .lock()
            .map(|mut inner| inner.islands.drain().collect::<Vec<_>>())
            .unwrap_or_default();
        for (island_id, island) in islands {
            match island.adapter.teardown() {
                Ok(receipt) => emit_evidence(&self.app, &island_id, "host_teardown", receipt),
                Err(error) => emit_evidence(
                    &self.app,
                    &island_id,
                    "host_teardown_failed",
                    error.to_string(),
                ),
            }
        }
        let _ = reset_cursor(&self.app);
    }
}

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

fn admit_fresh_observation(
    app: &AppHandle,
    island_id: &NativeContentIslandId,
    island: &mut BrowserIsland,
) -> Result<(), String> {
    let generation = island.host.coordinator().desired().generation();
    let update = island.adapter.observe(generation).map_err(string_error)?;
    let expected = island.host.coordinator().observed().revision();
    let (receipt, event) = island
        .host
        .admit_observation(None, expected, update)
        .map_err(string_error)?;
    emit_evidence(app, island_id, "observation", receipt);
    if let Some(event) = event {
        emit_changed(app, &event);
    }
    Ok(())
}

fn queue_observation_refresh(
    app: AppHandle,
    inner: Weak<Mutex<BrowserPanelRuntimeInner>>,
    island_id: NativeContentIslandId,
) {
    tauri::async_runtime::spawn(async move {
        let Some(inner) = inner.upgrade() else { return };
        let Ok(mut inner) = inner.lock() else { return };
        let Some(island) = inner.islands.get_mut(&island_id) else {
            return;
        };
        if let Err(error) = admit_fresh_observation(&app, &island_id, island) {
            emit_evidence(&app, &island_id, "observation_failed", error);
        }
    });
}

fn emit_changed(app: &AppHandle, event: &longhorn_native_content::NativeContentChangedEvent) {
    let _ = app.emit_to(HOST_WINDOW_LABEL, NATIVE_CONTENT_CHANGED_EVENT, event);
}

fn emit_evidence(
    app: &AppHandle,
    island_id: &NativeContentIslandId,
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

fn emit_policy_event(
    app: &AppHandle,
    island_id: &NativeContentIslandId,
    event: ChildViewPolicyEvent,
) {
    match event {
        ChildViewPolicyEvent::PageLoadStarted { url } => {
            emit_state(app, island_id, &url, Some(true), None)
        }
        ChildViewPolicyEvent::PageLoadFinished { url } => {
            emit_state(app, island_id, &url, Some(false), None)
        }
        ChildViewPolicyEvent::PopupDenied { url } => emit_state(
            app,
            island_id,
            &url,
            None,
            Some("Popup blocked. Open the destination explicitly in this tab."),
        ),
        ChildViewPolicyEvent::DownloadDenied { url } => emit_state(
            app,
            island_id,
            &url,
            None,
            Some("Downloads are not enabled in Nucleus yet."),
        ),
        ChildViewPolicyEvent::DocumentTitleChanged { title } => {
            #[cfg(target_os = "macos")]
            if let Some(cursor) = title.strip_prefix(CURSOR_TITLE_PREFIX) {
                if let Some(icon) = cursor_icon(cursor) {
                    if let Some(window) = app.get_window(HOST_WINDOW_LABEL) {
                        let _ = window.set_cursor_icon(icon);
                    }
                }
            }
        }
    }
}

fn emit_state(
    app: &AppHandle,
    island_id: &NativeContentIslandId,
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

fn validate_island_id(island_id: &NativeContentIslandId) -> Result<(), String> {
    let value = island_id.to_string();
    let suffix = value
        .strip_prefix(ISLAND_ID_PREFIX)
        .ok_or("invalid browser island id")?;
    if suffix.is_empty()
        || !suffix
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-/:_.".contains(character))
    {
        return Err("invalid browser island id".to_owned());
    }
    Ok(())
}

fn child_label(island_id: &NativeContentIslandId) -> Result<ChildViewLabel, String> {
    validate_island_id(island_id)?;
    let value = island_id.to_string();
    let suffix = value
        .strip_prefix(ISLAND_ID_PREFIX)
        .expect("validated browser island prefix");
    ChildViewLabel::new(format!("{WEBVIEW_LABEL_PREFIX}{suffix}")).map_err(string_error)
}

fn normalize_http_url(input: &str) -> Result<Url, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("enter a URL".to_owned());
    }
    let candidate = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&candidate).map_err(|_| "enter a valid URL".to_owned())?;
    if !is_supported_http_url(&url) {
        return Err("only HTTP and HTTPS URLs are supported".to_owned());
    }
    Ok(url)
}

fn is_supported_http_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
}

fn cursor_initialization_script() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        Some(CURSOR_BRIDGE_SCRIPT.to_owned())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn reset_cursor(app: &AppHandle) -> Result<(), String> {
    app.get_window(HOST_WINDOW_LABEL)
        .ok_or_else(|| "main window is not available".to_owned())?
        .set_cursor_icon(tauri::CursorIcon::Default)
        .map_err(|error| format!("browser cursor reset failed: {error}"))
}

#[cfg(target_os = "macos")]
fn cursor_icon(cursor: &str) -> Option<tauri::CursorIcon> {
    use tauri::CursorIcon;
    Some(match cursor {
        "auto" | "default" => CursorIcon::Default,
        "pointer" => CursorIcon::Hand,
        "crosshair" => CursorIcon::Crosshair,
        "move" => CursorIcon::Move,
        "text" => CursorIcon::Text,
        "vertical-text" => CursorIcon::VerticalText,
        "wait" => CursorIcon::Wait,
        "help" => CursorIcon::Help,
        "progress" => CursorIcon::Progress,
        "not-allowed" => CursorIcon::NotAllowed,
        "context-menu" => CursorIcon::ContextMenu,
        "cell" => CursorIcon::Cell,
        "alias" => CursorIcon::Alias,
        "copy" => CursorIcon::Copy,
        "no-drop" => CursorIcon::NoDrop,
        "grab" => CursorIcon::Grab,
        "grabbing" => CursorIcon::Grabbing,
        "all-scroll" => CursorIcon::AllScroll,
        "zoom-in" => CursorIcon::ZoomIn,
        "zoom-out" => CursorIcon::ZoomOut,
        "e-resize" => CursorIcon::EResize,
        "n-resize" => CursorIcon::NResize,
        "ne-resize" => CursorIcon::NeResize,
        "nw-resize" => CursorIcon::NwResize,
        "s-resize" => CursorIcon::SResize,
        "se-resize" => CursorIcon::SeResize,
        "sw-resize" => CursorIcon::SwResize,
        "w-resize" => CursorIcon::WResize,
        "ew-resize" => CursorIcon::EwResize,
        "ns-resize" => CursorIcon::NsResize,
        "nesw-resize" => CursorIcon::NeswResize,
        "nwse-resize" => CursorIcon::NwseResize,
        "col-resize" => CursorIcon::ColResize,
        "row-resize" => CursorIcon::RowResize,
        _ => return None,
    })
}

fn string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::{child_label, is_supported_http_url, normalize_http_url, validate_island_id};
    use longhorn_native_content::NativeContentIslandId;

    fn island(value: &str) -> NativeContentIslandId {
        NativeContentIslandId::new(value).expect("test island id should be valid")
    }

    #[test]
    fn browser_urls_default_to_https_and_reject_untrusted_schemes() {
        assert_eq!(
            normalize_http_url("example.com/path").unwrap().as_str(),
            "https://example.com/path"
        );
        assert!(normalize_http_url("file:///tmp/secret").is_err());
        assert!(normalize_http_url("javascript:alert(1)").is_err());
        assert!(normalize_http_url("about:blank").is_err());
    }

    #[test]
    fn child_navigation_remains_on_http() {
        assert!(is_supported_http_url(
            &"https://example.com".parse().unwrap()
        ));
        assert!(!is_supported_http_url(
            &"file:///tmp/secret".parse().unwrap()
        ));
    }

    #[test]
    fn browser_island_ids_map_to_independent_transport_labels() {
        let id = island("island:nucleus-browser:browser:main:1");
        assert!(validate_island_id(&id).is_ok());
        assert_eq!(
            child_label(&id).unwrap().as_str(),
            "nucleus-browser-browser:main:1"
        );
        assert!(validate_island_id(&island("island:foreign:browser:main:1")).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cursor_bridge_accepts_only_known_cursor_names() {
        assert_eq!(super::cursor_icon("pointer"), Some(tauri::CursorIcon::Hand));
        assert_eq!(super::cursor_icon("text"), Some(tauri::CursorIcon::Text));
        assert_eq!(super::cursor_icon("url(javascript:bad)"), None);
    }
}
