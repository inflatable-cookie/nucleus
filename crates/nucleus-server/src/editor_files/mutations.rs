use std::fs;
use std::io::Write;
use std::path::Path;

use nucleus_local_store::LocalStoreBackend;

use crate::project_file_policy::{admitted_mutation_path, admitted_path};
use crate::project_resource_target::resolve_project_resource_target;
use crate::ServerStateService;

use super::discovery::{discover_directory, invalidate_editor_file_discovery, resolve_entry_at_path};
use super::read::snapshot;
use super::{
    EditorFileCreateRequest, EditorFileDeleteReceipt, EditorFileDeleteRequest, EditorFileEntry,
    EditorFileRenameRequest, EditorFileSnapshot, MAX_EDITOR_FILE_BYTES,
};

pub fn create_editor_file<B>(
    state: &ServerStateService<B>,
    request: &EditorFileCreateRequest,
) -> Result<EditorFileSnapshot, String>
where
    B: LocalStoreBackend,
{
    if request.content.len() as u64 > MAX_EDITOR_FILE_BYTES {
        return Err("editor file exceeds the 2 MiB create limit".to_owned());
    }
    let target = resolve_project_resource_target(
        state,
        &request.project_id,
        request.resource_id.as_deref(),
    )?;
    let path = admitted_mutation_path(&target.root, &request.display_path)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("create editor file failed: {error}"))?;
    if let Err(error) = file
        .write_all(request.content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(&path);
        return Err(format!("create editor file failed: {error}"));
    }
    drop(file);

    invalidate_editor_file_discovery(&target.root);
    let entry = match mutated_entry(&target.root, &request.display_path) {
        Ok(entry) => entry,
        Err(error) => {
            let _ = fs::remove_file(&path);
            invalidate_editor_file_discovery(&target.root);
            return Err(error);
        }
    };
    snapshot(
        &request.project_id,
        &target.resource_id,
        &target.root,
        &entry,
    )
}

pub fn rename_editor_file<B>(
    state: &ServerStateService<B>,
    request: &EditorFileRenameRequest,
) -> Result<EditorFileSnapshot, String>
where
    B: LocalStoreBackend,
{
    let target = resolve_project_resource_target(
        state,
        &request.project_id,
        request.resource_id.as_deref(),
    )?;
    let entry = resolve_entry_at_path(&target.root, &request.file_ref, &request.display_path)?;
    if !entry.writable {
        return Err("editor file is read-only".to_owned());
    }
    let source = admitted_path(&target.root, &entry.display_path)?;
    let destination = admitted_mutation_path(&target.root, &request.target_display_path)?;
    if destination.exists() {
        return Err("rename editor file target already exists".to_owned());
    }
    fs::rename(&source, &destination)
        .map_err(|error| format!("rename editor file failed: {error}"))?;

    invalidate_editor_file_discovery(&target.root);
    let renamed = match mutated_entry(&target.root, &request.target_display_path) {
        Ok(entry) => entry,
        Err(error) => {
            let rollback = fs::rename(&destination, &source);
            invalidate_editor_file_discovery(&target.root);
            return match rollback {
                Ok(()) => Err(error),
                Err(rollback_error) => {
                    Err(format!("{error}; rename rollback failed: {rollback_error}"))
                }
            };
        }
    };
    snapshot(
        &request.project_id,
        &target.resource_id,
        &target.root,
        &renamed,
    )
}

pub fn delete_editor_file<B>(
    state: &ServerStateService<B>,
    request: &EditorFileDeleteRequest,
) -> Result<EditorFileDeleteReceipt, String>
where
    B: LocalStoreBackend,
{
    let target = resolve_project_resource_target(
        state,
        &request.project_id,
        request.resource_id.as_deref(),
    )?;
    let entry = resolve_entry_at_path(&target.root, &request.file_ref, &request.display_path)?;
    if !entry.writable {
        return Err("editor file is read-only".to_owned());
    }
    let path = admitted_path(&target.root, &entry.display_path)?;
    fs::remove_file(path).map_err(|error| format!("delete editor file failed: {error}"))?;
    invalidate_editor_file_discovery(&target.root);
    Ok(EditorFileDeleteReceipt {
        project_id: request.project_id.clone(),
        resource_id: target.resource_id,
        file_ref: entry.file_ref,
        display_path: entry.display_path,
    })
}

fn mutated_entry(root: &Path, display_path: &str) -> Result<EditorFileEntry, String> {
    let parent = Path::new(display_path)
        .parent()
        .and_then(Path::to_str)
        .filter(|path| !path.is_empty());
    discover_directory(root, parent)?
        .into_iter()
        .filter_map(|entry| entry.file)
        .find(|entry| entry.display_path == display_path)
        .ok_or_else(|| "editor file mutation target is not an admitted text file".to_owned())
}
