use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use nucleus_local_store::LocalStoreBackend;

use crate::project_resource_target::resolve_project_resource_target;
use crate::ServerStateService;

use super::capture::capture_project;
use super::filesystem::{
    atomic_bytes_create, atomic_json_create, atomic_json_replace, current_unix_seconds,
    directory_entries, json_files, read_json, read_json_optional, regular_files, remove_if_present,
    set_owner_dir_permissions,
};
use super::retention::{SnapshotRetentionRecord, CLEANUP_GRACE_SECONDS};
use super::types::{
    BlobRef, ManifestRef, SnapshotContentState, SnapshotManifest, SnapshotManifestResolution,
    SnapshotRef, SnapshotResolutionState, SnapshotRetentionState, SnapshotRole, SnapshotStoreError,
    SnapshotTextResolution, SnapshotTextResolutionState, TaskReviewSnapshotCaptureRequest,
};

const MANIFESTS_DIR: &str = "manifests";
const BLOBS_DIR: &str = "blobs";
const RETENTION_DIR: &str = "retention";
const STAGING_DIR: &str = "staging";
static SNAPSHOT_NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub struct TaskReviewSnapshotStore {
    root: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl TaskReviewSnapshotStore {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, SnapshotStoreError> {
        let store = Self {
            root: root.into(),
            lock: Arc::new(Mutex::new(())),
        };
        store.prepare_dirs()?;
        store.sweep(current_unix_seconds()?)?;
        Ok(store)
    }

    pub fn capture<B>(
        &self,
        state: &ServerStateService<B>,
        request: TaskReviewSnapshotCaptureRequest,
    ) -> Result<SnapshotManifest, SnapshotStoreError>
    where
        B: LocalStoreBackend,
    {
        let target = resolve_project_resource_target(
            state,
            &request.project_id,
            request.resource_id.as_deref(),
        )
        .map_err(SnapshotStoreError::CaptureUnavailable)?;
        let mut request = request;
        request.resource_id = Some(target.resource_id);
        self.capture_root(&target.root, request)
    }

    pub fn resolve_manifest(
        &self,
        snapshot_ref: &SnapshotRef,
    ) -> Result<SnapshotManifestResolution, SnapshotStoreError> {
        let _guard = self.guard()?;
        self.resolve_manifest_unlocked(snapshot_ref)
    }

    pub fn resolve_text(
        &self,
        snapshot_ref: &SnapshotRef,
        file_ref: &super::types::SnapshotFileRef,
    ) -> Result<SnapshotTextResolution, SnapshotStoreError> {
        let _guard = self.guard()?;
        let resolution = self.resolve_manifest_unlocked(snapshot_ref)?;
        let available_state = match resolution.state {
            SnapshotResolutionState::Available => SnapshotTextResolutionState::Available,
            SnapshotResolutionState::CleanupPending => SnapshotTextResolutionState::CleanupPending,
            SnapshotResolutionState::Missing => {
                return Ok(text_resolution(
                    SnapshotTextResolutionState::SnapshotMissing,
                    None,
                ));
            }
            SnapshotResolutionState::Expired => {
                return Ok(text_resolution(
                    SnapshotTextResolutionState::SnapshotExpired,
                    None,
                ));
            }
        };
        let manifest = resolution.manifest.ok_or_else(|| {
            SnapshotStoreError::Codec("available snapshot has no manifest".to_owned())
        })?;
        let Some(entry) = manifest
            .files
            .iter()
            .find(|entry| &entry.file_ref == file_ref)
        else {
            return Ok(text_resolution(
                SnapshotTextResolutionState::FileNotFound,
                None,
            ));
        };
        let SnapshotContentState::StoredText { blob_ref } = &entry.content_state else {
            return Ok(text_resolution(
                SnapshotTextResolutionState::NotStored,
                None,
            ));
        };
        let path = self.blob_path(blob_ref)?;
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(text_resolution(
                    SnapshotTextResolutionState::BlobMissing,
                    None,
                ));
            }
            Err(error) => return Err(error.into()),
        };
        if blake3::hash(&bytes).to_hex().to_string() != entry.content_hash {
            return Err(SnapshotStoreError::Codec(
                "stored text blob hash does not match its manifest".to_owned(),
            ));
        }
        let content = String::from_utf8(bytes).map_err(|_| {
            SnapshotStoreError::Codec("stored text blob is not valid UTF-8".to_owned())
        })?;
        Ok(text_resolution(available_state, Some(content)))
    }

    pub fn mark_awaiting_review(
        &self,
        snapshot_ref: &SnapshotRef,
    ) -> Result<(), SnapshotStoreError> {
        self.update_retention(snapshot_ref, |record| {
            record.state = SnapshotRetentionState::AwaitingReview;
            record.cleanup_after_unix_seconds = None;
            Ok(())
        })
    }

    pub fn start_cleanup_grace(
        &self,
        snapshot_ref: &SnapshotRef,
        terminal_at_unix_seconds: u64,
    ) -> Result<(), SnapshotStoreError> {
        self.update_retention(snapshot_ref, |record| {
            record.state = SnapshotRetentionState::CleanupGrace;
            record.cleanup_after_unix_seconds = Some(
                terminal_at_unix_seconds
                    .checked_add(CLEANUP_GRACE_SECONDS)
                    .ok_or_else(|| {
                        SnapshotStoreError::Codec("cleanup deadline overflowed".to_owned())
                    })?,
            );
            Ok(())
        })
    }

    pub fn sweep(&self, now_unix_seconds: u64) -> Result<(), SnapshotStoreError> {
        let _guard = self.guard()?;
        self.prepare_dirs()?;

        for path in json_files(&self.retention_dir())? {
            let mut record: SnapshotRetentionRecord = read_json(&path)?;
            if record.state == SnapshotRetentionState::CleanupGrace
                && record
                    .cleanup_after_unix_seconds
                    .is_some_and(|deadline| deadline <= now_unix_seconds)
            {
                let manifest_path = self.manifest_path(&record.manifest_ref)?;
                remove_if_present(&manifest_path)?;
                record.state = SnapshotRetentionState::Expired;
                record.cleanup_after_unix_seconds = None;
                atomic_json_replace(&path, &record)?;
            }
        }

        let mut retained_blobs = HashSet::new();
        for path in json_files(&self.manifests_dir())? {
            let manifest: SnapshotManifest = read_json(&path)?;
            for file in manifest.files {
                if let SnapshotContentState::StoredText { blob_ref } = file.content_state {
                    retained_blobs.insert(blob_ref);
                }
            }
        }
        for path in regular_files(&self.blobs_dir())? {
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let blob_ref = BlobRef(format!("snapshot-blob:{name}"));
            if !retained_blobs.contains(&blob_ref) {
                fs::remove_file(path)?;
            }
        }
        for path in directory_entries(&self.staging_dir())? {
            if path.is_dir() {
                fs::remove_dir_all(path)?;
            } else {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }

    pub(super) fn capture_root(
        &self,
        project_root: &Path,
        request: TaskReviewSnapshotCaptureRequest,
    ) -> Result<SnapshotManifest, SnapshotStoreError> {
        if request.project_id.trim().is_empty() || request.work_item_id.trim().is_empty() {
            return Err(SnapshotStoreError::CaptureUnavailable(
                "project and work-item ids are required".to_owned(),
            ));
        }
        let _guard = self.guard()?;
        self.prepare_dirs()?;
        let staging = tempfile::Builder::new()
            .prefix("capture-")
            .tempdir_in(self.staging_dir())?;
        set_owner_dir_permissions(staging.path())?;
        let canonical_project_root = fs::canonicalize(project_root).map_err(|error| {
            SnapshotStoreError::CaptureUnavailable(format!(
                "project repository is unavailable: {error}"
            ))
        })?;
        let captured = capture_project(&canonical_project_root, staging.path())?;
        let snapshot_ref = new_snapshot_ref(&request, staging.path());
        let manifest_ref = ManifestRef(format!(
            "snapshot-manifest:{}",
            blake3::hash(snapshot_ref.0.as_bytes()).to_hex()
        ));
        let manifest = SnapshotManifest {
            snapshot_ref: snapshot_ref.clone(),
            manifest_ref: manifest_ref.clone(),
            project_id: request.project_id,
            resource_id: request.resource_id,
            work_item_id: request.work_item_id,
            role: request.role,
            created_at_unix_seconds: request.created_at_unix_seconds,
            coverage: captured.coverage,
            retained_text_bytes: captured.retained_text_bytes,
            files: captured.files,
        };

        for (blob_ref, staged_path) in captured.staged_blobs {
            let destination = self.blob_path(&blob_ref)?;
            if destination.exists() {
                continue;
            }
            let payload = fs::read(staged_path)?;
            atomic_bytes_create(&destination, &payload)?;
        }
        let retention = SnapshotRetentionRecord::active(snapshot_ref, manifest_ref.clone());
        atomic_json_replace(&self.retention_path(&retention.snapshot_ref)?, &retention)?;
        atomic_json_create(&self.manifest_path(&manifest_ref)?, &manifest)?;
        Ok(manifest)
    }

    fn resolve_manifest_unlocked(
        &self,
        snapshot_ref: &SnapshotRef,
    ) -> Result<SnapshotManifestResolution, SnapshotStoreError> {
        let retention_path = self.retention_path(snapshot_ref)?;
        let retention: SnapshotRetentionRecord = match read_json_optional(&retention_path)? {
            Some(record) => record,
            None => return Ok(manifest_resolution(SnapshotResolutionState::Missing, None)),
        };
        if retention.state == SnapshotRetentionState::Expired {
            return Ok(manifest_resolution(SnapshotResolutionState::Expired, None));
        }
        let manifest = match read_json_optional(&self.manifest_path(&retention.manifest_ref)?)? {
            Some(manifest) => manifest,
            None => return Ok(manifest_resolution(SnapshotResolutionState::Missing, None)),
        };
        let state = if retention.state == SnapshotRetentionState::CleanupGrace {
            SnapshotResolutionState::CleanupPending
        } else {
            SnapshotResolutionState::Available
        };
        Ok(manifest_resolution(state, Some(manifest)))
    }

    fn update_retention(
        &self,
        snapshot_ref: &SnapshotRef,
        update: impl FnOnce(&mut SnapshotRetentionRecord) -> Result<(), SnapshotStoreError>,
    ) -> Result<(), SnapshotStoreError> {
        let _guard = self.guard()?;
        let path = self.retention_path(snapshot_ref)?;
        let mut record: SnapshotRetentionRecord = read_json_optional(&path)?.ok_or_else(|| {
            SnapshotStoreError::CaptureUnavailable(
                "snapshot retention record is missing".to_owned(),
            )
        })?;
        if record.state == SnapshotRetentionState::Expired {
            return Err(SnapshotStoreError::CaptureUnavailable(
                "snapshot has expired".to_owned(),
            ));
        }
        update(&mut record)?;
        atomic_json_replace(&path, &record)
    }

    fn prepare_dirs(&self) -> Result<(), SnapshotStoreError> {
        for path in [
            self.root.clone(),
            self.manifests_dir(),
            self.blobs_dir(),
            self.retention_dir(),
            self.staging_dir(),
        ] {
            fs::create_dir_all(&path)?;
            set_owner_dir_permissions(&path)?;
        }
        Ok(())
    }

    fn guard(&self) -> Result<MutexGuard<'_, ()>, SnapshotStoreError> {
        self.lock
            .lock()
            .map_err(|_| SnapshotStoreError::Io("snapshot store lock poisoned".to_owned()))
    }

    fn manifests_dir(&self) -> PathBuf {
        self.root.join(MANIFESTS_DIR)
    }

    fn blobs_dir(&self) -> PathBuf {
        self.root.join(BLOBS_DIR)
    }

    fn retention_dir(&self) -> PathBuf {
        self.root.join(RETENTION_DIR)
    }

    fn staging_dir(&self) -> PathBuf {
        self.root.join(STAGING_DIR)
    }

    fn manifest_path(&self, value: &ManifestRef) -> Result<PathBuf, SnapshotStoreError> {
        Ok(self.manifests_dir().join(format!(
            "{}.json",
            opaque_hash(&value.0, "snapshot-manifest:")?
        )))
    }

    fn retention_path(&self, value: &SnapshotRef) -> Result<PathBuf, SnapshotStoreError> {
        Ok(self
            .retention_dir()
            .join(format!("{}.json", opaque_hash(&value.0, "snapshot:")?)))
    }

    fn blob_path(&self, value: &BlobRef) -> Result<PathBuf, SnapshotStoreError> {
        Ok(self
            .blobs_dir()
            .join(opaque_hash(&value.0, "snapshot-blob:")?))
    }
}

fn new_snapshot_ref(
    request: &TaskReviewSnapshotCaptureRequest,
    staging_path: &Path,
) -> SnapshotRef {
    let nonce = SNAPSHOT_NONCE.fetch_add(1, Ordering::Relaxed);
    let role = match request.role {
        SnapshotRole::Baseline => "baseline",
        SnapshotRole::Target => "target",
    };
    let identity = format!(
        "{}\0{}\0{}\0{}\0{}\0{}\0{}",
        request.project_id,
        request.work_item_id,
        role,
        request.created_at_unix_seconds,
        std::process::id(),
        nonce,
        staging_path.display()
    );
    SnapshotRef(format!(
        "snapshot:{}",
        blake3::hash(identity.as_bytes()).to_hex()
    ))
}

fn opaque_hash<'a>(value: &'a str, prefix: &str) -> Result<&'a str, SnapshotStoreError> {
    let Some(hash) = value.strip_prefix(prefix) else {
        return Err(SnapshotStoreError::InvalidRef(format!(
            "expected {prefix} prefix"
        )));
    };
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(SnapshotStoreError::InvalidRef(
            "opaque ref must contain one 64-character hex digest".to_owned(),
        ));
    }
    Ok(hash)
}

fn manifest_resolution(
    state: SnapshotResolutionState,
    manifest: Option<SnapshotManifest>,
) -> SnapshotManifestResolution {
    SnapshotManifestResolution { state, manifest }
}

fn text_resolution(
    state: SnapshotTextResolutionState,
    content: Option<String>,
) -> SnapshotTextResolution {
    SnapshotTextResolution { state, content }
}
