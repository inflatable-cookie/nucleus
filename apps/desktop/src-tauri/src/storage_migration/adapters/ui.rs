use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use longhorn_config::{
    BackupAdapter, BackupAdapterCapabilities, BackupAdapterCapture, BackupAdapterCaptureMode,
    BackupAdapterCaptureRequest, BackupAdapterError, BackupAdapterId, BackupAdapterInspectRequest,
    BackupAdapterPayload, BackupAdapterRelativePath, BackupAdapterRestoreOutcome,
    BackupAdapterRestoreParticipation, BackupAdapterRestorePreview, BackupAdapterRestoreRequest,
    BackupAdapterStateEvidence, BackupSourceState, DomainDescriptor, Sha256Digest,
    StorageTransitionAdapter, StorageTransitionGuard,
};
use tempfile::NamedTempFile;

use crate::workspace_ui;

use super::{failure, payload_digest};

enum UiEndpoint {
    Legacy(PathBuf),
    Split { window: PathBuf, projects: PathBuf },
}

pub(crate) struct UiTransitionAdapter {
    id: BackupAdapterId,
    capabilities: BackupAdapterCapabilities,
    endpoint: UiEndpoint,
    authority: String,
    gate: Mutex<()>,
}

impl UiTransitionAdapter {
    pub(crate) fn legacy(path: PathBuf, authority: &str) -> Self {
        Self::new(UiEndpoint::Legacy(path), authority)
    }
    pub(crate) fn split(window: PathBuf, projects: PathBuf, authority: &str) -> Self {
        Self::new(UiEndpoint::Split { window, projects }, authority)
    }
    fn new(endpoint: UiEndpoint, authority: &str) -> Self {
        Self {
            id: BackupAdapterId::new("nucleus-ui-split-v1").expect("static adapter id"),
            capabilities: BackupAdapterCapabilities::new(
                BackupAdapterCaptureMode::CoordinatedBounded,
                BackupAdapterRestoreParticipation::Separate,
            ),
            endpoint,
            authority: authority.to_owned(),
            gate: Mutex::new(()),
        }
    }
    fn payloads(&self) -> Result<Option<Vec<(String, Vec<u8>)>>, BackupAdapterError> {
        match &self.endpoint {
            UiEndpoint::Legacy(path) => {
                let raw = match fs::read(path) {
                    Ok(raw) => raw,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(_) => return Err(failure("ui-read")),
                };
                let (window, projects) = workspace_ui::split_legacy_workspace_ui_document(&raw)
                    .map_err(|_| failure("ui-decode"))?;
                Ok(Some(vec![
                    ("project-layouts.json".to_owned(), projects),
                    ("window-placement.json".to_owned(), window),
                ]))
            }
            UiEndpoint::Split { window, projects } => {
                let window = read_optional_payload(window, "ui-window-read")?;
                let projects = read_optional_payload(projects, "ui-projects-read")?;
                if window.is_none() && projects.is_none() {
                    Ok(None)
                } else {
                    Ok(Some(vec![
                        (
                            "project-layouts.json".to_owned(),
                            projects.unwrap_or_else(|| b"<absent>".to_vec()),
                        ),
                        (
                            "window-placement.json".to_owned(),
                            window.unwrap_or_else(|| b"<absent>".to_vec()),
                        ),
                    ]))
                }
            }
        }
    }
}

fn read_optional_payload(
    path: &Path,
    failure_code: &'static str,
) -> Result<Option<Vec<u8>>, BackupAdapterError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(failure(failure_code)),
    }
}

impl BackupAdapter for UiTransitionAdapter {
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
        let Some(payloads) = self.payloads()? else {
            return Ok(BackupAdapterCapture::Absent);
        };
        let total = payloads.iter().map(|(_, bytes)| bytes.len()).sum::<usize>();
        if total > request.limits().max_domain_bytes() {
            return Err(failure("ui-size"));
        }
        Ok(BackupAdapterCapture::Present {
            source_schema_version: request.descriptor().schema_version(),
            payloads: payloads
                .into_iter()
                .map(|(path, bytes)| {
                    BackupAdapterPayload::new(
                        BackupAdapterRelativePath::new(path).expect("static payload path"),
                        bytes,
                    )
                })
                .collect(),
        })
    }
    fn inspect(
        &self,
        request: BackupAdapterInspectRequest<'_>,
    ) -> Result<BackupAdapterRestorePreview, BackupAdapterError> {
        if request.source_state() != BackupSourceState::Present {
            return Err(failure("ui-source-state"));
        }
        let payloads = ui_payloads(&request)?;
        Ok(BackupAdapterRestorePreview::new(
            BackupAdapterStateEvidence::present(payload_digest(&payloads)),
            BackupAdapterStateEvidence::from_optional(self.current_evidence(request.descriptor())?),
        ))
    }
    fn restore(
        &self,
        request: BackupAdapterRestoreRequest<'_>,
    ) -> Result<BackupAdapterRestoreOutcome, BackupAdapterError> {
        let UiEndpoint::Split { window, projects } = &self.endpoint else {
            return Err(failure("ui-target"));
        };
        let payloads = ui_payloads(request.inspect())?;
        if Some(&payload_digest(&payloads)) != request.preview().target_evidence().sha256() {
            return Err(failure("ui-preview"));
        }
        let project_bytes = payload(&payloads, "project-layouts.json")?;
        let window_bytes = payload(&payloads, "window-placement.json")?;
        persist_pair(projects, project_bytes, window, window_bytes)?;
        let evidence = self
            .current_evidence(request.inspect().descriptor())?
            .ok_or_else(|| failure("ui-verify"))?;
        Ok(BackupAdapterRestoreOutcome::Verified { evidence })
    }
}

impl StorageTransitionAdapter for UiTransitionAdapter {
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
            .map_err(|_| failure("ui-lock"))
    }
    fn owned_paths(&self, _descriptor: &DomainDescriptor) -> Vec<PathBuf> {
        match &self.endpoint {
            UiEndpoint::Legacy(path) => vec![path.clone()],
            UiEndpoint::Split { window, projects } => vec![window.clone(), projects.clone()],
        }
    }
    fn current_evidence(
        &self,
        _descriptor: &DomainDescriptor,
    ) -> Result<Option<Sha256Digest>, BackupAdapterError> {
        self.payloads()
            .map(|payloads| payloads.map(|items| payload_digest(&items)))
    }
}

fn ui_payloads(
    request: &BackupAdapterInspectRequest<'_>,
) -> Result<Vec<(String, Vec<u8>)>, BackupAdapterError> {
    let mut payloads = request
        .payloads()
        .iter()
        .map(|payload| {
            let name = payload
                .path()
                .as_str()
                .rsplit('/')
                .next()
                .ok_or_else(|| failure("ui-payload"))?;
            Ok((name.to_owned(), payload.bytes().to_vec()))
        })
        .collect::<Result<Vec<_>, BackupAdapterError>>()?;
    payloads.sort_by(|left, right| left.0.cmp(&right.0));
    if payloads
        .iter()
        .map(|entry| entry.0.as_str())
        .collect::<Vec<_>>()
        != ["project-layouts.json", "window-placement.json"]
    {
        return Err(failure("ui-payload"));
    }
    Ok(payloads)
}

fn payload<'a>(
    payloads: &'a [(String, Vec<u8>)],
    name: &str,
) -> Result<&'a [u8], BackupAdapterError> {
    payloads
        .iter()
        .find(|(path, _)| path == name)
        .map(|(_, bytes)| bytes.as_slice())
        .ok_or_else(|| failure("payload-missing"))
}

fn persist_pair(
    first_path: &Path,
    first_bytes: &[u8],
    second_path: &Path,
    second_bytes: &[u8],
) -> Result<(), BackupAdapterError> {
    let first_parent = first_path.parent().ok_or_else(|| failure("ui-parent"))?;
    let second_parent = second_path.parent().ok_or_else(|| failure("ui-parent"))?;
    fs::create_dir_all(first_parent).map_err(|_| failure("ui-create-parent"))?;
    fs::create_dir_all(second_parent).map_err(|_| failure("ui-create-parent"))?;
    let first = staged_file(first_parent, first_bytes)?;
    let second = staged_file(second_parent, second_bytes)?;
    first
        .persist_noclobber(first_path)
        .map_err(|_| failure("ui-commit"))?;
    if second.persist_noclobber(second_path).is_err() {
        let _ = fs::remove_file(first_path);
        return Err(failure("ui-commit"));
    }
    Ok(())
}

fn staged_file(parent: &Path, bytes: &[u8]) -> Result<NamedTempFile, BackupAdapterError> {
    let mut file = NamedTempFile::new_in(parent).map_err(|_| failure("stage-file"))?;
    std::io::Write::write_all(&mut file, bytes).map_err(|_| failure("write-file"))?;
    Ok(file)
}
