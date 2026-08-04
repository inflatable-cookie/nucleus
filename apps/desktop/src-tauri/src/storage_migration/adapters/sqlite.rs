use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use longhorn_config::{
    BackupAdapter, BackupAdapterCapabilities, BackupAdapterCapture, BackupAdapterCaptureMode,
    BackupAdapterCaptureRequest, BackupAdapterConsistencyGroup, BackupAdapterError,
    BackupAdapterId, BackupAdapterInspectRequest, BackupAdapterPayload, BackupAdapterRelativePath,
    BackupAdapterRestoreOutcome, BackupAdapterRestoreParticipation, BackupAdapterRestorePreview,
    BackupAdapterRestoreRequest, BackupAdapterStateEvidence, BackupSourceState, DomainDescriptor,
    Sha256Digest, StorageTransitionAdapter, StorageTransitionGuard,
};
use rusqlite::{Connection, OpenFlags, MAIN_DB};
use tempfile::{tempdir, tempdir_in};

use super::failure;

pub(crate) struct SqliteTransitionAdapter {
    id: BackupAdapterId,
    capabilities: BackupAdapterCapabilities,
    database: PathBuf,
    authority: String,
    gate: Mutex<()>,
}

impl SqliteTransitionAdapter {
    pub(crate) fn new(database: PathBuf, authority: &str) -> Result<Self, String> {
        Ok(Self {
            id: BackupAdapterId::new("nucleus-sqlite-online-v1").map_err(|e| e.to_string())?,
            capabilities: BackupAdapterCapabilities::new(
                BackupAdapterCaptureMode::ExternalSnapshot(
                    BackupAdapterConsistencyGroup::new(authority, "sqlite-online-backup-api")
                        .map_err(|error| error.to_string())?,
                ),
                BackupAdapterRestoreParticipation::FailureAtomic,
            ),
            database,
            authority: authority.to_owned(),
            gate: Mutex::new(()),
        })
    }
    fn snapshot(&self) -> Result<Option<Vec<u8>>, BackupAdapterError> {
        if !self.database.exists() {
            return Ok(None);
        }
        let scratch = tempdir().map_err(|_| failure("sqlite-scratch"))?;
        let snapshot = scratch.path().join("snapshot.sqlite");
        let source = Connection::open_with_flags(&self.database, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| failure("sqlite-open"))?;
        source
            .backup(MAIN_DB, &snapshot, None)
            .map_err(|_| failure("sqlite-backup"))?;
        validate_database(&snapshot)?;
        fs::read(snapshot)
            .map(Some)
            .map_err(|_| failure("sqlite-read"))
    }
}

impl BackupAdapter for SqliteTransitionAdapter {
    fn id(&self) -> &BackupAdapterId {
        &self.id
    }
    fn capabilities(&self) -> &BackupAdapterCapabilities {
        &self.capabilities
    }
    fn capture(
        &self,
        request: BackupAdapterCaptureRequest<'_>,
    ) -> Result<BackupAdapterCapture, BackupAdapterError> {
        let Some(bytes) = self.snapshot()? else {
            return Ok(BackupAdapterCapture::Absent);
        };
        if bytes.len() > request.limits().max_domain_bytes() {
            return Err(failure("sqlite-size"));
        }
        Ok(BackupAdapterCapture::Present {
            source_schema_version: request.descriptor().schema_version(),
            payloads: vec![BackupAdapterPayload::new(
                BackupAdapterRelativePath::new("nucleus.sqlite").expect("static payload path"),
                bytes,
            )],
        })
    }
    fn inspect(
        &self,
        request: BackupAdapterInspectRequest<'_>,
    ) -> Result<BackupAdapterRestorePreview, BackupAdapterError> {
        if request.source_state() != BackupSourceState::Present {
            return Err(failure("sqlite-source-state"));
        }
        let [payload] = request.payloads() else {
            return Err(failure("sqlite-payload"));
        };
        validate_database_bytes(payload.bytes())?;
        Ok(BackupAdapterRestorePreview::new(
            BackupAdapterStateEvidence::present(Sha256Digest::from_bytes(payload.bytes())),
            BackupAdapterStateEvidence::from_optional(self.current_evidence(request.descriptor())?),
        ))
    }
    fn restore(
        &self,
        request: BackupAdapterRestoreRequest<'_>,
    ) -> Result<BackupAdapterRestoreOutcome, BackupAdapterError> {
        let [payload] = request.inspect().payloads() else {
            return Err(failure("sqlite-payload"));
        };
        if self.database.exists() {
            return Err(failure("sqlite-target-occupied"));
        }
        let parent = self
            .database
            .parent()
            .ok_or_else(|| failure("sqlite-parent"))?;
        fs::create_dir_all(parent).map_err(|_| failure("sqlite-create-parent"))?;
        let scratch = tempdir_in(parent).map_err(|_| failure("sqlite-scratch"))?;
        let source = scratch.path().join("source.sqlite");
        let target = scratch.path().join("target.sqlite");
        fs::write(&source, payload.bytes()).map_err(|_| failure("sqlite-stage"))?;
        validate_database(&source)?;
        let mut connection = Connection::open(&target).map_err(|_| failure("sqlite-target"))?;
        connection
            .restore(MAIN_DB, &source, None::<fn(rusqlite::backup::Progress)>)
            .map_err(|_| failure("sqlite-restore"))?;
        drop(connection);
        validate_database(&target)?;
        fs::rename(&target, &self.database).map_err(|_| failure("sqlite-commit"))?;
        let evidence = self
            .current_evidence(request.inspect().descriptor())?
            .ok_or_else(|| failure("sqlite-verify"))?;
        if Some(&evidence) != request.preview().target_evidence().sha256() {
            return Err(failure("sqlite-evidence"));
        }
        Ok(BackupAdapterRestoreOutcome::Verified { evidence })
    }
}

impl StorageTransitionAdapter for SqliteTransitionAdapter {
    fn transition_authority(&self) -> &str {
        &self.authority
    }
    fn acquire_transition_guard(
        &self,
        _descriptor: &DomainDescriptor,
        _timeout: Duration,
    ) -> Result<Box<dyn StorageTransitionGuard + '_>, BackupAdapterError> {
        self.gate
            .lock()
            .map(|guard| Box::new(guard) as Box<dyn StorageTransitionGuard>)
            .map_err(|_| failure("sqlite-lock"))
    }
    fn owned_paths(&self, _descriptor: &DomainDescriptor) -> Vec<PathBuf> {
        vec![
            self.database.clone(),
            PathBuf::from(format!("{}-wal", self.database.display())),
            PathBuf::from(format!("{}-shm", self.database.display())),
        ]
    }
    fn current_evidence(
        &self,
        _descriptor: &DomainDescriptor,
    ) -> Result<Option<Sha256Digest>, BackupAdapterError> {
        self.snapshot()
            .map(|snapshot| snapshot.map(|bytes| Sha256Digest::from_bytes(&bytes)))
    }
}

fn validate_database_bytes(bytes: &[u8]) -> Result<(), BackupAdapterError> {
    let scratch = tempdir().map_err(|_| failure("sqlite-scratch"))?;
    let path = scratch.path().join("database.sqlite");
    fs::write(&path, bytes).map_err(|_| failure("sqlite-stage"))?;
    validate_database(&path)
}

fn validate_database(path: &Path) -> Result<(), BackupAdapterError> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| failure("sqlite-validate"))?;
    let check = connection
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map_err(|_| failure("sqlite-quick-check"))?;
    if check != "ok" {
        return Err(failure("sqlite-invalid"));
    }
    Ok(())
}
