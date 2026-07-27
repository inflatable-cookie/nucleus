use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::process::Command;

use super::ScmWorkingCopyInspection;

pub(super) fn status_fingerprint(
    inspection: &ScmWorkingCopyInspection,
    root: &Path,
    index_fingerprint: &str,
) -> String {
    let mut files = inspection.files.iter().collect::<Vec<_>>();
    files.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.index_status.cmp(&right.index_status))
            .then_with(|| left.worktree_status.cmp(&right.worktree_status))
    });
    let mut hasher = blake3::Hasher::new();
    hash_field(&mut hasher, &inspection.project_id);
    hash_field(&mut hasher, &inspection.resource_id);
    hash_field(&mut hasher, inspection.head_oid.as_deref().unwrap_or(""));
    hash_field(&mut hasher, inspection.branch.as_deref().unwrap_or(""));
    hash_field(&mut hasher, index_fingerprint);
    for file in files {
        hash_field(&mut hasher, &file.path);
        hash_field(&mut hasher, file.original_path.as_deref().unwrap_or(""));
        hash_field(&mut hasher, &file.index_status);
        hash_field(&mut hasher, &file.worktree_status);
        if file.unstaged {
            hash_working_path_metadata(&mut hasher, root, &file.path);
        }
    }
    format!("scm-status:{}", hasher.finalize().to_hex())
}

pub(super) fn git_index_fingerprint(root: &Path) -> Result<String, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--git-path", "index"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .current_dir(root)
        .output()
        .map_err(|error| format!("Git index lookup could not start: {error}"))?;
    if !output.status.success() || output.stdout.len() > 4096 {
        return Err("Git index lookup failed".to_owned());
    }
    let raw_path = String::from_utf8(output.stdout)
        .map_err(|_| "Git index path is not valid UTF-8".to_owned())?;
    let raw_path = raw_path.trim();
    if raw_path.is_empty() {
        return Err("Git index path is unavailable".to_owned());
    }
    let path = Path::new(raw_path);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    if !path.exists() {
        return Ok("git-index:missing".to_owned());
    }
    let mut file =
        File::open(path).map_err(|error| format!("Git index could not open: {error}"))?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Git index could not be read: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("git-index:{}", hasher.finalize().to_hex()))
}

fn hash_working_path_metadata(hasher: &mut blake3::Hasher, root: &Path, path: &str) {
    let absolute = root.join(path);
    match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) => {
            hash_field(hasher, "present");
            hasher.update(&metadata.len().to_le_bytes());
            let modified = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok());
            hasher.update(
                &modified
                    .map(|value| value.as_nanos())
                    .unwrap_or_default()
                    .to_le_bytes(),
            );
            if metadata.file_type().is_symlink() {
                hash_field(
                    hasher,
                    &std::fs::read_link(absolute)
                        .map(|value| value.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                );
            }
        }
        Err(_) => hash_field(hasher, "missing"),
    }
}

fn hash_field(hasher: &mut blake3::Hasher, value: &str) {
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value.as_bytes());
}
