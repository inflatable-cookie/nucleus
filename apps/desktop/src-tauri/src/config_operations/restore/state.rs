use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use longhorn_config::BackupArchiveLimits;
use serde::{Deserialize, Serialize};

use crate::desktop_profile::DesktopProfile;

use super::RestoreBootReceipt;

pub(super) const REQUEST_SCHEMA_VERSION: u32 = 1;
const REQUEST_FILE: &str = "pending-v1.json";
const RECEIPT_FILE: &str = "last-boot-receipt-v2.json";
static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(super) struct PendingRestoreRequest {
    pub schema_version: u32,
    pub layout_digest: String,
    pub archive_path: PathBuf,
    pub archive_sha256: String,
    pub domains: Vec<String>,
    pub confirmation_digest: String,
}

pub(super) fn read_request(path: &Path) -> Result<Option<PendingRestoreRequest>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("decode pending restore request failed: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read pending restore request failed: {error}")),
    }
}

pub(super) fn read_receipt(profile: &DesktopProfile) -> Result<Option<RestoreBootReceipt>, String> {
    match fs::read(receipt_path(profile)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("decode restore receipt failed: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read restore receipt failed: {error}")),
    }
}

pub(super) fn read_archive(path: &Path) -> Result<Vec<u8>, String> {
    let limit = BackupArchiveLimits::default().max_archive_bytes();
    let file = File::open(path).map_err(|error| format!("open restore archive failed: {error}"))?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read restore archive failed: {error}"))?;
    if bytes.len() > limit {
        return Err(format!("restore archive exceeds {limit} byte limit"));
    }
    Ok(bytes)
}

pub(super) fn request_path(profile: &DesktopProfile) -> PathBuf {
    restore_root(profile).join(REQUEST_FILE)
}

pub(super) fn receipt_path(profile: &DesktopProfile) -> PathBuf {
    restore_root(profile).join(RECEIPT_FILE)
}

fn restore_root(profile: &DesktopProfile) -> PathBuf {
    profile.storage_roots().state().join("restore")
}

pub(super) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("encode restore state failed: {error}"))?;
    atomic_write(path, &bytes)
}

pub(super) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "restore state path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create restore state directory failed: {error}"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "restore state path has no file name".to_owned())?;
    let temporary = parent.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        set_private_mode(&mut options);
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("create restore state failed: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("write restore state failed: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("sync restore state failed: {error}"))?;
        drop(file);
        fs::rename(&temporary, path)
            .map_err(|error| format!("publish restore state failed: {error}"))?;
        sync_parent(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) fn remove_durable(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => sync_parent(path.parent().unwrap_or_else(|| Path::new("/"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("clear pending restore request failed: {error}")),
    }
}

fn sync_parent(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("sync restore state directory failed: {error}"))
}

#[cfg(unix)]
fn set_private_mode(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_private_mode(_options: &mut OpenOptions) {}
