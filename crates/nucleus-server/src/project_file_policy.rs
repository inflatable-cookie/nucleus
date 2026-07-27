use std::fs;
use std::path::{Component, Path, PathBuf};

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

pub(crate) fn admitted_project_directory_walk(directory: &Path) -> Walk {
    let mut builder = WalkBuilder::new(directory);
    builder
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .max_depth(Some(1))
        .filter_entry(|entry| !hard_excluded(entry.path()));
    builder.build()
}

pub(crate) fn admitted_path(root: &Path, display_path: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(root.join(display_path))
        .map_err(|error| format!("editor file is unavailable: {error}"))?;
    if path == root || !path.starts_with(root) {
        return Err("editor file escaped the project root".to_owned());
    }
    Ok(path)
}

pub(crate) fn admitted_mutation_path(root: &Path, display_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(display_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !admitted_project_watch_path(relative)
    {
        return Err("editor file path is not admitted for mutation".to_owned());
    }

    let parent = relative
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| root.join(parent))
        .unwrap_or_else(|| root.to_path_buf());
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("editor file parent directory is unavailable: {error}"))?;
    if parent != root && !parent.starts_with(root) {
        return Err("editor file mutation escaped the project root".to_owned());
    }
    if !parent.is_dir() {
        return Err("editor file mutation parent is not a directory".to_owned());
    }

    let name = relative
        .file_name()
        .ok_or_else(|| "editor file mutation requires a file name".to_owned())?;
    Ok(parent.join(name))
}

pub(crate) fn admitted_existing_mutation_path(
    root: &Path,
    display_path: &str,
) -> Result<PathBuf, String> {
    let path = admitted_mutation_path(root, display_path)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("editor mutation target is unavailable: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("editor mutation target cannot be a symbolic link".to_owned());
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("editor mutation target is unavailable: {error}"))?;
    if canonical == root || !canonical.starts_with(root) {
        return Err("editor mutation escaped the project root".to_owned());
    }
    Ok(path)
}

pub(crate) fn project_file_ref(display_path: &str) -> String {
    format!(
        "project-file:{}",
        blake3::hash(display_path.as_bytes()).to_hex()
    )
}

pub(crate) fn admitted_project_watch_path(relative_path: &Path) -> bool {
    !relative_path.components().any(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        hard_excluded_name(name.to_str())
    })
}

fn hard_excluded(path: &Path) -> bool {
    hard_excluded_name(path.file_name().and_then(|name| name.to_str()))
}

fn hard_excluded_name(name: Option<&str>) -> bool {
    name.is_some_and(|name| matches!(name, ".git" | "node_modules" | "target" | ".nucleus"))
}
