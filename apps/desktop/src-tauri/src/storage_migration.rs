use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use longhorn_config::{
    execute_storage_transition, inspect_storage_transition, plan_storage_transition,
    recover_storage_transition, BackupAdapter, BackupAdapterCapabilities, BackupAdapterCapture,
    BackupAdapterCaptureMode, BackupAdapterCaptureRequest, BackupAdapterConsistencyGroup,
    BackupAdapterError, BackupAdapterId, BackupAdapterInspectRequest, BackupAdapterPayload,
    BackupAdapterRelativePath, BackupAdapterRestoreOutcome, BackupAdapterRestoreParticipation,
    BackupAdapterRestorePreview, BackupAdapterRestoreRequest, ConfigDomain, ConfigStore,
    CoordinationAuthority, DomainDescriptor, DomainFilePath, DomainIssue, MigrationStep,
    ResolvedStorageLayout, Sha256Digest, StorageBootstrapPaths, StorageClass,
    StorageProfileSelection, StorageTransitionAction, StorageTransitionAdapter,
    StorageTransitionCatalog, StorageTransitionExecutionOptions, StorageTransitionGuard,
    StorageTransitionOutcome, StorageTransitionRequest,
};
use longhorn_core::{DomainId, SchemaVersion};
use rusqlite::{Connection, OpenFlags, MAIN_DB};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tempfile::{tempdir, tempdir_in, NamedTempFile};

use crate::workspace_ui;

const TRANSITION_ID: &str = "nucleus-dot-root-import-v1";
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyImportReceipt {
    pub schema_version: u32,
    pub canonical_application_id: String,
    pub transition_id: String,
    pub outcome: String,
    pub target_layout_sha256: String,
    pub transition_receipt_sha256: String,
    pub custom_domains: Vec<String>,
    pub retained_source_root: PathBuf,
    pub retained_unknown_files: Vec<PathBuf>,
}

pub struct LegacyImportRequest<'request> {
    pub canonical_application_id: &'request str,
    pub source_layout: &'request ResolvedStorageLayout,
    pub target_layout: &'request ResolvedStorageLayout,
    pub target_selection: StorageProfileSelection,
    pub bootstrap: StorageBootstrapPaths,
}

pub fn import_legacy_storage(
    request: LegacyImportRequest<'_>,
) -> Result<Option<LegacyImportReceipt>, String> {
    let source_root = request
        .source_layout
        .root(longhorn_config::RootKind::Config)
        .and_then(|root| root.path().parent())
        .ok_or_else(|| "legacy portable layout has no root".to_owned())?
        .to_path_buf();
    if !source_root.exists() {
        return Ok(None);
    }
    if !source_root.is_dir() {
        return Err(format!(
            "legacy Nucleus root is not a directory: {}",
            source_root.display()
        ));
    }

    prepare_layout_roots(request.target_layout)?;
    let coordination_root = request.target_layout.storage_roots().data();
    let authority = CoordinationAuthority::new(coordination_root)
        .map_err(|error| format!("create storage migration authority failed: {error}"))?;
    let mut source_store = ConfigStore::new(
        request.source_layout.storage_roots().clone(),
        authority.clone(),
    );
    let mut target_store =
        ConfigStore::new(request.target_layout.storage_roots().clone(), authority);

    let ui_domain = MigrationDomain::new(
        "nucleus.desktop-ui",
        StorageClass::MachineState,
        "migration/ui-authority.json",
    )?;
    let database_domain = MigrationDomain::new(
        "nucleus.database",
        StorageClass::MachineState,
        "migration/database-authority.json",
    )?;
    let snapshots_domain = MigrationDomain::new(
        "nucleus.task-review-snapshots",
        StorageClass::WorkspaceLocal,
        "migration/task-review-snapshots-authority.json",
    )?;
    let drafts_domain = MigrationDomain::new(
        "nucleus.editor-drafts",
        StorageClass::WorkspaceLocal,
        "migration/editor-drafts-authority.json",
    )?;
    for domain in [
        &ui_domain,
        &database_domain,
        &snapshots_domain,
        &drafts_domain,
    ] {
        source_store
            .register(domain)
            .map_err(|error| format!("register legacy migration domain failed: {error}"))?;
        target_store
            .register(domain)
            .map_err(|error| format!("register target migration domain failed: {error}"))?;
    }

    let source_ui = UiTransitionAdapter::legacy(
        request
            .source_layout
            .storage_roots()
            .config()
            .join("ui.json"),
        "nucleus-legacy-ui",
    );
    let target_ui = UiTransitionAdapter::split(
        request
            .target_layout
            .storage_roots()
            .state()
            .join("window-placement.json"),
        request
            .target_layout
            .storage_roots()
            .config()
            .join("project-layouts.json"),
        "nucleus-split-ui",
    );
    let source_database = SqliteTransitionAdapter::new(
        request
            .source_layout
            .storage_roots()
            .state()
            .join("nucleus.sqlite"),
        "nucleus-legacy-sqlite",
    )?;
    let target_database = SqliteTransitionAdapter::new(
        request
            .target_layout
            .durable_database_dir()
            .join("nucleus.sqlite"),
        "nucleus-native-sqlite",
    )?;
    let source_snapshots = TreeTransitionAdapter::new(
        request
            .source_layout
            .storage_roots()
            .state()
            .join("task-review-snapshots"),
        "nucleus-legacy-snapshots",
    )?;
    let target_snapshots = TreeTransitionAdapter::new(
        request
            .target_layout
            .storage_roots()
            .state()
            .join("task-review-snapshots"),
        "nucleus-native-snapshots",
    )?;
    let source_drafts = TreeTransitionAdapter::new(
        request
            .source_layout
            .storage_roots()
            .state()
            .join("editor-drafts"),
        "nucleus-legacy-drafts",
    )?;
    let target_drafts = TreeTransitionAdapter::new(
        request
            .target_layout
            .storage_roots()
            .state()
            .join("editor-drafts"),
        "nucleus-native-drafts",
    )?;

    let mut catalog = StorageTransitionCatalog::new();
    catalog
        .custom(&ui_domain, &source_ui, &target_ui)
        .map_err(|domain| format!("duplicate transition policy for {domain}"))?;
    catalog
        .custom(&database_domain, &source_database, &target_database)
        .map_err(|domain| format!("duplicate transition policy for {domain}"))?;
    catalog
        .custom(&snapshots_domain, &source_snapshots, &target_snapshots)
        .map_err(|domain| format!("duplicate transition policy for {domain}"))?;
    catalog
        .custom(&drafts_domain, &source_drafts, &target_drafts)
        .map_err(|domain| format!("duplicate transition policy for {domain}"))?;

    let transition = StorageTransitionRequest::new(
        &source_store,
        &target_store,
        request.source_layout,
        request.target_layout,
        request.target_selection,
        &catalog,
        request.bootstrap.clone(),
    );

    if let Some(recovery) = recover_storage_transition(&transition, LOCK_TIMEOUT)
        .map_err(|error| format!("recover Nucleus storage import failed: {error}"))?
    {
        if recovery.outcome() == StorageTransitionOutcome::TargetCommitted {
            return read_import_receipt(&request.bootstrap);
        }
    }

    let preview = inspect_storage_transition(&transition)
        .map_err(|error| format!("inspect legacy Nucleus storage failed: {error}"))?;
    let recognized = preview.domains().iter().any(|domain| {
        !matches!(
            domain.action(),
            StorageTransitionAction::Absent | StorageTransitionAction::Excluded(_)
        )
    });
    if !recognized {
        if preview.source_unknown().is_empty() {
            return Ok(None);
        }
        return Err("legacy .nucleus contains only unrecognized files; import refused".to_owned());
    }
    let retained_unknown_files = preview
        .source_unknown()
        .iter()
        .map(|entry| entry.path().to_path_buf())
        .collect::<Vec<_>>();
    let plan = plan_storage_transition(&preview)
        .map_err(|error| format!("plan legacy Nucleus storage import failed: {error}"))?;
    let receipt = execute_storage_transition(
        &transition,
        &plan,
        plan.confirmation_digest(),
        StorageTransitionExecutionOptions::new(TRANSITION_ID, LOCK_TIMEOUT)
            .map_err(|error| format!("create Nucleus storage transition failed: {error}"))?,
    )
    .map_err(|error| format!("execute legacy Nucleus storage import failed: {error}"))?;
    if receipt.outcome() != StorageTransitionOutcome::TargetCommitted {
        return Err("legacy Nucleus storage import did not commit its target".to_owned());
    }
    let document = LegacyImportReceipt {
        schema_version: 1,
        canonical_application_id: request.canonical_application_id.to_owned(),
        transition_id: receipt.transition_id().to_owned(),
        outcome: "target-committed".to_owned(),
        target_layout_sha256: receipt.target_layout_digest().as_str().to_owned(),
        transition_receipt_sha256: receipt.receipt_digest().as_str().to_owned(),
        custom_domains: receipt
            .custom_domains()
            .iter()
            .map(ToString::to_string)
            .collect(),
        retained_source_root: source_root,
        retained_unknown_files,
    };
    write_import_receipt(&request.bootstrap, &document)?;
    Ok(Some(document))
}

fn prepare_layout_roots(layout: &ResolvedStorageLayout) -> Result<(), String> {
    for root in layout.diagnostic().roots() {
        fs::create_dir_all(root.path()).map_err(|error| {
            format!(
                "create storage root {} failed: {error}",
                root.path().display()
            )
        })?;
    }
    fs::create_dir_all(layout.durable_database_dir())
        .map_err(|error| format!("create database directory failed: {error}"))
}

fn receipt_path(bootstrap: &StorageBootstrapPaths) -> PathBuf {
    bootstrap.directory().join("legacy-import-receipt.json")
}

fn write_import_receipt(
    bootstrap: &StorageBootstrapPaths,
    receipt: &LegacyImportReceipt,
) -> Result<(), String> {
    fs::create_dir_all(bootstrap.directory())
        .map_err(|error| format!("create storage receipt directory failed: {error}"))?;
    let bytes = serde_json::to_vec_pretty(receipt)
        .map_err(|error| format!("encode storage import receipt failed: {error}"))?;
    let mut temporary = NamedTempFile::new_in(bootstrap.directory())
        .map_err(|error| format!("stage storage import receipt failed: {error}"))?;
    std::io::Write::write_all(&mut temporary, &bytes)
        .map_err(|error| format!("write storage import receipt failed: {error}"))?;
    std::io::Write::write_all(&mut temporary, b"\n")
        .map_err(|error| format!("write storage import receipt failed: {error}"))?;
    temporary
        .persist(receipt_path(bootstrap))
        .map_err(|error| format!("commit storage import receipt failed: {}", error.error))?;
    Ok(())
}

pub fn read_import_receipt(
    bootstrap: &StorageBootstrapPaths,
) -> Result<Option<LegacyImportReceipt>, String> {
    let path = receipt_path(bootstrap);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read storage import receipt failed: {error}")),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("decode storage import receipt failed: {error}"))
}

struct MigrationDomain {
    descriptor: DomainDescriptor,
}

impl MigrationDomain {
    fn new(id: &str, class: StorageClass, path: &str) -> Result<Self, String> {
        Ok(Self {
            descriptor: DomainDescriptor::new(
                DomainId::new(id).map_err(|error| error.to_string())?,
                SchemaVersion::new(1).map_err(|error| error.to_string())?,
                class,
                Some(DomainFilePath::new(path).map_err(|error| error.to_string())?),
            )
            .map_err(|error| error.to_string())?,
        })
    }
}

impl ConfigDomain for MigrationDomain {
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

enum UiEndpoint {
    Legacy(PathBuf),
    Split { window: PathBuf, projects: PathBuf },
}

struct UiTransitionAdapter {
    id: BackupAdapterId,
    capabilities: BackupAdapterCapabilities,
    endpoint: UiEndpoint,
    authority: String,
    gate: Mutex<()>,
}

impl UiTransitionAdapter {
    fn legacy(path: PathBuf, authority: &str) -> Self {
        Self::new(UiEndpoint::Legacy(path), authority)
    }
    fn split(window: PathBuf, projects: PathBuf, authority: &str) -> Self {
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
        let payloads = ui_payloads(&request)?;
        Ok(BackupAdapterRestorePreview::new(
            payload_digest(&payloads),
            self.current_evidence(request.descriptor())?,
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
        if payload_digest(&payloads) != *request.preview().target_evidence() {
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

struct SqliteTransitionAdapter {
    id: BackupAdapterId,
    capabilities: BackupAdapterCapabilities,
    database: PathBuf,
    authority: String,
    gate: Mutex<()>,
}

impl SqliteTransitionAdapter {
    fn new(database: PathBuf, authority: &str) -> Result<Self, String> {
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
        let [payload] = request.payloads() else {
            return Err(failure("sqlite-payload"));
        };
        validate_database_bytes(payload.bytes())?;
        Ok(BackupAdapterRestorePreview::new(
            Sha256Digest::from_bytes(payload.bytes()),
            self.current_evidence(request.descriptor())?,
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
        if evidence != *request.preview().target_evidence() {
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

struct TreeTransitionAdapter {
    id: BackupAdapterId,
    capabilities: BackupAdapterCapabilities,
    root: PathBuf,
    authority: String,
    gate: Mutex<()>,
}

impl TreeTransitionAdapter {
    fn new(root: PathBuf, authority: &str) -> Result<Self, String> {
        Ok(Self {
            id: BackupAdapterId::new("nucleus-tree-v1").map_err(|e| e.to_string())?,
            capabilities: BackupAdapterCapabilities::new(
                BackupAdapterCaptureMode::CoordinatedBounded,
                BackupAdapterRestoreParticipation::FailureAtomic,
            ),
            root,
            authority: authority.to_owned(),
            gate: Mutex::new(()),
        })
    }
    fn entries(&self) -> Result<Option<Vec<(String, Vec<u8>)>>, BackupAdapterError> {
        collect_tree(&self.root)
    }
}

impl BackupAdapter for TreeTransitionAdapter {
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
        let Some(entries) = self.entries()? else {
            return Ok(BackupAdapterCapture::Absent);
        };
        let total = entries.iter().map(|(_, bytes)| bytes.len()).sum::<usize>();
        if total > request.limits().max_domain_bytes() {
            return Err(failure("tree-size"));
        }
        let mut payloads = vec![BackupAdapterPayload::new(
            BackupAdapterRelativePath::new("tree-root.marker").expect("static payload path"),
            Vec::new(),
        )];
        payloads.extend(entries.into_iter().map(|(path, bytes)| {
            BackupAdapterPayload::new(
                BackupAdapterRelativePath::new(format!("files/{}.bin", hex(path.as_bytes())))
                    .expect("hex payload path"),
                bytes,
            )
        }));
        Ok(BackupAdapterCapture::Present {
            source_schema_version: request.descriptor().schema_version(),
            payloads,
        })
    }
    fn inspect(
        &self,
        request: BackupAdapterInspectRequest<'_>,
    ) -> Result<BackupAdapterRestorePreview, BackupAdapterError> {
        let entries = tree_payloads(&request)?;
        Ok(BackupAdapterRestorePreview::new(
            payload_digest(&entries),
            self.current_evidence(request.descriptor())?,
        ))
    }
    fn restore(
        &self,
        request: BackupAdapterRestoreRequest<'_>,
    ) -> Result<BackupAdapterRestoreOutcome, BackupAdapterError> {
        if self.root.exists() {
            return Err(failure("tree-target-occupied"));
        }
        let entries = tree_payloads(request.inspect())?;
        if payload_digest(&entries) != *request.preview().target_evidence() {
            return Err(failure("tree-preview"));
        }
        let parent = self.root.parent().ok_or_else(|| failure("tree-parent"))?;
        fs::create_dir_all(parent).map_err(|_| failure("tree-create-parent"))?;
        let staging = tempdir_in(parent).map_err(|_| failure("tree-stage"))?;
        for (relative, bytes) in &entries {
            let path = staging.path().join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|_| failure("tree-create"))?;
            }
            fs::write(path, bytes).map_err(|_| failure("tree-write"))?;
        }
        let staging = staging.keep();
        fs::rename(&staging, &self.root).map_err(|_| failure("tree-commit"))?;
        let evidence = self
            .current_evidence(request.inspect().descriptor())?
            .ok_or_else(|| failure("tree-verify"))?;
        Ok(BackupAdapterRestoreOutcome::Verified { evidence })
    }
}

impl StorageTransitionAdapter for TreeTransitionAdapter {
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
            .map_err(|_| failure("tree-lock"))
    }
    fn owned_paths(&self, _descriptor: &DomainDescriptor) -> Vec<PathBuf> {
        let mut paths = vec![self.root.clone()];
        if let Ok(Some(entries)) = collect_tree_paths(&self.root) {
            paths.extend(entries);
        }
        paths
    }
    fn current_evidence(
        &self,
        _descriptor: &DomainDescriptor,
    ) -> Result<Option<Sha256Digest>, BackupAdapterError> {
        self.entries()
            .map(|entries| entries.map(|items| payload_digest(&items)))
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

fn payload_digest(entries: &[(String, Vec<u8>)]) -> Sha256Digest {
    let mut evidence = b"nucleus-storage-payload-v1\0".to_vec();
    for (path, bytes) in entries {
        evidence.extend_from_slice(&(path.len() as u64).to_be_bytes());
        evidence.extend_from_slice(path.as_bytes());
        evidence.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
        evidence.extend_from_slice(bytes);
    }
    Sha256Digest::from_bytes(&evidence)
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

fn collect_tree(root: &Path) -> Result<Option<Vec<(String, Vec<u8>)>>, BackupAdapterError> {
    let Some(paths) = collect_tree_paths(root)? else {
        return Ok(None);
    };
    let mut entries = paths
        .into_iter()
        .map(|path| {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| failure("tree-confine"))?
                .to_str()
                .ok_or_else(|| failure("tree-path"))?
                .replace(std::path::MAIN_SEPARATOR, "/");
            let bytes = fs::read(&path).map_err(|_| failure("tree-read"))?;
            Ok((relative, bytes))
        })
        .collect::<Result<Vec<_>, BackupAdapterError>>()?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(Some(entries))
}

fn collect_tree_paths(root: &Path) -> Result<Option<Vec<PathBuf>>, BackupAdapterError> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(failure("tree-read")),
    };
    if !metadata.file_type().is_dir() {
        return Err(failure("tree-root"));
    }
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let mut entries = fs::read_dir(directory)
            .map_err(|_| failure("tree-read"))?
            .map(|entry| {
                entry
                    .map(|entry| entry.path())
                    .map_err(|_| failure("tree-read"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        entries.sort();
        for path in entries.into_iter().rev() {
            let metadata = fs::symlink_metadata(&path).map_err(|_| failure("tree-read"))?;
            if metadata.file_type().is_dir() {
                stack.push(path);
            } else if metadata.file_type().is_file() {
                files.push(path);
            } else {
                return Err(failure("tree-special-file"));
            }
        }
    }
    files.sort();
    Ok(Some(files))
}

fn tree_payloads(
    request: &BackupAdapterInspectRequest<'_>,
) -> Result<Vec<(String, Vec<u8>)>, BackupAdapterError> {
    let mut marker = false;
    let mut seen = BTreeSet::new();
    let mut entries = Vec::new();
    for payload in request.payloads() {
        let path = payload.path().as_str();
        if path.ends_with("/tree-root.marker") {
            marker = true;
            continue;
        }
        let encoded = path
            .rsplit('/')
            .next()
            .and_then(|name| name.strip_suffix(".bin"))
            .ok_or_else(|| failure("tree-payload"))?;
        let relative = String::from_utf8(unhex(encoded)?).map_err(|_| failure("tree-path"))?;
        validate_relative_tree_path(&relative)?;
        if !seen.insert(relative.clone()) {
            return Err(failure("tree-duplicate"));
        }
        entries.push((relative, payload.bytes().to_vec()));
    }
    if !marker {
        return Err(failure("tree-marker"));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(entries)
}

fn validate_relative_tree_path(path: &str) -> Result<(), BackupAdapterError> {
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(failure("tree-confine"));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(DIGITS[usize::from(byte >> 4)] as char);
        encoded.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

fn unhex(value: &str) -> Result<Vec<u8>, BackupAdapterError> {
    if value.len() % 2 != 0 {
        return Err(failure("tree-path"));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = hex_value(pair[0]).ok_or_else(|| failure("tree-path"))?;
            let low = hex_value(pair[1]).ok_or_else(|| failure("tree-path"))?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn failure(code: &str) -> BackupAdapterError {
    BackupAdapterError::failed(code).expect("static adapter failure code")
}

#[cfg(test)]
mod tests {
    use super::*;
    use longhorn_config::{
        inspect_storage_bootstrap, resolve_storage_bootstrap_paths, resolve_storage_layout,
        PlatformDirectoryFacts, StorageBootstrapState, StorageIdentity, StorageLayoutRequest,
        StorageProfile, TargetPlatform,
    };
    use rusqlite::params;
    use tempfile::TempDir;

    struct Fixture {
        _temp: TempDir,
        identity: StorageIdentity,
        facts: PlatformDirectoryFacts,
        source: ResolvedStorageLayout,
        target: ResolvedStorageLayout,
        bootstrap: StorageBootstrapPaths,
        legacy_root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().expect("tempdir");
            let identity = StorageIdentity::new("com.inflatablecookie.nucleus").unwrap();
            let facts = PlatformDirectoryFacts::complete(
                TargetPlatform::Linux,
                temp.path().join("native/config"),
                temp.path().join("native/data"),
                temp.path().join("native/state"),
                temp.path().join("native/cache"),
                temp.path().join("native/log"),
                temp.path().join("native/runtime"),
            );
            let legacy_root = temp.path().join("home/.nucleus");
            let source = resolve_storage_layout(
                &StorageLayoutRequest::new(identity.clone(), facts.clone())
                    .with_profile(StorageProfile::PortableV1)
                    .with_portable_root(&legacy_root),
            )
            .unwrap();
            let target =
                resolve_storage_layout(&StorageLayoutRequest::new(identity.clone(), facts.clone()))
                    .unwrap();
            let bootstrap = resolve_storage_bootstrap_paths(&identity, &facts).unwrap();
            Self {
                _temp: temp,
                identity,
                facts,
                source,
                target,
                bootstrap,
                legacy_root,
            }
        }

        fn request(&self) -> LegacyImportRequest<'_> {
            LegacyImportRequest {
                canonical_application_id: self.identity.canonical_application_id(),
                source_layout: &self.source,
                target_layout: &self.target,
                target_selection: StorageProfileSelection::platform_native(),
                bootstrap: self.bootstrap.clone(),
            }
        }

        fn seed_ui(&self, schema_version: u32) {
            let path = self.source.storage_roots().config().join("ui.json");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                path,
                format!(
                    r#"{{
                      "schema_version": {schema_version},
                      "window": {{
                        "id": "window:primary",
                        "placement": {{"display_id":"display:main","maximized":false}}
                      }},
                      "project_layouts": {{
                        "project:one": {{
                          "layout": {{"left_center_ratio":0.2,"center_right_ratio":0.74,"center_stack_ratio":0.74,"right_stack_ratio":0.74}},
                          "regions": {{"left":[],"right_top":[],"right_bottom":[],"center_top":[],"center_bottom":[]}},
                          "active_panels": {{}}
                        }}
                      }}
                    }}"#
                ),
            )
            .unwrap();
        }
    }

    #[test]
    fn live_wal_ui_and_trees_import_once_with_locator_last_and_source_retained() {
        let fixture = Fixture::new();
        fixture.seed_ui(10);
        let database = fixture
            .source
            .storage_roots()
            .state()
            .join("nucleus.sqlite");
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA wal_autocheckpoint=0;
                 CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO values_table (id, value) VALUES (1, ?1)",
                params!["legacy-wal-value"],
            )
            .unwrap();
        let wal = PathBuf::from(format!("{}-wal", database.display()));
        let wal_before = fs::read(&wal).unwrap();

        for (directory, relative, bytes) in [
            (
                "task-review-snapshots",
                "task/manifest.json",
                b"snapshot".as_slice(),
            ),
            (
                "editor-drafts",
                "project/resource/draft.json",
                b"draft".as_slice(),
            ),
        ] {
            let path = fixture
                .source
                .storage_roots()
                .state()
                .join(directory)
                .join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        let unknown = fixture.source.storage_roots().config().join("unknown.bin");
        fs::write(&unknown, b"retain-unknown").unwrap();

        let receipt = import_legacy_storage(fixture.request())
            .expect("legacy import")
            .expect("import receipt");

        assert_eq!(receipt.outcome, "target-committed");
        assert_eq!(receipt.custom_domains.len(), 4);
        assert_eq!(receipt.retained_source_root, fixture.legacy_root);
        assert_eq!(receipt.retained_unknown_files, [unknown.clone()]);
        assert_eq!(fs::read(&unknown).unwrap(), b"retain-unknown");
        assert_eq!(fs::read(&wal).unwrap(), wal_before);
        assert!(fixture
            .target
            .storage_roots()
            .state()
            .join("window-placement.json")
            .is_file());
        assert!(fixture
            .target
            .storage_roots()
            .config()
            .join("project-layouts.json")
            .is_file());
        assert_eq!(
            fs::read(
                fixture
                    .target
                    .storage_roots()
                    .state()
                    .join("task-review-snapshots/task/manifest.json")
            )
            .unwrap(),
            b"snapshot"
        );
        assert_eq!(
            fs::read(
                fixture
                    .target
                    .storage_roots()
                    .state()
                    .join("editor-drafts/project/resource/draft.json")
            )
            .unwrap(),
            b"draft"
        );
        let target_database = fixture.target.durable_database_dir().join("nucleus.sqlite");
        assert_eq!(
            Connection::open(target_database)
                .unwrap()
                .query_row("SELECT value FROM values_table WHERE id=1", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "legacy-wal-value"
        );
        let StorageBootstrapState::Selected(selected) =
            inspect_storage_bootstrap(&fixture.identity, &fixture.facts, None).unwrap()
        else {
            panic!("locator did not select target");
        };
        assert_eq!(selected.transition_id(), Some(TRANSITION_ID));
        assert_eq!(
            read_import_receipt(&fixture.bootstrap).unwrap(),
            Some(receipt)
        );
        drop(connection);
    }

    #[test]
    fn missing_legacy_root_does_not_create_target_or_locator() {
        let fixture = Fixture::new();
        assert_eq!(import_legacy_storage(fixture.request()).unwrap(), None);
        assert!(!fixture.bootstrap.locator().exists());
        assert!(!fixture.target.storage_roots().data().exists());
    }

    #[test]
    fn corrupt_and_future_ui_preserve_source_and_never_commit_locator() {
        for source in [b"not-json".as_slice(), br#"{"schema_version":999}"#] {
            let fixture = Fixture::new();
            let ui = fixture.source.storage_roots().config().join("ui.json");
            fs::create_dir_all(ui.parent().unwrap()).unwrap();
            fs::write(&ui, source).unwrap();
            assert!(import_legacy_storage(fixture.request()).is_err());
            assert_eq!(fs::read(ui).unwrap(), source);
            assert!(!fixture.bootstrap.locator().exists());
            assert!(!fixture
                .target
                .storage_roots()
                .state()
                .join("window-placement.json")
                .exists());
        }
    }

    #[test]
    fn occupied_split_target_blocks_without_merging_or_locator_commit() {
        let fixture = Fixture::new();
        fixture.seed_ui(10);
        let occupied = fixture
            .target
            .storage_roots()
            .state()
            .join("window-placement.json");
        fs::create_dir_all(occupied.parent().unwrap()).unwrap();
        fs::write(&occupied, b"occupied").unwrap();
        assert!(import_legacy_storage(fixture.request()).is_err());
        assert_eq!(fs::read(&occupied).unwrap(), b"occupied");
        assert!(!fixture.bootstrap.locator().exists());
    }
}
