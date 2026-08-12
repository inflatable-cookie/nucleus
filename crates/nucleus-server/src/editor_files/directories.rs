use std::fs;

use nucleus_local_store::LocalStoreBackend;
use serde::{Deserialize, Serialize};

use crate::project_file_policy::{admitted_existing_mutation_path, admitted_mutation_path};
use crate::project_resource_target::resolve_project_resource_target;
use crate::ServerStateService;

use super::discovery::{discover, file_ref, invalidate_editor_file_discovery, language_hint};
use super::{EditorFileDeleteReceipt, EditorFileEntry};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorDirectoryCreateRequest {
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub display_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorDirectoryRenameRequest {
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub display_path: String,
    pub target_display_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorDirectoryDeleteRequest {
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub display_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorDirectoryReceipt {
    pub project_id: String,
    pub resource_id: String,
    pub display_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorFileMoveReceipt {
    pub file_ref: String,
    pub display_path: String,
    pub target_file_ref: String,
    pub target_display_path: String,
    pub language_hint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorDirectoryRenameReceipt {
    pub project_id: String,
    pub resource_id: String,
    pub display_path: String,
    pub target_display_path: String,
    pub files: Vec<EditorFileMoveReceipt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorDirectoryDeleteReceipt {
    pub project_id: String,
    pub resource_id: String,
    pub display_path: String,
    pub files: Vec<EditorFileDeleteReceipt>,
}

pub fn create_editor_directory<B>(
    state: &ServerStateService<B>,
    request: &EditorDirectoryCreateRequest,
) -> Result<EditorDirectoryReceipt, String>
where
    B: LocalStoreBackend,
{
    let target = resolve_project_resource_target(
        state,
        &request.project_id,
        request.resource_id.as_deref(),
    )?;
    let path = admitted_mutation_path(&target.root, &request.display_path)?;
    fs::create_dir(&path).map_err(|error| format!("create editor folder failed: {error}"))?;
    invalidate_editor_file_discovery(&target.root);
    Ok(EditorDirectoryReceipt {
        project_id: request.project_id.clone(),
        resource_id: target.resource_id,
        display_path: request.display_path.clone(),
    })
}

pub fn rename_editor_directory<B>(
    state: &ServerStateService<B>,
    request: &EditorDirectoryRenameRequest,
) -> Result<EditorDirectoryRenameReceipt, String>
where
    B: LocalStoreBackend,
{
    let target = resolve_project_resource_target(
        state,
        &request.project_id,
        request.resource_id.as_deref(),
    )?;
    let source = admitted_existing_mutation_path(&target.root, &request.display_path)?;
    if !source.is_dir() {
        return Err("editor folder rename source is not a directory".to_owned());
    }
    let destination = admitted_mutation_path(&target.root, &request.target_display_path)?;
    if destination.exists() {
        return Err("rename editor folder target already exists".to_owned());
    }

    let files = files_beneath(&target.root, &request.display_path)?;
    fs::rename(&source, &destination)
        .map_err(|error| format!("rename editor folder failed: {error}"))?;
    invalidate_editor_file_discovery(&target.root);

    Ok(EditorDirectoryRenameReceipt {
        project_id: request.project_id.clone(),
        resource_id: target.resource_id,
        display_path: request.display_path.clone(),
        target_display_path: request.target_display_path.clone(),
        files: files
            .into_iter()
            .map(|entry| move_receipt(entry, &request.display_path, &request.target_display_path))
            .collect(),
    })
}

pub fn delete_editor_directory<B>(
    state: &ServerStateService<B>,
    request: &EditorDirectoryDeleteRequest,
) -> Result<EditorDirectoryDeleteReceipt, String>
where
    B: LocalStoreBackend,
{
    let target = resolve_project_resource_target(
        state,
        &request.project_id,
        request.resource_id.as_deref(),
    )?;
    let path = admitted_existing_mutation_path(&target.root, &request.display_path)?;
    if !path.is_dir() {
        return Err("editor folder delete target is not a directory".to_owned());
    }
    let files = files_beneath(&target.root, &request.display_path)?;
    fs::remove_dir_all(path).map_err(|error| format!("delete editor folder failed: {error}"))?;
    invalidate_editor_file_discovery(&target.root);

    Ok(EditorDirectoryDeleteReceipt {
        project_id: request.project_id.clone(),
        resource_id: target.resource_id.clone(),
        display_path: request.display_path.clone(),
        files: files
            .into_iter()
            .map(|entry| EditorFileDeleteReceipt {
                project_id: request.project_id.clone(),
                resource_id: target.resource_id.clone(),
                file_ref: entry.file_ref,
                display_path: entry.display_path,
            })
            .collect(),
    })
}

fn files_beneath(
    root: &std::path::Path,
    directory_path: &str,
) -> Result<Vec<EditorFileEntry>, String> {
    let prefix = format!("{}/", directory_path.trim_end_matches('/'));
    Ok(discover(root)?
        .into_iter()
        .filter(|entry| entry.display_path.starts_with(&prefix))
        .collect())
}

fn move_receipt(
    entry: EditorFileEntry,
    source_directory: &str,
    target_directory: &str,
) -> EditorFileMoveReceipt {
    let suffix = entry
        .display_path
        .strip_prefix(source_directory)
        .unwrap_or(&entry.display_path);
    let target_display_path = format!("{}{}", target_directory.trim_end_matches('/'), suffix);
    EditorFileMoveReceipt {
        file_ref: entry.file_ref,
        display_path: entry.display_path,
        target_file_ref: file_ref(&target_display_path),
        language_hint: language_hint(&target_display_path).to_owned(),
        target_display_path,
    }
}
