use std::path::{Path, PathBuf};
use std::time::Duration;

use longhorn_config::{
    encode_backup_archive, publish_operational_backup, BackupAdapter, BackupAdapterCapabilities,
    BackupAdapterCapture, BackupAdapterCaptureMode, BackupAdapterCaptureRequest,
    BackupAdapterConsistencyGroup, BackupAdapterError, BackupAdapterGroupedApplyRequest,
    BackupAdapterGroupedRestore, BackupAdapterGroupedStageRequest,
    BackupAdapterGroupedVerifyRequest, BackupAdapterId, BackupAdapterInspectRequest,
    BackupAdapterPayload, BackupAdapterRelativePath, BackupAdapterRestoreOutcome,
    BackupAdapterRestoreParticipation, BackupAdapterRestorePreview, BackupAdapterRestoreRequest,
    BackupAdapterRestoreStage, BackupAdapterStateEvidence, BackupApplication,
    BackupArchiveFileName, BackupArchiveInspection, BackupArchiveLimits, BackupCaptureOptions,
    BackupCatalog, BackupKind, BackupLimits, BackupMetadata, BackupOperationalRoot, BackupProducer,
    BackupPublicationOptions, BackupScope, BackupSourceState, ConfigDomain, ConfigStore,
    CoordinationAuthority, DomainDescriptor, DomainFilePath, DomainIssue, DurabilityRequirement,
    MigrationStep, RestoreAdapterGroupExecutionOptions, RestoreAdapterGroupExecutionReceipt,
    RestoreAdapterGroupRecoveryReceipt, Sha256Digest, StorageClass, StorageRoots,
};
use longhorn_core::{DomainId, SchemaVersion};
use serde_json::Value;

use self::{file::FileCaptureAdapter, sqlite::SqliteCaptureAdapter};

mod file;
mod grouped;
mod sqlite;
#[cfg(test)]
mod tests;

pub(super) use grouped::{
    execute as execute_grouped_restore, prepare as prepare_grouped_restore,
    recover as recover_grouped_restore,
};

const LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_DOMAIN_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 192 * 1024 * 1024;
const PRODUCER_ID: &str = "longhorn-config";
const PRODUCER_VERSION: &str = "0.1.0";

pub(super) fn sequence(local: u64) -> u64 {
    let now = time::OffsetDateTime::now_utc()
        .unix_timestamp_nanos()
        .unsigned_abs();
    u64::try_from(now).unwrap_or(u64::MAX).saturating_add(local)
}

#[derive(Clone, Debug)]
pub(super) struct BackupSources {
    pub database: PathBuf,
    pub preferences: PathBuf,
    pub keymap: PathBuf,
    pub project_layouts: PathBuf,
    pub panel_presentations: PathBuf,
    pub window_placement: PathBuf,
    pub notifications: PathBuf,
}

pub(super) struct CaptureResult {
    pub capture: longhorn_config::BackupCaptureReceiptProjection,
    pub publication: longhorn_config::BackupPublicationReceiptProjection,
}

pub(super) fn capture(
    roots: &StorageRoots,
    sources: &BackupSources,
    sequence: u64,
) -> Result<CaptureResult, String> {
    let domains = domains()?;
    let adapters = adapters(sources)?;
    let coordination =
        CoordinationAuthority::new(roots.data()).map_err(|error| error.to_string())?;
    let mut store = ConfigStore::new(roots.clone(), coordination);
    let mut catalog = BackupCatalog::new();
    for (domain, adapter) in domains.iter().zip(adapters.iter()) {
        store.register(domain).map_err(|error| error.to_string())?;
        catalog
            .custom(domain, adapter.as_ref())
            .map_err(|error| error.to_string())?;
    }

    let created_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| error.to_string())?;
    let archive_id = format!("nucleus-{sequence}");
    let metadata = BackupMetadata::new(
        &archive_id,
        BackupKind::Operational,
        &created_at,
        application()?,
        producer()?,
    )
    .map_err(|error| error.to_string())?;
    let snapshot = store
        .capture_backup(
            &catalog,
            &BackupScope::AllRegistered,
            metadata,
            BackupCaptureOptions::new(LOCK_TIMEOUT, backup_limits()?),
        )
        .map_err(|error| error.to_string())?;
    let archive = encode_backup_archive(&snapshot, BackupArchiveLimits::default())
        .map_err(|error| error.to_string())?;
    let root = BackupOperationalRoot::new(roots.backup()).map_err(|error| error.to_string())?;
    let file_name = BackupArchiveFileName::new(format!("{archive_id}.longhorn-backup"))
        .map_err(|error| error.to_string())?;
    let publication = publish_operational_backup(
        &root,
        &file_name,
        &archive,
        BackupPublicationOptions::new(
            DurabilityRequirement::Durable,
            BackupArchiveLimits::default(),
        ),
    )
    .map_err(|error| error.to_string())?;
    Ok(CaptureResult {
        capture: snapshot.receipt().into(),
        publication: (&publication)
            .try_into()
            .map_err(|error: longhorn_config::ConfigOperationProjectionError| error.to_string())?,
    })
}

fn domains() -> Result<Vec<OpaqueDomain>, String> {
    [
        ("nucleus.database", StorageClass::UserConfig),
        ("nucleus.preferences", StorageClass::UserConfig),
        ("nucleus.command-keymap", StorageClass::UserConfig),
        ("nucleus.project-layouts", StorageClass::UserConfig),
        ("nucleus.panel-presentations", StorageClass::UserConfig),
        ("nucleus.window-placement", StorageClass::MachineState),
        ("nucleus.notifications", StorageClass::MachineState),
    ]
    .into_iter()
    .map(|(id, class)| OpaqueDomain::new(id, class))
    .collect()
}

fn adapters(sources: &BackupSources) -> Result<Vec<Box<dyn BackupAdapter>>, String> {
    Ok(vec![
        Box::new(SqliteCaptureAdapter::new(sources.database.clone())?),
        Box::new(FileCaptureAdapter::new(
            "nucleus-preferences-v1",
            sources.preferences.clone(),
        )?),
        Box::new(FileCaptureAdapter::new(
            "nucleus-command-keymap-v1",
            sources.keymap.clone(),
        )?),
        Box::new(FileCaptureAdapter::new(
            "nucleus-project-layouts-v1",
            sources.project_layouts.clone(),
        )?),
        Box::new(FileCaptureAdapter::new(
            "nucleus-panel-presentations-v1",
            sources.panel_presentations.clone(),
        )?),
        Box::new(FileCaptureAdapter::new(
            "nucleus-window-placement-v1",
            sources.window_placement.clone(),
        )?),
        Box::new(FileCaptureAdapter::new(
            "nucleus-notifications-v1",
            sources.notifications.clone(),
        )?),
    ])
}

struct OpaqueDomain {
    descriptor: DomainDescriptor,
}

impl OpaqueDomain {
    fn new(id: &str, class: StorageClass) -> Result<Self, String> {
        let file = format!("backup-authority/{}.json", id.replace('.', "-"));
        Ok(Self {
            descriptor: DomainDescriptor::new(
                DomainId::new(id).map_err(|error| error.to_string())?,
                SchemaVersion::new(1).map_err(|error| error.to_string())?,
                class,
                Some(DomainFilePath::new(file).map_err(|error| error.to_string())?),
            )
            .map_err(|error| error.to_string())?,
        })
    }
}

impl ConfigDomain for OpaqueDomain {
    type Value = Value;

    fn descriptor(&self) -> &DomainDescriptor {
        &self.descriptor
    }

    fn default_value(&self) -> Self::Value {
        Value::Null
    }

    fn decode(&self, value: Value) -> Result<Self::Value, DomainIssue> {
        Ok(value)
    }

    fn encode(&self, value: &Self::Value) -> Result<Value, DomainIssue> {
        Ok(value.clone())
    }

    fn validate(&self, _value: &Self::Value) -> Result<(), DomainIssue> {
        Ok(())
    }

    fn validate_raw(
        &self,
        _schema_version: SchemaVersion,
        _value: &Value,
    ) -> Result<(), DomainIssue> {
        Ok(())
    }

    fn migrate_one(
        &self,
        _from: SchemaVersion,
        _value: Value,
    ) -> Result<Option<MigrationStep>, DomainIssue> {
        Ok(None)
    }
}

fn application() -> Result<BackupApplication, String> {
    BackupApplication::new("com.inflatablecookie.nucleus", env!("CARGO_PKG_VERSION"))
        .map_err(|error| error.to_string())
}

fn producer() -> Result<BackupProducer, String> {
    BackupProducer::new(PRODUCER_ID, PRODUCER_VERSION).map_err(|error| error.to_string())
}

fn backup_limits() -> Result<BackupLimits, String> {
    BackupLimits::new(MAX_DOMAIN_BYTES, MAX_TOTAL_BYTES).map_err(|error| error.to_string())
}

fn grouped_capabilities(group: &str) -> Result<BackupAdapterCapabilities, String> {
    Ok(BackupAdapterCapabilities::new(
        BackupAdapterCaptureMode::ExternalSnapshot(
            BackupAdapterConsistencyGroup::new(group, "nucleus-bounded-snapshot")
                .map_err(|error| error.to_string())?,
        ),
        BackupAdapterRestoreParticipation::GroupedFailureAtomic,
    ))
}

fn only_payload<'a>(
    request: &'a BackupAdapterInspectRequest<'a>,
) -> Result<&'a [u8], BackupAdapterError> {
    let [payload] = request.payloads() else {
        return Err(adapter_error("payload-count"));
    };
    Ok(payload.bytes())
}

fn adapter_error(code: &str) -> BackupAdapterError {
    BackupAdapterError::failed(code).expect("static adapter code must be valid")
}
