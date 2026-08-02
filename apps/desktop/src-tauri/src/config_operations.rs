use std::sync::Arc;

use longhorn_config::{
    list_operational_backups, BackupApplication, BackupArchiveLimits, BackupCreateCommand,
    BackupCreateOutcome, BackupEncryptionState, BackupExportCommand, BackupExportOutcome,
    BackupInventoryProjection, BackupOperationalRoot, BackupOperationsProjection,
    BackupPendingState, BackupRetentionApplyCommand, BackupRetentionApplyOutcome,
    BackupRetentionProjection, ConfigGeneration, ConfigOperationCapability,
    ConfigOperationRejection, ConfigOperationRejectionCode, ConfigOperationsSnapshot,
    ConfigProtocolVersion, ConfigSnapshotCommand, RestoreAdapterExecuteCommand,
    RestoreAdapterExecuteOutcome, RestoreExecuteCommand, RestoreExecuteOutcome,
    RestoreInspectCommand, RestoreInspectOutcome, RestoreOperationStateProjection,
    RestoreOperationsProjection, RestorePlanCommand, RestorePlanOutcome, RestoreRecoveryCommand,
    RestoreRecoveryOutcomeProjection, StorageBootstrapProjection, StorageCleanupCommand,
    StorageCleanupOutcome, StorageLayoutProjection, StorageOperationsProjection, StorageProfileId,
    StorageRecoveryCommand, StorageRecoveryOutcome, StorageTransitionExecuteCommand,
    StorageTransitionExecuteOutcome, StorageTransitionInspectCommand,
    StorageTransitionInspectOutcome,
};
use longhorn_tauri_config::{
    ConfigOperationsAuthority, ConfigOperationsCommandService, ConfigOperationsHandlerAssembly,
    ConfigOperationsHostError, TauriConfigOperationsState,
};
use tauri::Manager;

use crate::desktop_profile::{DesktopProfile, CANONICAL_APPLICATION_ID};

mod backup_domains;
pub(crate) mod export;
mod retention;

const CALLER_LABEL: &str = "main";
const MAX_SCAN_ENTRIES: usize = 1_024;

pub(crate) fn install(app: &tauri::App, profile: DesktopProfile) -> Result<(), String> {
    let export_targets = Arc::new(export::ExportTargetInbox::default());
    let authority = NucleusConfigOperationsAuthority::new(profile, Arc::clone(&export_targets))?;
    let service: Arc<dyn ConfigOperationsCommandService> =
        Arc::new(ConfigOperationsHandlerAssembly::new(authority));
    app.manage(export::NucleusBackupExportState::new(
        Arc::clone(&service),
        export_targets,
    ));
    app.manage(TauriConfigOperationsState::new(service));
    Ok(())
}

struct NucleusConfigOperationsAuthority {
    profile: DesktopProfile,
    sources: backup_domains::BackupSources,
    generation: ConfigGeneration,
    capture_sequence: u64,
    export_targets: Arc<export::ExportTargetInbox>,
}

impl NucleusConfigOperationsAuthority {
    fn new(
        profile: DesktopProfile,
        export_targets: Arc<export::ExportTargetInbox>,
    ) -> Result<Self, String> {
        let roots = profile.storage_roots();
        let workspace = profile.workspace_ui_paths();
        Ok(Self {
            sources: backup_domains::BackupSources {
                database: profile.database_path(),
                preferences: roots.config().join("preferences/nucleus.json"),
                keymap: roots.config().join("commands/keymap.json"),
                project_layouts: workspace.project_layouts().to_path_buf(),
                panel_presentations: workspace.panel_presentations().to_path_buf(),
                window_placement: workspace.window_placement().to_path_buf(),
                notifications: roots.state().join("notifications.json"),
            },
            profile,
            generation: ConfigGeneration::new(1),
            capture_sequence: 0,
            export_targets,
        })
    }

    fn authorize(caller: &str) -> Result<(), ConfigOperationsHostError> {
        if caller == CALLER_LABEL {
            Ok(())
        } else {
            Err(ConfigOperationsHostError::authority(
                "configuration operations caller is not authorized",
                false,
            ))
        }
    }

    fn application() -> Result<BackupApplication, ConfigOperationsHostError> {
        BackupApplication::new(CANONICAL_APPLICATION_ID, env!("CARGO_PKG_VERSION"))
            .map_err(Self::operational)
    }

    fn operational(error: impl std::fmt::Display) -> ConfigOperationsHostError {
        ConfigOperationsHostError::authority(error.to_string(), true)
    }

    fn projection(error: impl std::fmt::Display) -> ConfigOperationsHostError {
        ConfigOperationsHostError::authority(error.to_string(), false)
    }

    fn backup_root(&self) -> Result<BackupOperationalRoot, ConfigOperationsHostError> {
        BackupOperationalRoot::new(self.profile.storage_roots().backup()).map_err(Self::operational)
    }

    fn listing(
        &self,
    ) -> Result<longhorn_config::BackupOperationalListing, ConfigOperationsHostError> {
        Ok(list_operational_backups(
            &self.backup_root()?,
            &Self::application()?,
            BackupArchiveLimits::default(),
            MAX_SCAN_ENTRIES,
        ))
    }

    fn snapshot_internal(&self) -> Result<ConfigOperationsSnapshot, ConfigOperationsHostError> {
        let diagnostic = self.profile.storage_diagnostic();
        let layout = StorageLayoutProjection::try_from(&diagnostic).map_err(Self::projection)?;
        let listing = self.listing()?;
        let inventory = BackupInventoryProjection::try_from(&listing).map_err(Self::projection)?;
        let retention = retention::plan(&listing)?
            .map(|(plan, confirmation)| {
                BackupRetentionProjection::try_from_plan(&plan, &confirmation)
                    .map_err(Self::projection)
            })
            .transpose()?;
        Ok(ConfigOperationsSnapshot {
            protocol_version: ConfigProtocolVersion::CURRENT,
            generation: self.generation,
            capabilities: vec![
                ConfigOperationCapability::StorageDiagnostics,
                ConfigOperationCapability::BackupInventory,
                ConfigOperationCapability::BackupCreate,
                ConfigOperationCapability::BackupExport,
                ConfigOperationCapability::BackupRetention,
            ],
            storage: Some(StorageOperationsProjection {
                layout,
                bootstrap: StorageBootstrapProjection::Selected {
                    origin: "resolvedStartup".into(),
                    locator_path: None,
                    transition_id: None,
                    last_committed_layout_digest: Some(self.profile.layout_digest().to_owned()),
                },
                available_profiles: vec![
                    StorageProfileId::PlatformNativeV1,
                    StorageProfileId::PortableV1,
                ],
            }),
            backup: Some(BackupOperationsProjection {
                inventory,
                pending: BackupPendingState::Clear,
                encryption: BackupEncryptionState::Unavailable,
                retention,
            }),
            restore: Some(RestoreOperationsProjection {
                state: RestoreOperationStateProjection::Inactive,
                safety_backup_sha256: None,
            }),
        })
    }

    fn unsupported(&self, detail: &str) -> ConfigOperationRejection {
        rejection(ConfigOperationRejectionCode::Unsupported, detail)
    }

    fn bump_generation(&mut self) {
        self.generation = ConfigGeneration::new(self.generation.get().saturating_add(1));
    }
}

impl ConfigOperationsAuthority for NucleusConfigOperationsAuthority {
    fn snapshot(
        &mut self,
        caller: &str,
        _command: ConfigSnapshotCommand,
    ) -> Result<ConfigOperationsSnapshot, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        self.snapshot_internal()
    }

    fn inspect_storage_transition(
        &mut self,
        caller: &str,
        _command: StorageTransitionInspectCommand,
    ) -> Result<StorageTransitionInspectOutcome, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        Ok(StorageTransitionInspectOutcome::Rejected {
            rejection: self
                .unsupported("storage profile transitions are not composed in Nucleus Settings"),
        })
    }

    fn execute_storage_transition(
        &mut self,
        caller: &str,
        _command: StorageTransitionExecuteCommand,
    ) -> Result<StorageTransitionExecuteOutcome, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        Ok(StorageTransitionExecuteOutcome::Rejected {
            rejection: self
                .unsupported("storage profile transitions are not composed in Nucleus Settings"),
        })
    }

    fn recover_storage(
        &mut self,
        caller: &str,
        _command: StorageRecoveryCommand,
    ) -> Result<StorageRecoveryOutcome, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        Ok(StorageRecoveryOutcome::Rejected {
            rejection: self.unsupported("storage transition recovery is not composed"),
        })
    }

    fn cleanup_storage(
        &mut self,
        caller: &str,
        _command: StorageCleanupCommand,
    ) -> Result<StorageCleanupOutcome, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        Ok(StorageCleanupOutcome::Rejected {
            rejection: self.unsupported("storage transition cleanup is not composed"),
        })
    }

    fn create_backup(
        &mut self,
        caller: &str,
        _command: BackupCreateCommand,
    ) -> Result<BackupCreateOutcome, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        self.capture_sequence = self.capture_sequence.saturating_add(1);
        let sequence = backup_domains::sequence(self.capture_sequence);
        let result = backup_domains::capture(self.profile.storage_roots(), &self.sources, sequence)
            .map_err(Self::operational)?;
        self.bump_generation();
        Ok(BackupCreateOutcome::Published {
            capture: result.capture,
            publication: result.publication,
            snapshot: Box::new(self.snapshot_internal()?),
        })
    }

    fn export_backup(
        &mut self,
        caller: &str,
        command: BackupExportCommand,
    ) -> Result<BackupExportOutcome, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        if command.protocol_version != ConfigProtocolVersion::CURRENT {
            return Ok(BackupExportOutcome::Rejected {
                rejection: rejection(
                    ConfigOperationRejectionCode::Unsupported,
                    "backup export protocol version is unsupported",
                ),
            });
        }
        let Some(target) = self.export_targets.take(&command.request_id)? else {
            return Ok(BackupExportOutcome::Rejected {
                rejection: rejection(
                    ConfigOperationRejectionCode::SelectionCancelled,
                    "backup export has no matching host-selected destination",
                ),
            });
        };
        let listing = self.listing()?;
        let Some(candidate) = listing
            .candidates()
            .iter()
            .find(|candidate| candidate.archive_sha256().as_str() == command.archive_sha256)
        else {
            return Ok(BackupExportOutcome::Rejected {
                rejection: rejection(
                    ConfigOperationRejectionCode::ArchiveChanged,
                    "backup export source is absent or changed",
                ),
            });
        };
        let publication = match export::publish_selected_export(candidate, &target) {
            Ok(publication) => publication,
            Err(export::SelectedExportError::ArchiveChanged) => {
                return Ok(BackupExportOutcome::Rejected {
                    rejection: rejection(
                        ConfigOperationRejectionCode::ArchiveChanged,
                        "backup export source changed during selection",
                    ),
                });
            }
            Err(export::SelectedExportError::ArchiveCorrupt(detail)) => {
                return Ok(BackupExportOutcome::Rejected {
                    rejection: rejection(ConfigOperationRejectionCode::ArchiveCorrupt, &detail),
                });
            }
            Err(export::SelectedExportError::DestinationChanged) => {
                return Ok(BackupExportOutcome::Rejected {
                    rejection: rejection(
                        ConfigOperationRejectionCode::AuthorityChanged,
                        "backup export destination changed after selection",
                    ),
                });
            }
            Err(export::SelectedExportError::Policy(detail)) => {
                return Ok(BackupExportOutcome::Rejected {
                    rejection: rejection(ConfigOperationRejectionCode::PolicyBlocked, &detail),
                });
            }
            Err(export::SelectedExportError::Publication(detail)) => {
                return Err(Self::operational(detail));
            }
        };
        self.bump_generation();
        Ok(BackupExportOutcome::Published {
            publication,
            snapshot: Box::new(self.snapshot_internal()?),
        })
    }

    fn apply_backup_retention(
        &mut self,
        caller: &str,
        command: BackupRetentionApplyCommand,
    ) -> Result<BackupRetentionApplyOutcome, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        if command.generation != self.generation {
            return Ok(BackupRetentionApplyOutcome::Rejected {
                rejection: rejection(
                    ConfigOperationRejectionCode::AuthorityChanged,
                    "backup inventory changed after confirmation",
                ),
            });
        }
        let listing = self.listing()?;
        let Some((plan, confirmation)) = retention::plan(&listing)? else {
            return Ok(BackupRetentionApplyOutcome::Rejected {
                rejection: rejection(
                    ConfigOperationRejectionCode::ConfirmationMismatch,
                    "no backup retention plan is available",
                ),
            });
        };
        if command.confirmation_digest != confirmation.as_str() {
            return Ok(BackupRetentionApplyOutcome::Rejected {
                rejection: rejection(
                    ConfigOperationRejectionCode::ConfirmationMismatch,
                    "backup retention confirmation does not match current evidence",
                ),
            });
        }
        let deleted_paths = retention::apply(&plan)?;
        self.bump_generation();
        Ok(BackupRetentionApplyOutcome::Applied {
            deleted_paths,
            snapshot: Box::new(self.snapshot_internal()?),
        })
    }

    fn inspect_restore(
        &mut self,
        caller: &str,
        _command: RestoreInspectCommand,
    ) -> Result<RestoreInspectOutcome, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        Ok(RestoreInspectOutcome::Rejected { rejection: self.unsupported("restore remains closed until failure-atomic publication and durable recovery are composed") })
    }

    fn plan_restore(
        &mut self,
        caller: &str,
        _command: RestorePlanCommand,
    ) -> Result<RestorePlanOutcome, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        Ok(RestorePlanOutcome::Rejected {
            rejection: self.unsupported("restore planning is not composed"),
        })
    }

    fn execute_restore(
        &mut self,
        caller: &str,
        _command: RestoreExecuteCommand,
    ) -> Result<RestoreExecuteOutcome, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        Ok(RestoreExecuteOutcome::Rejected {
            rejection: self.unsupported("restore execution is not composed"),
        })
    }

    fn execute_adapter_restore(
        &mut self,
        caller: &str,
        _command: RestoreAdapterExecuteCommand,
    ) -> Result<RestoreAdapterExecuteOutcome, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        Ok(RestoreAdapterExecuteOutcome::Rejected {
            rejection: self.unsupported("custom restore adapters are not composed"),
        })
    }

    fn recover_restore(
        &mut self,
        caller: &str,
        _command: RestoreRecoveryCommand,
    ) -> Result<RestoreRecoveryOutcomeProjection, ConfigOperationsHostError> {
        Self::authorize(caller)?;
        Ok(RestoreRecoveryOutcomeProjection::Rejected {
            rejection: self.unsupported("restore recovery is not composed"),
        })
    }
}

fn rejection(code: ConfigOperationRejectionCode, detail: &str) -> ConfigOperationRejection {
    ConfigOperationRejection {
        code,
        detail: detail.into(),
        snapshot: None,
    }
}

#[cfg(test)]
mod tests;
