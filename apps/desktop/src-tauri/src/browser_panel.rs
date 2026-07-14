use serde::{Deserialize, Serialize};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};

const WEBVIEW_LABEL_PREFIX: &str = "nucleus-browser-";
const BROWSER_STATE_EVENT: &str = "nucleus://browser-state";
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

#[derive(Debug, Deserialize)]
pub struct BrowserPanelBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPanelStateEvent {
    label: String,
    url: String,
    loading: Option<bool>,
    notice: Option<&'static str>,
}

#[tauri::command]
pub async fn browser_panel_ensure(
    app: AppHandle,
    label: String,
    url: String,
    bounds: BrowserPanelBounds,
) -> Result<String, String> {
    validate_label(&label)?;
    validate_bounds(&bounds)?;

    if let Some(webview) = app.get_webview(&label) {
        return webview
            .url()
            .map(|url| url.to_string())
            .map_err(|error| format!("browser URL read failed: {error}"));
    }

    let url = normalize_http_url(&url)?;
    let page_load_app = app.clone();
    let popup_app = app.clone();
    let popup_label = label.clone();
    let download_app = app.clone();
    let download_label = label.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url.clone()))
        .focused(false)
        .disable_drag_drop_handler()
        .on_navigation(is_supported_http_url)
        .on_page_load(move |webview, payload| {
            emit_state(
                &page_load_app,
                webview.label(),
                payload.url(),
                Some(matches!(payload.event(), PageLoadEvent::Started)),
                None,
            );
        })
        .on_new_window(move |url, _| {
            emit_state(
                &popup_app,
                &popup_label,
                &url,
                None,
                Some("Popup blocked. Open the destination explicitly in this tab."),
            );
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| {
            if let DownloadEvent::Requested { url, .. } = event {
                emit_state(
                    &download_app,
                    &download_label,
                    &url,
                    None,
                    Some("Downloads are not enabled in Nucleus yet."),
                );
            }
            false
        });
    #[cfg(target_os = "macos")]
    let builder = builder
        .initialization_script(CURSOR_BRIDGE_SCRIPT)
        .on_document_title_changed(|webview, title| {
            let Some(cursor) = title.strip_prefix(CURSOR_TITLE_PREFIX) else {
                return;
            };
            if let Some(icon) = cursor_icon(cursor) {
                let _ = webview.window().set_cursor_icon(icon);
            }
        });

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is not available".to_owned())?;
    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| format!("browser view creation failed: {error}"))?;

    Ok(url.to_string())
}

#[tauri::command]
pub fn browser_panel_set_bounds(
    app: AppHandle,
    label: String,
    bounds: BrowserPanelBounds,
) -> Result<(), String> {
    validate_label(&label)?;
    validate_bounds(&bounds)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser view is not available".to_owned())?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| format!("browser position update failed: {error}"))?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| format!("browser size update failed: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn browser_panel_reset_cursor(app: AppHandle, label: String) -> Result<(), String> {
    validate_label(&label)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser view is not available".to_owned())?;
    webview
        .window()
        .set_cursor_icon(tauri::CursorIcon::Default)
        .map_err(|error| format!("browser cursor reset failed: {error}"))
}

#[tauri::command]
pub fn browser_panel_navigate(
    app: AppHandle,
    label: String,
    url: String,
) -> Result<String, String> {
    validate_label(&label)?;
    let url = normalize_http_url(&url)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser view is not available".to_owned())?;
    webview
        .navigate(url.clone())
        .map_err(|error| format!("browser navigation failed: {error}"))?;
    Ok(url.to_string())
}

#[tauri::command]
pub fn browser_panel_action(app: AppHandle, label: String, action: String) -> Result<(), String> {
    validate_label(&label)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser view is not available".to_owned())?;

    match action.as_str() {
        "back" => webview.eval("history.back()"),
        "forward" => webview.eval("history.forward()"),
        "reload" => webview.reload(),
        _ => return Err("unsupported browser action".to_owned()),
    }
    .map_err(|error| format!("browser action failed: {error}"))
}

#[tauri::command]
pub fn browser_panel_current_url(app: AppHandle, label: String) -> Result<String, String> {
    validate_label(&label)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser view is not available".to_owned())?;
    webview
        .url()
        .map(|url| url.to_string())
        .map_err(|error| format!("browser URL read failed: {error}"))
}

fn validate_label(label: &str) -> Result<(), String> {
    if label.starts_with(WEBVIEW_LABEL_PREFIX)
        && label.len() > WEBVIEW_LABEL_PREFIX.len()
        && label
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-/:_".contains(character))
    {
        Ok(())
    } else {
        Err("invalid browser view label".to_owned())
    }
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

    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("only HTTP and HTTPS URLs are supported".to_owned());
    }

    Ok(url)
}

fn is_supported_http_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
}

fn validate_bounds(bounds: &BrowserPanelBounds) -> Result<(), String> {
    if bounds.x.is_finite()
        && bounds.y.is_finite()
        && bounds.width.is_finite()
        && bounds.height.is_finite()
        && bounds.width >= 1.0
        && bounds.height >= 1.0
    {
        Ok(())
    } else {
        Err("invalid browser viewport bounds".to_owned())
    }
}

fn emit_state(
    app: &AppHandle,
    label: &str,
    url: &Url,
    loading: Option<bool>,
    notice: Option<&'static str>,
) {
    let _ = app.emit_to(
        "main",
        BROWSER_STATE_EVENT,
        BrowserPanelStateEvent {
            label: label.to_owned(),
            url: url.to_string(),
            loading,
            notice,
        },
    );
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

#[cfg(test)]
mod tests {
    use super::{
        is_supported_http_url, normalize_http_url, validate_bounds, validate_label,
        BrowserPanelBounds,
    };

    #[test]
    fn browser_urls_default_to_https() {
        assert_eq!(
            normalize_http_url("example.com/path")
                .expect("URL should normalize")
                .as_str(),
            "https://example.com/path"
        );
    }

    #[test]
    fn browser_urls_reject_untrusted_schemes() {
        assert!(normalize_http_url("file:///tmp/secret").is_err());
        assert!(normalize_http_url("javascript:alert(1)").is_err());
        assert!(normalize_http_url("about:blank").is_err());
    }

    #[test]
    fn browser_commands_only_target_browser_labels() {
        assert!(validate_label("nucleus-browser-browser:main:1").is_ok());
        assert!(validate_label("main").is_err());
        assert!(validate_label("nucleus-browser-").is_err());
        assert!(validate_label("nucleus-browser-bad label").is_err());
    }

    #[test]
    fn child_navigation_remains_on_http() {
        assert!(is_supported_http_url(
            &"https://example.com".parse().expect("URL should parse")
        ));
        assert!(!is_supported_http_url(
            &"file:///tmp/secret".parse().expect("URL should parse")
        ));
        assert!(!is_supported_http_url(
            &"about:blank".parse().expect("URL should parse")
        ));
    }

    #[test]
    fn child_bounds_must_be_visible_and_finite() {
        assert!(validate_bounds(&BrowserPanelBounds {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        })
        .is_ok());
        assert!(validate_bounds(&BrowserPanelBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: f64::NAN,
        })
        .is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cursor_bridge_accepts_only_known_cursor_names() {
        assert_eq!(super::cursor_icon("pointer"), Some(tauri::CursorIcon::Hand));
        assert_eq!(super::cursor_icon("text"), Some(tauri::CursorIcon::Text));
        assert_eq!(super::cursor_icon("url(javascript:bad)"), None);
    }
}
