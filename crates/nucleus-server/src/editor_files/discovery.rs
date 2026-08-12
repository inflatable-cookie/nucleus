//! Admitted project file discovery: bounded walks, entry resolution, search
//! ranking, and the short-lived discovery cache.
//!
//! Split from the editor_files god file; behavior unchanged.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use super::types::{EditorDirectoryEntry, EditorDirectoryEntryKind, EditorFileEntry};
use super::{MAX_DISCOVERED_FILES, MAX_EDITOR_FILE_BYTES, DISCOVERY_TTL};
use crate::project_file_policy::{
    admitted_path, admitted_project_directory_walk, admitted_project_walk,
};

type DiscoveryCache = HashMap<PathBuf, (Instant, Vec<EditorFileEntry>)>;
static DISCOVERY_CACHE: OnceLock<Mutex<DiscoveryCache>> = OnceLock::new();

pub(super) fn discover(root: &Path) -> Result<Vec<EditorFileEntry>, String> {
    let mut entries = Vec::new();
    let walker = admitted_project_walk(root);
    for result in walker {
        let entry = result.map_err(|error| format!("editor file discovery failed: {error}"))?;
        let file_type = entry.file_type();
        if !file_type.is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("editor file metadata failed: {error}"))?;
        if metadata.len() > MAX_EDITOR_FILE_BYTES || !is_text_file(entry.path())? {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| "editor file escaped the project root".to_owned())?;
        let display_path = relative.to_string_lossy().replace('\\', "/");
        entries.push(EditorFileEntry {
            file_ref: file_ref(&display_path),
            language_hint: language_hint(&display_path).to_owned(),
            display_path,
            byte_size: metadata.len(),
            writable: !metadata.permissions().readonly(),
        });
        if entries.len() >= MAX_DISCOVERED_FILES {
            break;
        }
    }
    entries.sort_by(|left, right| left.display_path.cmp(&right.display_path));
    Ok(entries)
}

pub(super) fn discover_directory(
    root: &Path,
    directory_path: Option<&str>,
) -> Result<Vec<EditorDirectoryEntry>, String> {
    let directory = resolve_directory(root, directory_path)?;
    let mut entries = Vec::new();

    for result in admitted_project_directory_walk(&directory) {
        let entry =
            result.map_err(|error| format!("editor directory discovery failed: {error}"))?;
        if entry.path() == directory {
            continue;
        }
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| "editor directory entry escaped the project root".to_owned())?;
        let display_path = relative.to_string_lossy().replace('\\', "/");
        let name = entry.file_name().to_string_lossy().into_owned();

        if file_type.is_dir() {
            entries.push(EditorDirectoryEntry {
                name,
                display_path,
                kind: EditorDirectoryEntryKind::Directory,
                file: None,
            });
        } else if file_type.is_file() {
            let metadata = entry
                .metadata()
                .map_err(|error| format!("editor file metadata failed: {error}"))?;
            if metadata.len() > MAX_EDITOR_FILE_BYTES || !is_text_file(entry.path())? {
                continue;
            }
            entries.push(EditorDirectoryEntry {
                name,
                display_path: display_path.clone(),
                kind: EditorDirectoryEntryKind::File,
                file: Some(EditorFileEntry {
                    file_ref: file_ref(&display_path),
                    language_hint: language_hint(&display_path).to_owned(),
                    display_path,
                    byte_size: metadata.len(),
                    writable: !metadata.permissions().readonly(),
                }),
            });
        }

        if entries.len() >= MAX_DISCOVERED_FILES {
            break;
        }
    }

    entries.sort_by(|left, right| {
        let left_directory = left.kind == EditorDirectoryEntryKind::Directory;
        let right_directory = right.kind == EditorDirectoryEntryKind::Directory;
        right_directory
            .cmp(&left_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

fn resolve_directory(root: &Path, directory_path: Option<&str>) -> Result<PathBuf, String> {
    let directory = match directory_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        Some(path) => admitted_path(root, path)?,
        None => root.to_path_buf(),
    };
    if !directory.is_dir() {
        return Err("editor directory is unavailable".to_owned());
    }
    Ok(directory)
}

pub(super) fn resolve_entry(root: &Path, expected_ref: &str) -> Result<EditorFileEntry, String> {
    cached_discover(root)?
        .into_iter()
        .find(|entry| entry.file_ref == expected_ref)
        .ok_or_else(|| "editor file ref was not found in the admitted project files".to_owned())
}

pub(super) fn resolve_entry_at_path(
    root: &Path,
    expected_ref: &str,
    display_path: &str,
) -> Result<EditorFileEntry, String> {
    let relative = Path::new(display_path);
    if relative.is_absolute() {
        return Err("editor file path must be relative to the project resource".to_owned());
    }
    let directory_path = relative
        .parent()
        .and_then(Path::to_str)
        .filter(|path| !path.is_empty());
    discover_directory(root, directory_path)?
        .into_iter()
        .filter_map(|entry| entry.file)
        .find(|entry| entry.display_path == display_path && entry.file_ref == expected_ref)
        .ok_or_else(|| "editor file ref was not found in the admitted directory".to_owned())
}

pub(crate) fn admitted_editor_file_ref_at_path(root: &Path, display_path: &str) -> Option<String> {
    let expected_ref = file_ref(display_path);
    resolve_entry_at_path(root, &expected_ref, display_path)
        .ok()
        .map(|entry| entry.file_ref)
}

pub(super) fn editor_search_rank(display_path: &str, query: &str) -> Option<(u8, usize, usize)> {
    if query.is_empty() {
        return Some((0, 0, display_path.len()));
    }

    let path = display_path.to_lowercase();
    let name = path.rsplit('/').next().unwrap_or(path.as_str());
    let (class, position) = if name == query {
        (0, 0)
    } else if name.starts_with(query) {
        (1, 0)
    } else if let Some(position) = name.find(query) {
        (2, position)
    } else if path.starts_with(query) {
        (3, 0)
    } else if let Some(position) = path.find(query) {
        (4, position)
    } else {
        return None;
    };
    Some((class, position, display_path.len()))
}

/// Short-lived discovery cache: every open and save used to re-walk and
/// re-probe the whole project. Entries expire quickly so external file
/// changes still appear; saves go through `snapshot` re-reads regardless.
pub(super) fn cached_discover(root: &Path) -> Result<Vec<EditorFileEntry>, String> {
    let key = root.to_path_buf();
    let mut cache = DISCOVERY_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "editor discovery cache lock poisoned".to_owned())?;
    if let Some((at, entries)) = cache.get(&key) {
        if at.elapsed() < DISCOVERY_TTL {
            return Ok(entries.clone());
        }
    }
    let entries = discover(root)?;
    cache.insert(key, (Instant::now(), entries.clone()));
    Ok(entries)
}

pub(crate) fn invalidate_editor_file_discovery(root: &Path) {
    let Some(cache) = DISCOVERY_CACHE.get() else {
        return;
    };
    if let Ok(mut cache) = cache.lock() {
        cache.remove(root);
    }
}

/// Probe text-ness from a bounded prefix instead of reading whole files:
/// discovery runs this for every candidate, so full reads made listing
/// O(total repo bytes).
fn is_text_file(path: &Path) -> Result<bool, String> {
    use std::io::Read;
    const PROBE_BYTES: usize = 8 * 1024;
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("editor file probe failed: {error}"))?;
    let mut buffer = vec![0_u8; PROBE_BYTES];
    let mut filled = 0;
    while filled < PROBE_BYTES {
        let read = file
            .read(&mut buffer[filled..])
            .map_err(|error| format!("editor file probe failed: {error}"))?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    let probe = &buffer[..filled];
    if probe.contains(&0) {
        return Ok(false);
    }
    // A multi-byte UTF-8 sequence may be cut at the probe boundary; only the
    // final three bytes can be a legitimate partial sequence.
    match std::str::from_utf8(probe) {
        Ok(_) => Ok(true),
        Err(error) => Ok(filled == PROBE_BYTES && probe.len() - error.valid_up_to() < 4),
    }
}

pub(super) fn file_ref(display_path: &str) -> String {
    format!(
        "editor-file:{}",
        blake3::hash(display_path.as_bytes()).to_hex()
    )
}

pub(super) fn language_hint(path: &str) -> &str {
    match Path::new(path).extension().and_then(|value| value.to_str()) {
        Some("rs") => "rust",
        Some("js" | "mjs" | "cjs") => "javascript",
        Some("ts" | "mts" | "cts") => "typescript",
        Some("json") => "json",
        Some("html" | "svelte") => "html",
        Some("css" | "scss" | "less") => "css",
        Some("md" | "mdx") => "markdown",
        _ => "text",
    }
}
