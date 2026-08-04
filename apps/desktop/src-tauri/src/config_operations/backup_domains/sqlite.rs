use std::fs;
use std::io::Write;

use rusqlite::{Connection, MAIN_DB};

use super::*;

pub(super) struct SqliteCaptureAdapter {
    id: BackupAdapterId,
    capabilities: BackupAdapterCapabilities,
    path: PathBuf,
}

impl SqliteCaptureAdapter {
    pub(super) fn new(path: PathBuf) -> Result<Self, String> {
        Ok(Self {
            id: BackupAdapterId::new("nucleus-sqlite-online-v1")
                .map_err(|error| error.to_string())?,
            capabilities: grouped_capabilities("nucleus-sqlite")?,
            path,
        })
    }

    fn snapshot_bytes(&self) -> Result<Vec<u8>, BackupAdapterError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let temporary =
            tempfile::NamedTempFile::new().map_err(|_| adapter_error("sqlite-stage"))?;
        let source = Connection::open(&self.path).map_err(|_| adapter_error("sqlite-open"))?;
        source
            .backup(MAIN_DB, temporary.path(), None)
            .map_err(|_| adapter_error("sqlite-backup"))?;
        validate_sqlite(temporary.path())?;
        fs::read(temporary.path()).map_err(|_| adapter_error("sqlite-read"))
    }
}

impl BackupAdapter for SqliteCaptureAdapter {
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
        if !self.path.exists() {
            return Ok(BackupAdapterCapture::Absent);
        }
        let bytes = self.snapshot_bytes()?;
        if bytes.len() > request.limits().max_domain_bytes() {
            return Err(adapter_error("sqlite-size"));
        }
        Ok(BackupAdapterCapture::Present {
            source_schema_version: request.descriptor().schema_version(),
            payloads: vec![BackupAdapterPayload::new(
                BackupAdapterRelativePath::new("nucleus.sqlite")
                    .map_err(|_| adapter_error("sqlite-path"))?,
                bytes,
            )],
        })
    }

    fn inspect(
        &self,
        request: BackupAdapterInspectRequest<'_>,
    ) -> Result<BackupAdapterRestorePreview, BackupAdapterError> {
        let target = match request.source_state() {
            BackupSourceState::Absent if request.payloads().is_empty() => {
                BackupAdapterStateEvidence::Absent
            }
            BackupSourceState::Present => {
                let payload = only_payload(&request)?;
                let target_path = sqlite_payload_file(payload)?;
                validate_sqlite(target_path.path())?;
                BackupAdapterStateEvidence::present(Sha256Digest::from_bytes(payload))
            }
            _ => return Err(adapter_error("sqlite-source-state")),
        };
        let current = self
            .path
            .is_file()
            .then(|| {
                self.snapshot_bytes()
                    .map(|bytes| Sha256Digest::from_bytes(&bytes))
            })
            .transpose()?;
        Ok(BackupAdapterRestorePreview::new(
            target,
            BackupAdapterStateEvidence::from_optional(current),
        ))
    }

    fn restore(
        &self,
        _request: BackupAdapterRestoreRequest<'_>,
    ) -> Result<BackupAdapterRestoreOutcome, BackupAdapterError> {
        Err(BackupAdapterError::Unavailable)
    }

    fn grouped_restore(&self) -> Option<&dyn BackupAdapterGroupedRestore> {
        Some(self)
    }
}

impl BackupAdapterGroupedRestore for SqliteCaptureAdapter {
    fn stage(
        &self,
        request: BackupAdapterGroupedStageRequest<'_>,
    ) -> Result<BackupAdapterRestoreStage, BackupAdapterError> {
        let target_payloads = match request.preview().target_evidence() {
            BackupAdapterStateEvidence::Absent => Vec::new(),
            BackupAdapterStateEvidence::Present { sha256 } => {
                let target = only_payload(request.inspect())?;
                let target_path = sqlite_payload_file(target)?;
                validate_sqlite(target_path.path())?;
                if &Sha256Digest::from_bytes(target) != sha256 {
                    return Err(adapter_error("sqlite-stage-evidence"));
                }
                vec![BackupAdapterPayload::new(
                    BackupAdapterRelativePath::new("nucleus.sqlite")
                        .map_err(|_| adapter_error("sqlite-stage-path"))?,
                    target.to_vec(),
                )]
            }
        };
        let rollback_payloads = if self.path.is_file() {
            vec![BackupAdapterPayload::new(
                BackupAdapterRelativePath::new("nucleus.sqlite")
                    .map_err(|_| adapter_error("sqlite-rollback-path"))?,
                self.snapshot_bytes()?,
            )]
        } else {
            Vec::new()
        };
        Ok(BackupAdapterRestoreStage::new(
            target_payloads,
            rollback_payloads,
            request.preview().target_evidence().clone(),
            request.preview().current_evidence().clone(),
        ))
    }

    fn apply(
        &self,
        request: BackupAdapterGroupedApplyRequest<'_>,
    ) -> Result<(), BackupAdapterError> {
        if request.expected_evidence().is_absent() {
            remove_file(&self.path, "sqlite-remove")?;
            remove_file(&sqlite_sidecar(&self.path, "-wal"), "sqlite-remove-wal")?;
            return remove_file(&sqlite_sidecar(&self.path, "-shm"), "sqlite-remove-shm");
        }
        let [payload] = request.payloads() else {
            return Err(adapter_error("sqlite-apply-count"));
        };
        let source = sqlite_payload_file(payload.bytes())?;
        validate_sqlite(source.path())?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|_| adapter_error("sqlite-parent"))?;
        }
        remove_file(&sqlite_sidecar(&self.path, "-wal"), "sqlite-remove-wal")?;
        remove_file(&sqlite_sidecar(&self.path, "-shm"), "sqlite-remove-shm")?;
        let mut destination =
            Connection::open(&self.path).map_err(|_| adapter_error("sqlite-apply-open"))?;
        destination
            .restore(
                MAIN_DB,
                source.path(),
                None::<fn(rusqlite::backup::Progress)>,
            )
            .map_err(|_| adapter_error("sqlite-apply-restore"))?;
        drop(destination);
        validate_sqlite(&self.path)
    }

    fn verify(
        &self,
        _request: BackupAdapterGroupedVerifyRequest<'_>,
    ) -> Result<BackupAdapterStateEvidence, BackupAdapterError> {
        let observed = self
            .path
            .is_file()
            .then(|| {
                self.snapshot_bytes()
                    .map(|bytes| Sha256Digest::from_bytes(&bytes))
            })
            .transpose()?;
        Ok(BackupAdapterStateEvidence::from_optional(observed))
    }
}

fn sqlite_payload_file(bytes: &[u8]) -> Result<tempfile::NamedTempFile, BackupAdapterError> {
    let mut file = tempfile::NamedTempFile::new().map_err(|_| adapter_error("sqlite-scratch"))?;
    file.write_all(bytes)
        .map_err(|_| adapter_error("sqlite-stage-write"))?;
    file.flush()
        .map_err(|_| adapter_error("sqlite-stage-flush"))?;
    Ok(file)
}

fn remove_file(path: &Path, code: &str) -> Result<(), BackupAdapterError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(adapter_error(code)),
    }
}

fn sqlite_sidecar(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", path.display()))
}

fn validate_sqlite(path: &Path) -> Result<(), BackupAdapterError> {
    let connection = Connection::open(path).map_err(|_| adapter_error("sqlite-validate-open"))?;
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| adapter_error("sqlite-quick-check"))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(adapter_error("sqlite-invalid"))
    }
}
