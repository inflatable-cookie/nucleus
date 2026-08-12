//! Editor file domain: admitted project file discovery, snapshot reads and
//! saves, and create/rename/delete mutations.
//!
//! Module index over the editor surface: wire types, discovery, reads and
//! saves, mutations, directory operations, and the watch runtime.

use std::time::Duration;

use crate::project_file_policy::{MAX_ADMITTED_PROJECT_FILES, MAX_PROJECT_TEXT_FILE_BYTES};

mod directories;
mod discovery;
mod mutations;
mod read;
mod types;
mod watch;
#[cfg(test)]
mod tests;

pub use directories::{
    create_editor_directory, delete_editor_directory, rename_editor_directory,
    EditorDirectoryCreateRequest, EditorDirectoryDeleteReceipt, EditorDirectoryDeleteRequest,
    EditorDirectoryReceipt, EditorDirectoryRenameReceipt, EditorDirectoryRenameRequest,
    EditorFileMoveReceipt,
};
pub use mutations::{create_editor_file, delete_editor_file, rename_editor_file};
pub use read::{
    list_editor_directory, list_editor_files, read_editor_file, read_editor_file_at_path,
    save_editor_file, search_editor_files,
};
pub use types::{
    EditorDirectoryEntry, EditorDirectoryEntryKind, EditorFileCreateRequest,
    EditorFileDeleteReceipt, EditorFileDeleteRequest, EditorFileEntry, EditorFileRenameRequest,
    EditorFileSaveRequest, EditorFileSnapshot,
};
pub use watch::{EditorFileWatchEvent, EditorFileWatchEventSink, EditorFileWatchRuntime};

pub(crate) use discovery::admitted_editor_file_ref_at_path;

const MAX_EDITOR_FILE_BYTES: u64 = MAX_PROJECT_TEXT_FILE_BYTES;
const MAX_DISCOVERED_FILES: usize = MAX_ADMITTED_PROJECT_FILES;
const MAX_EDITOR_SEARCH_RESULTS: usize = 200;
const DISCOVERY_TTL: Duration = Duration::from_secs(2);
