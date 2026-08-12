//! Browser panel URL and island identity validation.
//!
//! Split from the browser_panel god file; behavior unchanged.

use longhorn_tauri_native_content_child_view::ChildViewLabel;
use tauri::Url;

use super::{ISLAND_ID_PREFIX, WEBVIEW_LABEL_PREFIX};

pub(super) fn validate_island_id(
    island_id: &longhorn_native_content::NativeContentIslandId,
) -> Result<(), String> {
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

pub(super) fn child_label(
    island_id: &longhorn_native_content::NativeContentIslandId,
) -> Result<ChildViewLabel, String> {
    validate_island_id(island_id)?;
    let value = island_id.to_string();
    let suffix = value
        .strip_prefix(ISLAND_ID_PREFIX)
        .expect("validated browser island prefix");
    ChildViewLabel::new(format!("{WEBVIEW_LABEL_PREFIX}{suffix}")).map_err(string_error)
}

pub(super) fn normalize_http_url(input: &str) -> Result<Url, String> {
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

pub(super) fn is_supported_http_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
}

pub(super) fn string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
