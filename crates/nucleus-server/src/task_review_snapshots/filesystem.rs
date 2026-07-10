use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;

use super::types::SnapshotStoreError;

pub(super) fn atomic_json_create(
    path: &Path,
    value: &impl Serialize,
) -> Result<(), SnapshotStoreError> {
    let payload =
        serde_json::to_vec(value).map_err(|error| SnapshotStoreError::Codec(error.to_string()))?;
    atomic_bytes_create(path, &payload)
}

pub(super) fn atomic_json_replace(
    path: &Path,
    value: &impl Serialize,
) -> Result<(), SnapshotStoreError> {
    let payload =
        serde_json::to_vec(value).map_err(|error| SnapshotStoreError::Codec(error.to_string()))?;
    let parent = parent(path)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    use std::io::Write;
    temporary.write_all(&payload)?;
    temporary.as_file().sync_all()?;
    set_owner_file_permissions(temporary.path())?;
    temporary
        .persist(path)
        .map_err(|error| SnapshotStoreError::Io(error.error.to_string()))?;
    Ok(())
}

pub(super) fn atomic_bytes_create(path: &Path, payload: &[u8]) -> Result<(), SnapshotStoreError> {
    let parent = parent(path)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    use std::io::Write;
    temporary.write_all(payload)?;
    temporary.as_file().sync_all()?;
    set_owner_file_permissions(temporary.path())?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| SnapshotStoreError::Io(error.error.to_string()))?;
    Ok(())
}

pub(super) fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, SnapshotStoreError> {
    let payload = fs::read(path)?;
    serde_json::from_slice(&payload).map_err(|error| SnapshotStoreError::Codec(error.to_string()))
}

pub(super) fn read_json_optional<T: DeserializeOwned>(
    path: &Path,
) -> Result<Option<T>, SnapshotStoreError> {
    match fs::read(path) {
        Ok(payload) => serde_json::from_slice(&payload)
            .map(Some)
            .map_err(|error| SnapshotStoreError::Codec(error.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn json_files(directory: &Path) -> Result<Vec<PathBuf>, SnapshotStoreError> {
    Ok(regular_files(directory)?
        .into_iter()
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect())
}

pub(super) fn regular_files(directory: &Path) -> Result<Vec<PathBuf>, SnapshotStoreError> {
    Ok(directory_entries(directory)?
        .into_iter()
        .filter(|path| path.is_file())
        .collect())
}

pub(super) fn directory_entries(directory: &Path) -> Result<Vec<PathBuf>, SnapshotStoreError> {
    fs::read_dir(directory)?
        .map(|entry| entry.map(|entry| entry.path()).map_err(Into::into))
        .collect()
}

pub(super) fn remove_if_present(path: &Path) -> Result<(), SnapshotStoreError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn current_unix_seconds() -> Result<u64, SnapshotStoreError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| SnapshotStoreError::Io(format!("system clock is before epoch: {error}")))
}

fn parent(path: &Path) -> Result<&Path, SnapshotStoreError> {
    path.parent()
        .ok_or_else(|| SnapshotStoreError::Io("snapshot store path has no parent".to_owned()))
}

#[cfg(unix)]
pub(super) fn set_owner_dir_permissions(path: &Path) -> Result<(), SnapshotStoreError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
pub(super) fn set_owner_dir_permissions(_path: &Path) -> Result<(), SnapshotStoreError> {
    Ok(())
}

#[cfg(unix)]
pub(super) fn set_owner_file_permissions(path: &Path) -> Result<(), SnapshotStoreError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
pub(super) fn set_owner_file_permissions(_path: &Path) -> Result<(), SnapshotStoreError> {
    Ok(())
}
