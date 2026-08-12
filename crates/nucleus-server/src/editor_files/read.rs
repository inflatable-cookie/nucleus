//! Editor file reads and saves: list, search, directory listing, snapshot
//! reads, and atomic content-revision-checked saves.
//!
//! Split from the editor_files god file; behavior unchanged.

use std::fs;
use std::io::Write;
use std::path::Path;

use nucleus_local_store::LocalStoreBackend;

use super::discovery::{
    discover, discover_directory, resolve_entry, resolve_entry_at_path,
};
use super::types::{
    EditorDirectoryEntry, EditorFileEntry, EditorFileSaveRequest, EditorFileSnapshot,
};
use super::{MAX_EDITOR_FILE_BYTES, MAX_EDITOR_SEARCH_RESULTS};
use crate::project_resource_target::resolve_project_resource_target;
use crate::project_file_policy::admitted_path;
use crate::ServerStateService;

pub fn list_editor_files<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_id: Option<&str>,
) -> Result<Vec<EditorFileEntry>, String>
where
    B: LocalStoreBackend,
{
    let target = resolve_project_resource_target(state, project_id, resource_id)?;
    discover(&target.root)
}

pub fn search_editor_files<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_id: Option<&str>,
    query: &str,
    limit: usize,
) -> Result<Vec<EditorFileEntry>, String>
where
    B: LocalStoreBackend,
{
    let target = resolve_project_resource_target(state, project_id, resource_id)?;
    let query = query.trim().to_lowercase();
    let limit = limit.clamp(1, MAX_EDITOR_SEARCH_RESULTS);
    let mut matches = super::discovery::cached_discover(&target.root)?
        .into_iter()
        .filter_map(|entry| {
            let rank = super::discovery::editor_search_rank(&entry.display_path, &query)?;
            Some((rank, entry))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|(left_rank, left), (right_rank, right)| {
        left_rank
            .cmp(right_rank)
            .then_with(|| left.display_path.cmp(&right.display_path))
    });
    Ok(matches
        .into_iter()
        .take(limit)
        .map(|(_, entry)| entry)
        .collect())
}

pub fn list_editor_directory<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_id: Option<&str>,
    directory_path: Option<&str>,
) -> Result<Vec<EditorDirectoryEntry>, String>
where
    B: LocalStoreBackend,
{
    let target = resolve_project_resource_target(state, project_id, resource_id)?;
    discover_directory(&target.root, directory_path)
}

pub fn read_editor_file<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_id: Option<&str>,
    file_ref: &str,
) -> Result<EditorFileSnapshot, String>
where
    B: LocalStoreBackend,
{
    let target = resolve_project_resource_target(state, project_id, resource_id)?;
    let entry = resolve_entry(&target.root, file_ref)?;
    snapshot(project_id, &target.resource_id, &target.root, &entry)
}

pub fn read_editor_file_at_path<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_id: Option<&str>,
    file_ref: &str,
    display_path: &str,
) -> Result<EditorFileSnapshot, String>
where
    B: LocalStoreBackend,
{
    let target = resolve_project_resource_target(state, project_id, resource_id)?;
    let entry = resolve_entry_at_path(&target.root, file_ref, display_path)?;
    snapshot(project_id, &target.resource_id, &target.root, &entry)
}

pub fn save_editor_file<B>(
    state: &ServerStateService<B>,
    request: &EditorFileSaveRequest,
) -> Result<EditorFileSnapshot, String>
where
    B: LocalStoreBackend,
{
    if request.content.len() as u64 > MAX_EDITOR_FILE_BYTES {
        return Err("editor file exceeds the 2 MiB save limit".to_owned());
    }
    let target = resolve_project_resource_target(
        state,
        &request.project_id,
        request.resource_id.as_deref(),
    )?;
    let root = target.root;
    let entry = match request.display_path.as_deref() {
        Some(display_path) => resolve_entry_at_path(&root, &request.file_ref, display_path)?,
        None => resolve_entry(&root, &request.file_ref)?,
    };
    if !entry.writable {
        return Err("editor file is read-only".to_owned());
    }
    let current = snapshot(&request.project_id, &target.resource_id, &root, &entry)?;
    if current.content_revision != request.expected_content_revision {
        return Err("editor file conflict: content changed since it was opened".to_owned());
    }

    let path = admitted_path(&root, &entry.display_path)?;
    let permissions = fs::metadata(&path)
        .map_err(|error| format!("editor file metadata failed: {error}"))?
        .permissions();
    let parent = path
        .parent()
        .ok_or_else(|| "editor file has no parent directory".to_owned())?;
    let mut replacement = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("editor save staging failed: {error}"))?;
    replacement
        .write_all(request.content.as_bytes())
        .and_then(|_| replacement.as_file().sync_all())
        .map_err(|error| format!("editor save staging failed: {error}"))?;
    replacement
        .as_file()
        .set_permissions(permissions)
        .map_err(|error| format!("editor save permission preservation failed: {error}"))?;
    replacement
        .persist(&path)
        .map_err(|error| format!("editor save replacement failed: {}", error.error))?;

    snapshot(&request.project_id, &target.resource_id, &root, &entry)
}

pub(super) fn snapshot(
    project_id: &str,
    resource_id: &str,
    root: &Path,
    entry: &EditorFileEntry,
) -> Result<EditorFileSnapshot, String> {
    let path = admitted_path(root, &entry.display_path)?;
    let bytes = fs::read(&path).map_err(|error| format!("editor file read failed: {error}"))?;
    if bytes.len() as u64 > MAX_EDITOR_FILE_BYTES || bytes.contains(&0) {
        return Err("editor file is no longer an admitted text file".to_owned());
    }
    let content =
        String::from_utf8(bytes).map_err(|_| "editor file is not valid UTF-8 text".to_owned())?;
    Ok(EditorFileSnapshot {
        project_id: project_id.to_owned(),
        resource_id: resource_id.to_owned(),
        file_ref: entry.file_ref.clone(),
        display_path: entry.display_path.clone(),
        language_hint: entry.language_hint.clone(),
        byte_size: content.len() as u64,
        writable: entry.writable,
        content_revision: format!("content:{}", blake3::hash(content.as_bytes()).to_hex()),
        content,
    })
}
