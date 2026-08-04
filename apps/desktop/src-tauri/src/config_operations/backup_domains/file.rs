use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) struct FileCaptureAdapter {
    id: BackupAdapterId,
    capabilities: BackupAdapterCapabilities,
    path: PathBuf,
}

impl FileCaptureAdapter {
    pub(super) fn new(id: &str, path: PathBuf) -> Result<Self, String> {
        Ok(Self {
            id: BackupAdapterId::new(id).map_err(|error| error.to_string())?,
            capabilities: grouped_capabilities(id)?,
            path,
        })
    }
}

impl BackupAdapter for FileCaptureAdapter {
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
        let bytes = fs::read(&self.path).map_err(|_| adapter_error("file-read"))?;
        if bytes.len() > request.limits().max_domain_bytes() {
            return Err(adapter_error("file-size"));
        }
        Ok(BackupAdapterCapture::Present {
            source_schema_version: request.descriptor().schema_version(),
            payloads: vec![BackupAdapterPayload::new(
                BackupAdapterRelativePath::new("document.bin")
                    .map_err(|_| adapter_error("file-path"))?,
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
            BackupSourceState::Present => BackupAdapterStateEvidence::present(
                Sha256Digest::from_bytes(only_payload(&request)?),
            ),
            _ => return Err(adapter_error("file-source-state")),
        };
        let current = self
            .path
            .is_file()
            .then(|| fs::read(&self.path).map(|bytes| Sha256Digest::from_bytes(&bytes)))
            .transpose()
            .map_err(|_| adapter_error("file-inspect"))?;
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

impl BackupAdapterGroupedRestore for FileCaptureAdapter {
    fn stage(
        &self,
        request: BackupAdapterGroupedStageRequest<'_>,
    ) -> Result<BackupAdapterRestoreStage, BackupAdapterError> {
        let target_payloads = match request.preview().target_evidence() {
            BackupAdapterStateEvidence::Absent => Vec::new(),
            BackupAdapterStateEvidence::Present { sha256 } => {
                let target = only_payload(request.inspect())?;
                if &Sha256Digest::from_bytes(target) != sha256 {
                    return Err(adapter_error("file-stage-evidence"));
                }
                vec![BackupAdapterPayload::new(
                    BackupAdapterRelativePath::new("document.bin")
                        .map_err(|_| adapter_error("file-stage-path"))?,
                    target.to_vec(),
                )]
            }
        };
        let rollback_payloads = if self.path.is_file() {
            vec![BackupAdapterPayload::new(
                BackupAdapterRelativePath::new("document.bin")
                    .map_err(|_| adapter_error("file-rollback-path"))?,
                fs::read(&self.path).map_err(|_| adapter_error("file-rollback-read"))?,
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
            return remove_file(&self.path, "file-remove");
        }
        let [payload] = request.payloads() else {
            return Err(adapter_error("file-apply-count"));
        };
        atomic_write(&self.path, payload.bytes(), "file-apply")
    }

    fn verify(
        &self,
        _request: BackupAdapterGroupedVerifyRequest<'_>,
    ) -> Result<BackupAdapterStateEvidence, BackupAdapterError> {
        let observed = self
            .path
            .is_file()
            .then(|| {
                fs::read(&self.path)
                    .map(|bytes| Sha256Digest::from_bytes(&bytes))
                    .map_err(|_| adapter_error("file-verify"))
            })
            .transpose()?;
        Ok(BackupAdapterStateEvidence::from_optional(observed))
    }
}

fn atomic_write(path: &Path, bytes: &[u8], code: &str) -> Result<(), BackupAdapterError> {
    let parent = path.parent().ok_or_else(|| adapter_error(code))?;
    fs::create_dir_all(parent).map_err(|_| adapter_error(code))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| adapter_error(code))?;
    let temporary = parent.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| adapter_error(code))?;
        file.write_all(bytes).map_err(|_| adapter_error(code))?;
        file.sync_all().map_err(|_| adapter_error(code))?;
        drop(file);
        fs::rename(&temporary, path).map_err(|_| adapter_error(code))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| adapter_error(code))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn remove_file(path: &Path, code: &str) -> Result<(), BackupAdapterError> {
    match fs::remove_file(path) {
        Ok(()) => path
            .parent()
            .map(File::open)
            .transpose()
            .and_then(|directory| directory.map(|directory| directory.sync_all()).transpose())
            .map(|_| ())
            .map_err(|_| adapter_error(code)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(adapter_error(code)),
    }
}
