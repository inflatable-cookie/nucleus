//! Browser cursor bridging: the macOS cursor-report bridge script, cursor
//! name mapping, and host cursor reset.
//!
//! Split from the browser_panel god file; behavior unchanged.

use tauri::Manager;

use super::HOST_WINDOW_LABEL;

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

pub(super) fn cursor_initialization_script() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        Some(CURSOR_BRIDGE_SCRIPT.to_owned())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub(super) fn reset_cursor(app: &tauri::AppHandle) -> Result<(), String> {
    app.get_window(HOST_WINDOW_LABEL)
        .ok_or_else(|| "main window is not available".to_owned())?
        .set_cursor_icon(tauri::CursorIcon::Default)
        .map_err(|error| format!("browser cursor reset failed: {error}"))
}

pub(super) fn cursor_title_prefix() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        Some(CURSOR_TITLE_PREFIX)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
pub(super) fn cursor_icon(cursor: &str) -> Option<tauri::CursorIcon> {
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
