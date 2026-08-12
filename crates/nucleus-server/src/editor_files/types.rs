//! Editor file wire types: entries, directory entries, snapshots, and the
//! save/create/rename/delete requests and receipts.
//!
//! Split from the editor_files god file; behavior unchanged.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorFileEntry {
    pub file_ref: String,
    pub display_path: String,
    pub language_hint: String,
    pub byte_size: u64,
    pub writable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorDirectoryEntryKind {
    Directory,
    File,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorDirectoryEntry {
    pub name: String,
    pub display_path: String,
    pub kind: EditorDirectoryEntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<EditorFileEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorFileSnapshot {
    pub project_id: String,
    pub resource_id: String,
    pub file_ref: String,
    pub display_path: String,
    pub content: String,
    pub language_hint: String,
    pub byte_size: u64,
    pub writable: bool,
    pub content_revision: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorFileSaveRequest {
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub file_ref: String,
    #[serde(default)]
    pub display_path: Option<String>,
    pub expected_content_revision: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorFileCreateRequest {
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub display_path: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorFileRenameRequest {
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub file_ref: String,
    pub display_path: String,
    pub target_display_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorFileDeleteRequest {
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub file_ref: String,
    pub display_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EditorFileDeleteReceipt {
    pub project_id: String,
    pub resource_id: String,
    pub file_ref: String,
    pub display_path: String,
}
