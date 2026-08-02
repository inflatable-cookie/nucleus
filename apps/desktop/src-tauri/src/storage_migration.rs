use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use longhorn_config::{
    execute_storage_transition, inspect_storage_transition, plan_storage_transition,
    recover_storage_transition, ConfigDomain, ConfigStore, CoordinationAuthority, DomainDescriptor,
    DomainFilePath, DomainIssue, MigrationStep, ResolvedStorageLayout, StorageBootstrapPaths,
    StorageClass, StorageProfileSelection, StorageTransitionAction, StorageTransitionCatalog,
    StorageTransitionExecutionOptions, StorageTransitionOutcome, StorageTransitionRequest,
};
use longhorn_core::{DomainId, SchemaVersion};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tempfile::NamedTempFile;

mod adapters;

use adapters::{SqliteTransitionAdapter, TreeTransitionAdapter, UiTransitionAdapter};

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

#[cfg(test)]
mod tests;
