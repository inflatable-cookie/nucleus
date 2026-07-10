use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::project_file_policy::{
    admitted_project_walk, project_file_ref, MAX_ADMITTED_PROJECT_FILES,
    MAX_PROJECT_TEXT_FILE_BYTES,
};

use super::types::{
    BlobRef, SnapshotContentState, SnapshotCoverageState, SnapshotFileEntry, SnapshotFileRef,
    SnapshotStoreError,
};

pub(super) const MAX_RETAINED_TEXT_BYTES: u64 = 256 * 1024 * 1024;

pub(super) struct CapturedProject {
    pub files: Vec<SnapshotFileEntry>,
    pub retained_text_bytes: u64,
    pub staged_blobs: HashMap<BlobRef, PathBuf>,
    pub coverage: SnapshotCoverageState,
}

pub(super) fn capture_project(
    root: &Path,
    staging_dir: &Path,
) -> Result<CapturedProject, SnapshotStoreError> {
    let mut files = Vec::new();
    let mut retained_text_bytes = 0_u64;
    let mut staged_blobs = HashMap::new();

    for result in admitted_project_walk(root) {
        let entry = result.map_err(|error| {
            SnapshotStoreError::CaptureUnavailable(format!("project walk failed: {error}"))
        })?;
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        if files.len() == MAX_ADMITTED_PROJECT_FILES {
            return Err(SnapshotStoreError::CaptureUnavailable(format!(
                "project exceeds the {MAX_ADMITTED_PROJECT_FILES} path capture limit"
            )));
        }

        let relative = entry.path().strip_prefix(root).map_err(|_| {
            SnapshotStoreError::CaptureUnavailable(
                "admitted project file escaped the canonical root".to_owned(),
            )
        })?;
        let display_path = relative.to_string_lossy().replace('\\', "/");
        let path = fs::canonicalize(entry.path()).map_err(|error| {
            SnapshotStoreError::CaptureUnavailable(format!(
                "file containment check failed: {error}"
            ))
        })?;
        if path == root || !path.starts_with(root) {
            return Err(SnapshotStoreError::CaptureUnavailable(
                "admitted project file escaped the canonical root".to_owned(),
            ));
        }
        let metadata = fs::metadata(&path).map_err(|error| {
            SnapshotStoreError::CaptureUnavailable(format!("file metadata failed: {error}"))
        })?;
        let byte_size = metadata.len();
        let (content_hash, content_state) = if byte_size > MAX_PROJECT_TEXT_FILE_BYTES {
            (
                hash_file(&path)?,
                SnapshotContentState::OversizedMetadataOnly,
            )
        } else {
            let bytes = fs::read(path).map_err(|error| {
                SnapshotStoreError::CaptureUnavailable(format!("file read failed: {error}"))
            })?;
            let content_hash = blake3::hash(&bytes).to_hex().to_string();
            if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
                (content_hash, SnapshotContentState::BinaryMetadataOnly)
            } else {
                retained_text_bytes =
                    retained_text_bytes.checked_add(byte_size).ok_or_else(|| {
                        SnapshotStoreError::CaptureUnavailable(
                            "retained text byte count overflowed".to_owned(),
                        )
                    })?;
                if retained_text_bytes > MAX_RETAINED_TEXT_BYTES {
                    return Err(SnapshotStoreError::CaptureUnavailable(format!(
                        "project exceeds the {MAX_RETAINED_TEXT_BYTES} byte retained-text limit"
                    )));
                }
                let blob_ref = BlobRef(format!("snapshot-blob:{content_hash}"));
                if !staged_blobs.contains_key(&blob_ref) {
                    let path = staging_dir.join(&content_hash);
                    fs::write(&path, bytes)?;
                    super::filesystem::set_owner_file_permissions(&path)?;
                    staged_blobs.insert(blob_ref.clone(), path);
                }
                (content_hash, SnapshotContentState::StoredText { blob_ref })
            }
        };
        files.push(SnapshotFileEntry {
            file_ref: SnapshotFileRef(project_file_ref(&display_path)),
            display_path,
            content_hash,
            byte_size,
            content_state,
        });
    }

    files.sort_by(|left, right| left.display_path.cmp(&right.display_path));
    Ok(CapturedProject {
        files,
        retained_text_bytes,
        staged_blobs,
        coverage: SnapshotCoverageState::CompleteAdmittedFiles,
    })
}

fn hash_file(path: &Path) -> Result<String, SnapshotStoreError> {
    let mut file = File::open(path).map_err(|error| {
        SnapshotStoreError::CaptureUnavailable(format!("file hash open failed: {error}"))
    })?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            SnapshotStoreError::CaptureUnavailable(format!("file hash read failed: {error}"))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}
