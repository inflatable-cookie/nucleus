//! SCM metadata watch classification: git-dir root discovery and scm-change
//! event detection.
//!
//! Split from the watch god file; behavior unchanged.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::WatchTarget;

pub(super) fn scm_changed_targets(
    targets: &[WatchTarget],
    event_paths: &[PathBuf],
) -> Vec<WatchTarget> {
    targets
        .iter()
        .filter(|target| {
            event_paths.iter().any(|path| {
                target
                    .scm_roots
                    .iter()
                    .any(|scm_root| path.starts_with(scm_root))
                    || path
                        .strip_prefix(&target.root)
                        .is_ok_and(|relative| relative.starts_with(".git"))
            })
        })
        .cloned()
        .collect()
}

pub(super) fn resolve_scm_roots(root: &Path) -> Vec<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--absolute-git-dir"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .current_dir(root)
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() || output.stdout.len() > 4096 {
        return Vec::new();
    }

    let Ok(path) = String::from_utf8(output.stdout) else {
        return Vec::new();
    };
    let git_dir = PathBuf::from(path.trim());
    if git_dir.as_os_str().is_empty() {
        return Vec::new();
    }
    let git_dir = std::fs::canonicalize(&git_dir).unwrap_or(git_dir);

    let mut roots = vec![git_dir.clone()];
    if let Ok(common_dir) = std::fs::read_to_string(git_dir.join("commondir")) {
        let common_dir = common_dir.trim();
        if !common_dir.is_empty() {
            let common_dir = PathBuf::from(common_dir);
            let common_dir = if common_dir.is_absolute() {
                common_dir
            } else {
                git_dir.join(common_dir)
            };
            let common_dir = std::fs::canonicalize(&common_dir).unwrap_or(common_dir);
            if common_dir != git_dir {
                roots.push(common_dir);
            }
        }
    }
    roots
}
