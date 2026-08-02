use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use longhorn_config::{
    encode_backup_export_archive, export_backup, inspect_backup_archive, BackupArchiveFileName,
    BackupArchiveLimits, BackupExportCommand, BackupExportOutcome, BackupExportTarget,
    BackupOperationalCandidate, BackupPublicationOptions, BackupPublicationReceiptProjection,
    ConfigOperationRejection, ConfigOperationRejectionCode, ConfigProtocolVersion,
    DurabilityRequirement, ExportOverwrite, Sha256Digest,
};
use longhorn_core::ConfigRequestId;
use longhorn_tauri_config::{ConfigOperationsCommandService, ConfigOperationsHostError};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

const MAX_PENDING_EXPORT_TARGETS: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SelectedExportTarget {
    path: PathBuf,
    overwrite: ExportOverwrite,
}

impl SelectedExportTarget {
    fn from_picker(path: PathBuf) -> Result<Self, ConfigOperationsHostError> {
        if !path.is_absolute() {
            return Err(ConfigOperationsHostError::authority(
                "backup export picker returned a non-absolute path",
                false,
            ));
        }
        let overwrite = if path.exists() {
            ExportOverwrite::Replace
        } else {
            ExportOverwrite::Refuse
        };
        Ok(Self { path, overwrite })
    }

    #[cfg(test)]
    pub(super) fn refusing(path: PathBuf) -> Self {
        Self {
            path,
            overwrite: ExportOverwrite::Refuse,
        }
    }
}

#[derive(Default)]
pub(super) struct ExportTargetInbox {
    targets: Mutex<BTreeMap<ConfigRequestId, SelectedExportTarget>>,
}

impl ExportTargetInbox {
    pub(super) fn insert(
        &self,
        request_id: ConfigRequestId,
        target: SelectedExportTarget,
    ) -> Result<(), ConfigOperationsHostError> {
        let mut targets = self.targets.lock().map_err(|_| {
            ConfigOperationsHostError::authority("backup export target lock is poisoned", true)
        })?;
        if targets.contains_key(&request_id) {
            return Err(ConfigOperationsHostError::authority(
                "backup export request already has a selected target",
                false,
            ));
        }
        if targets.len() >= MAX_PENDING_EXPORT_TARGETS {
            return Err(ConfigOperationsHostError::authority(
                "backup export target capacity is exhausted",
                true,
            ));
        }
        targets.insert(request_id, target);
        Ok(())
    }

    pub(super) fn take(
        &self,
        request_id: &ConfigRequestId,
    ) -> Result<Option<SelectedExportTarget>, ConfigOperationsHostError> {
        self.targets
            .lock()
            .map(|mut targets| targets.remove(request_id))
            .map_err(|_| {
                ConfigOperationsHostError::authority("backup export target lock is poisoned", true)
            })
    }

    fn discard(&self, request_id: &ConfigRequestId) {
        if let Ok(mut targets) = self.targets.lock() {
            targets.remove(request_id);
        }
    }
}

pub(crate) struct NucleusBackupExportState {
    service: Arc<dyn ConfigOperationsCommandService>,
    targets: Arc<ExportTargetInbox>,
}

impl NucleusBackupExportState {
    pub(super) fn new(
        service: Arc<dyn ConfigOperationsCommandService>,
        targets: Arc<ExportTargetInbox>,
    ) -> Self {
        Self { service, targets }
    }
}

#[tauri::command]
pub(crate) async fn longhorn_config_backup_export(
    window: WebviewWindow,
    state: tauri::State<'_, NucleusBackupExportState>,
    command: BackupExportCommand,
) -> Result<BackupExportOutcome, ConfigOperationsHostError> {
    if command.protocol_version != ConfigProtocolVersion::CURRENT {
        return Ok(rejected(
            ConfigOperationRejectionCode::Unsupported,
            "backup export protocol version is unsupported",
        ));
    }
    let digest = match Sha256Digest::new(command.archive_sha256.clone()) {
        Ok(digest) => digest,
        Err(_) => {
            return Ok(rejected(
                ConfigOperationRejectionCode::ArchiveChanged,
                "backup export archive digest is invalid",
            ));
        }
    };
    let file_name = format!("nucleus-backup-{}.longhorn-backup", &digest.as_str()[..12]);
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Export Nucleus backup")
        .set_file_name(file_name)
        .add_filter("Nucleus backup", &["longhorn-backup"])
        .save_file(move |selected| {
            let _ = sender.try_send(selected);
        });
    let Some(selected) = receiver.recv().await else {
        return Err(ConfigOperationsHostError::authority(
            "backup export picker closed without a result",
            true,
        ));
    };
    let Some(selected) = selected else {
        return Ok(rejected(
            ConfigOperationRejectionCode::SelectionCancelled,
            "backup export destination selection was cancelled",
        ));
    };
    let target = SelectedExportTarget::from_picker(selected.into_path().map_err(|error| {
        ConfigOperationsHostError::authority(
            format!("backup export picker path is invalid: {error}"),
            false,
        )
    })?)?;
    let request_id = command.request_id.clone();
    state.targets.insert(request_id.clone(), target)?;
    let _target_guard = ExportTargetGuard {
        targets: Arc::clone(&state.targets),
        request_id,
    };
    let service = Arc::clone(&state.service);
    let caller = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || service.export_backup(&caller, command))
        .await
        .map_err(|error| {
            ConfigOperationsHostError::authority(
                format!("backup export worker failed: {error}"),
                true,
            )
        })?
}

struct ExportTargetGuard {
    targets: Arc<ExportTargetInbox>,
    request_id: ConfigRequestId,
}

impl Drop for ExportTargetGuard {
    fn drop(&mut self) {
        self.targets.discard(&self.request_id);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum SelectedExportError {
    ArchiveChanged,
    ArchiveCorrupt(String),
    DestinationChanged,
    Policy(String),
    Publication(String),
}

pub(super) fn publish_selected_export(
    candidate: &BackupOperationalCandidate,
    target: &SelectedExportTarget,
) -> Result<BackupPublicationReceiptProjection, SelectedExportError> {
    let limits = BackupArchiveLimits::default();
    let metadata =
        fs::metadata(candidate.path()).map_err(|_| SelectedExportError::ArchiveChanged)?;
    if metadata.len() > limits.max_archive_bytes() as u64 {
        return Err(SelectedExportError::ArchiveChanged);
    }
    let source = fs::read(candidate.path()).map_err(|_| SelectedExportError::ArchiveChanged)?;
    if Sha256Digest::from_bytes(&source) != *candidate.archive_sha256() {
        return Err(SelectedExportError::ArchiveChanged);
    }
    let inspection = inspect_backup_archive(&source, limits)
        .map_err(|error| SelectedExportError::ArchiveCorrupt(error.to_string()))?;
    let archive = encode_backup_export_archive(&inspection, limits)
        .map_err(|error| SelectedExportError::ArchiveCorrupt(error.to_string()))?;
    let parent = target
        .path
        .parent()
        .ok_or_else(|| SelectedExportError::Policy("backup export target has no parent".into()))?;
    let file_name = target
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            SelectedExportError::Policy("backup export file name is not valid UTF-8".into())
        })?;
    let file_name = BackupArchiveFileName::new(file_name)
        .map_err(|error| SelectedExportError::Policy(error.to_string()))?;
    let export_target = BackupExportTarget::new(parent, file_name)
        .map_err(|error| SelectedExportError::Policy(error.to_string()))?;
    let receipt = export_backup(
        &export_target,
        &archive,
        target.overwrite,
        BackupPublicationOptions::new(DurabilityRequirement::Durable, limits),
    )
    .map_err(|error| {
        if error.detail.contains("already exists") {
            SelectedExportError::DestinationChanged
        } else {
            SelectedExportError::Publication(error.to_string())
        }
    })?;
    (&receipt)
        .try_into()
        .map_err(|error: longhorn_config::ConfigOperationProjectionError| {
            SelectedExportError::Publication(error.to_string())
        })
}

fn rejected(code: ConfigOperationRejectionCode, detail: &str) -> BackupExportOutcome {
    BackupExportOutcome::Rejected {
        rejection: ConfigOperationRejection {
            code,
            detail: detail.into(),
            snapshot: None,
        },
    }
}
