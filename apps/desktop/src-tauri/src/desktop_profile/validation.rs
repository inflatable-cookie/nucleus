use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use longhorn_config::{
    resolve_storage_layout, PlatformDirectoryFacts, ResolvedStorageLayout, StorageIdentity,
    StorageLayoutRequest, StorageProfileSelection,
};

use super::{CHAT_TIMEOUT_ENV, DEFAULT_CHAT_TIMEOUT_MS, PORTABLE_ROOT_ENV, PROOF_FIXTURE_ROOT_ENV};

pub(super) fn resolve_selected_layout(
    identity: StorageIdentity,
    facts: PlatformDirectoryFacts,
    selection: &StorageProfileSelection,
) -> Result<ResolvedStorageLayout, String> {
    let mut request = StorageLayoutRequest::new(identity, facts).with_profile(selection.profile());
    if let Some(root) = selection.explicit_root() {
        request = request.with_portable_root(root);
    }
    resolve_storage_layout(&request)
        .map_err(|error| format!("resolve Nucleus storage profile failed: {error}"))
}

pub(super) fn validate_portable_root(value: &OsStr) -> Result<PathBuf, String> {
    let root = PathBuf::from(value);
    if root.as_os_str().is_empty() {
        return Err(format!("{PORTABLE_ROOT_ENV} must not be empty"));
    }
    if !root.is_absolute() {
        return Err(format!("{PORTABLE_ROOT_ENV} must be an absolute path"));
    }
    if root.exists() && !root.is_dir() {
        return Err(format!("{PORTABLE_ROOT_ENV} does not identify a directory"));
    }
    Ok(root)
}

pub(super) fn parse_chat_timeout(value: Option<&OsStr>) -> Result<u64, String> {
    let timeout = match value {
        Some(value) => value
            .to_str()
            .ok_or_else(|| format!("{CHAT_TIMEOUT_ENV} must be valid UTF-8"))?
            .parse::<u64>()
            .map_err(|_| format!("{CHAT_TIMEOUT_ENV} must be an integer number of milliseconds"))?,
        None => DEFAULT_CHAT_TIMEOUT_MS,
    };
    if !(1..=DEFAULT_CHAT_TIMEOUT_MS).contains(&timeout) {
        return Err(format!(
            "{CHAT_TIMEOUT_ENV} must be between 1 and {DEFAULT_CHAT_TIMEOUT_MS}"
        ));
    }
    Ok(timeout)
}

pub(super) fn parse_fixture_root(
    value: Option<&OsStr>,
    configured_root: Option<&OsStr>,
) -> Result<Option<PathBuf>, String> {
    match value {
        Some(_) if configured_root.is_none() => Err(format!(
            "{PROOF_FIXTURE_ROOT_ENV} requires an explicit {PORTABLE_ROOT_ENV}"
        )),
        Some(root) => {
            let root = PathBuf::from(root);
            if !root.is_absolute() {
                return Err(format!("{PROOF_FIXTURE_ROOT_ENV} must be an absolute path"));
            }
            if !root.is_dir() || !root.join(".git").is_dir() {
                return Err(format!(
                    "{PROOF_FIXTURE_ROOT_ENV} must identify an existing Git repository"
                ));
            }
            Ok(Some(root))
        }
        None => Ok(None),
    }
}

pub(super) fn create_directory(path: &Path, label: &str) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| format!("create {label} failed: {error}"))?;
    if !path.is_dir() {
        return Err(format!("{label} is not a directory"));
    }
    Ok(())
}
