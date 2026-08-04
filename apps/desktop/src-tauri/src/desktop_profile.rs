use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use longhorn_config::{
    inspect_storage_bootstrap, resolve_storage_bootstrap_paths, resolve_storage_layout,
    PlatformDirectoryFacts, ResolvedStorageLayout, StorageBootstrapOrigin, StorageBootstrapState,
    StorageIdentity, StorageLayoutRequest, StorageProfile, StorageProfileSelection, StorageRoots,
};

use crate::storage_migration::{self, LegacyImportReceipt, LegacyImportRequest};
use crate::workspace_ui::WorkspaceUiPaths;

mod host;
mod validation;

pub use host::host_storage_facts;
use validation::{
    create_directory, parse_chat_timeout, parse_fixture_root, resolve_selected_layout,
    validate_portable_root,
};

pub const CANONICAL_APPLICATION_ID: &str = "com.inflatablecookie.nucleus";
const PORTABLE_ROOT_ENV: &str = "NUCLEUS_DESKTOP_PORTABLE_ROOT";
const PROOF_FIXTURE_ROOT_ENV: &str = "NUCLEUS_DESKTOP_PROOF_FIXTURE_ROOT";
const CHAT_TIMEOUT_ENV: &str = "NUCLEUS_AGENT_CHAT_TURN_TIMEOUT_MS";
const DEFAULT_CHAT_TIMEOUT_MS: u64 = 180_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesktopProfile {
    layout: ResolvedStorageLayout,
    chat_turn_timeout: Duration,
    proof_fixture_root: Option<PathBuf>,
    legacy_import_receipt: Option<LegacyImportReceipt>,
}

impl DesktopProfile {
    pub fn from_environment(facts: PlatformDirectoryFacts, home: &Path) -> Result<Self, String> {
        Self::from_values(
            facts,
            std::env::var_os(PORTABLE_ROOT_ENV).as_deref(),
            std::env::var_os(CHAT_TIMEOUT_ENV).as_deref(),
            std::env::var_os(PROOF_FIXTURE_ROOT_ENV).as_deref(),
            home,
        )
    }

    fn from_values(
        facts: PlatformDirectoryFacts,
        configured_root: Option<&OsStr>,
        configured_timeout: Option<&OsStr>,
        configured_fixture_root: Option<&OsStr>,
        home: &Path,
    ) -> Result<Self, String> {
        if !home.is_absolute() {
            return Err("desktop home directory must be absolute".to_owned());
        }
        let identity = StorageIdentity::new(CANONICAL_APPLICATION_ID)
            .map_err(|error| format!("invalid Nucleus storage identity: {error}"))?;
        let host_bypass = configured_root
            .map(validate_portable_root)
            .transpose()?
            .map(StorageProfileSelection::portable)
            .transpose()
            .map_err(|error| format!("invalid Nucleus portable profile: {error}"))?;
        let bootstrap = inspect_storage_bootstrap(&identity, &facts, host_bypass.clone())
            .map_err(|error| format!("inspect Nucleus storage profile failed: {error}"))?;
        let selected = match bootstrap {
            StorageBootstrapState::Selected(selected) => selected,
            StorageBootstrapState::Recovery(recovery) => {
                return Err(format!(
                    "Nucleus storage profile requires recovery ({:?}): {}",
                    recovery.kind(),
                    recovery.detail()
                ));
            }
        };
        let layout =
            resolve_selected_layout(identity.clone(), facts.clone(), selected.selection())?;
        let legacy_import_receipt = if selected.origin() == StorageBootstrapOrigin::HostBypass {
            None
        } else if selected.origin() == StorageBootstrapOrigin::Locator {
            selected
                .paths()
                .map(storage_migration::read_import_receipt)
                .transpose()?
                .flatten()
        } else {
            let legacy_root = home.join(".nucleus");
            let source_layout = resolve_storage_layout(
                &StorageLayoutRequest::new(identity.clone(), facts.clone())
                    .with_profile(StorageProfile::PortableV1)
                    .with_portable_root(&legacy_root),
            )
            .map_err(|error| format!("resolve legacy Nucleus storage failed: {error}"))?;
            let bootstrap_paths = resolve_storage_bootstrap_paths(&identity, &facts)
                .map_err(|error| format!("resolve Nucleus storage bootstrap failed: {error}"))?;
            storage_migration::import_legacy_storage(LegacyImportRequest {
                canonical_application_id: CANONICAL_APPLICATION_ID,
                source_layout: &source_layout,
                target_layout: &layout,
                target_selection: selected.selection().clone(),
                bootstrap: bootstrap_paths,
            })?
        };

        let chat_timeout_ms = parse_chat_timeout(configured_timeout)?;
        let proof_fixture_root = parse_fixture_root(configured_fixture_root, configured_root)?;
        Ok(Self {
            layout,
            chat_turn_timeout: Duration::from_millis(chat_timeout_ms),
            proof_fixture_root,
            legacy_import_receipt,
        })
    }

    pub fn prepare(&self) -> Result<(), String> {
        for root in self.layout.diagnostic().roots() {
            create_directory(root.path(), "desktop storage root")?;
        }
        create_directory(
            &self.layout.durable_database_dir(),
            "desktop database directory",
        )
    }

    pub fn database_path(&self) -> PathBuf {
        self.layout.durable_database_dir().join("nucleus.sqlite")
    }

    pub fn snapshot_path(&self) -> PathBuf {
        self.layout
            .storage_roots()
            .state()
            .join("task-review-snapshots")
    }

    pub fn workspace_ui_paths(&self) -> WorkspaceUiPaths {
        WorkspaceUiPaths::new(
            self.layout
                .storage_roots()
                .state()
                .join("window-placement.json"),
            self.layout
                .storage_roots()
                .config()
                .join("project-layouts.json"),
            self.layout
                .storage_roots()
                .config()
                .join("project-panel-presentations.json"),
            self.layout
                .storage_roots()
                .backup()
                .join("nucleus-project-layout-card098-v1.json"),
            self.layout
                .storage_roots()
                .backup()
                .join("nucleus-project-layout-card098-v1.receipt.json"),
        )
    }

    pub fn storage_roots(&self) -> &StorageRoots {
        self.layout.storage_roots()
    }

    pub fn storage_diagnostic(&self) -> longhorn_config::StorageLayoutDiagnostic {
        self.layout.diagnostic()
    }

    pub fn legacy_window_placement_backup_path(&self) -> PathBuf {
        self.layout
            .storage_roots()
            .backup()
            .join("nucleus-window-placement-card097-v1.json")
    }

    pub fn legacy_window_placement_receipt_path(&self) -> PathBuf {
        self.layout
            .storage_roots()
            .backup()
            .join("nucleus-window-placement-card097-v1.receipt.json")
    }

    pub fn editor_drafts_path(&self) -> PathBuf {
        self.layout.storage_roots().state().join("editor-drafts")
    }

    pub fn settings_roots(&self) -> StorageRoots {
        self.layout.storage_roots().clone()
    }

    pub fn chat_turn_timeout(&self) -> Duration {
        self.chat_turn_timeout
    }

    pub fn proof_fixture_root(&self) -> Option<&Path> {
        self.proof_fixture_root.as_deref()
    }

    pub fn profile_id(&self) -> &str {
        self.layout.profile().id()
    }

    pub fn layout_digest(&self) -> &str {
        self.layout.digest().as_str()
    }

    pub fn legacy_import_receipt(&self) -> Option<&LegacyImportReceipt> {
        self.legacy_import_receipt.as_ref()
    }

    #[cfg(test)]
    pub(crate) fn portable_for_test(root: &Path) -> Result<Self, String> {
        use longhorn_config::TargetPlatform;

        let facts = PlatformDirectoryFacts::complete(
            TargetPlatform::MacOs,
            root.join("host/config"),
            root.join("host/data"),
            root.join("host/state"),
            root.join("host/cache"),
            root.join("host/log"),
            root.join("host/runtime"),
        );
        Self::from_values(
            facts,
            Some(root.as_os_str()),
            None,
            None,
            &root.join("home"),
        )
    }
}

#[cfg(test)]
mod tests;
