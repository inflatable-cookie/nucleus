//! Browser panel host: native-content child views for the embedded browser.
//!
//! Module index over the browser surface: the runtime host, Tauri commands,
//! event emission, cursor bridging, and URL/island validation.

pub(crate) mod commands;
mod cursor;
mod events;
mod runtime;
mod url;
#[cfg(test)]
mod tests;

pub use commands::install;
pub use runtime::BrowserPanelRuntime;

const ISLAND_ID_PREFIX: &str = "island:nucleus-browser:";
const WEBVIEW_LABEL_PREFIX: &str = "nucleus-browser-";
const BROWSER_STATE_EVENT: &str = "nucleus://browser-state";
const NATIVE_CONTENT_CHANGED_EVENT: &str = "longhorn://native-content/changed";
const NATIVE_CONTENT_EVIDENCE_EVENT: &str = "nucleus://browser-native-content-evidence";
const HOST_WINDOW_ID: &str = "window:nucleus-main";
const HOST_WINDOW_LABEL: &str = "main";
const DEFAULT_BROWSER_URL: &str = "https://example.com";
