use std::fs;
use std::path::{Path, PathBuf};

use ignore::{Walk, WalkBuilder};
pub(crate) const MAX_PROJECT_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const MAX_ADMITTED_PROJECT_FILES: usize = 5_000;

pub(crate) fn admitted_project_walk(root: &Path) -> Walk {
    WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|entry| !hard_excluded(entry.path()))
        .build()
}

pub(crate) fn admitted_path(root: &Path, display_path: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(root.join(display_path))
        .map_err(|error| format!("editor file is unavailable: {error}"))?;
    if path == root || !path.starts_with(root) {
        return Err("editor file escaped the project root".to_owned());
    }
    Ok(path)
}

pub(crate) fn project_file_ref(display_path: &str) -> String {
    format!(
        "project-file:{}",
        blake3::hash(display_path.as_bytes()).to_hex()
    )
}

fn hard_excluded(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name, ".git" | "node_modules" | "target" | ".nucleus"))
}
