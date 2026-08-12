//! Browser panel tests, split from the browser_panel god file; behavior
//! unchanged.

use super::cursor::cursor_icon;
use super::url::{child_label, is_supported_http_url, normalize_http_url, validate_island_id};
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
    assert_eq!(cursor_icon("pointer"), Some(tauri::CursorIcon::Hand));
    assert_eq!(cursor_icon("text"), Some(tauri::CursorIcon::Text));
    assert_eq!(cursor_icon("url(javascript:bad)"), None);
}
