use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use longhorn_config::{
    inspect_storage_bootstrap, resolve_storage_bootstrap_paths, resolve_storage_layout,
    PlatformDirectoryFacts, ResolvedStorageLayout, StorageBootstrapOrigin, StorageBootstrapState,
    StorageIdentity, StorageLayoutRequest, StorageProfile, StorageProfileSelection, StorageRoots,
};
use longhorn_tauri_config::{platform_directory_facts, TauriDirectorySnapshot};
use tauri::Manager;

use crate::storage_migration::{self, LegacyImportReceipt, LegacyImportRequest};
use crate::workspace_ui::WorkspaceUiPaths;

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
        )
    }

    pub fn storage_roots(&self) -> &StorageRoots {
        self.layout.storage_roots()
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
}

fn resolve_selected_layout(
    identity: StorageIdentity,
    facts: PlatformDirectoryFacts,
    selection: &StorageProfileSelection,
) -> Result<ResolvedStorageLayout, String> {
    let mut request = StorageLayoutRequest::new(identity, facts).with_profile(selection.profile());
    if let Some(root) = selection.explicit_root() {
        request = request.with_portable_root(root);
    }
    resolve_storage_layout(&request)
        .map_err(|error| format!("resolve Nucleus storage profile failed: {error}"))
}

fn validate_portable_root(value: &OsStr) -> Result<PathBuf, String> {
    let root = PathBuf::from(value);
    if root.as_os_str().is_empty() {
        return Err(format!("{PORTABLE_ROOT_ENV} must not be empty"));
    }
    if !root.is_absolute() {
        return Err(format!("{PORTABLE_ROOT_ENV} must be an absolute path"));
    }
    if root.exists() && !root.is_dir() {
        return Err(format!("{PORTABLE_ROOT_ENV} does not identify a directory"));
    }
    Ok(root)
}

fn parse_chat_timeout(value: Option<&OsStr>) -> Result<u64, String> {
    let timeout = match value {
        Some(value) => value
            .to_str()
            .ok_or_else(|| format!("{CHAT_TIMEOUT_ENV} must be valid UTF-8"))?
            .parse::<u64>()
            .map_err(|_| format!("{CHAT_TIMEOUT_ENV} must be an integer number of milliseconds"))?,
        None => DEFAULT_CHAT_TIMEOUT_MS,
    };
    if !(1..=DEFAULT_CHAT_TIMEOUT_MS).contains(&timeout) {
        return Err(format!(
            "{CHAT_TIMEOUT_ENV} must be between 1 and {DEFAULT_CHAT_TIMEOUT_MS}"
        ));
    }
    Ok(timeout)
}

fn parse_fixture_root(
    value: Option<&OsStr>,
    configured_root: Option<&OsStr>,
) -> Result<Option<PathBuf>, String> {
    match value {
        Some(_) if configured_root.is_none() => Err(format!(
            "{PROOF_FIXTURE_ROOT_ENV} requires an explicit {PORTABLE_ROOT_ENV}"
        )),
        Some(root) => {
            let root = PathBuf::from(root);
            if !root.is_absolute() {
                return Err(format!("{PROOF_FIXTURE_ROOT_ENV} must be an absolute path"));
            }
            if !root.is_dir() || !root.join(".git").is_dir() {
                return Err(format!(
                    "{PROOF_FIXTURE_ROOT_ENV} must identify an existing Git repository"
                ));
            }
            Ok(Some(root))
        }
        None => Ok(None),
    }
}

fn create_directory(path: &Path, label: &str) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| format!("create {label} failed: {error}"))?;
    if !path.is_dir() {
        return Err(format!("{label} is not a directory"));
    }
    Ok(())
}

pub fn host_storage_facts(
    app: &tauri::AppHandle,
) -> Result<(PlatformDirectoryFacts, PathBuf), String> {
    let paths = app.path();
    let home = paths
        .home_dir()
        .map_err(|error| format!("resolve desktop home directory failed: {error}"))?;
    #[cfg(target_os = "macos")]
    let snapshot = TauriDirectorySnapshot::MacOs {
        local_data_dir: paths
            .local_data_dir()
            .map_err(|error| format!("resolve local data directory failed: {error}"))?,
        cache_dir: paths
            .cache_dir()
            .map_err(|error| format!("resolve cache directory failed: {error}"))?,
        home_dir: home.clone(),
        temp_dir: paths
            .temp_dir()
            .map_err(|error| format!("resolve temporary directory failed: {error}"))?,
    };
    #[cfg(target_os = "windows")]
    let snapshot = TauriDirectorySnapshot::Windows {
        local_data_dir: paths
            .local_data_dir()
            .map_err(|error| format!("resolve local data directory failed: {error}"))?,
        temp_dir: paths
            .temp_dir()
            .map_err(|error| format!("resolve temporary directory failed: {error}"))?,
    };
    #[cfg(target_os = "linux")]
    let snapshot = TauriDirectorySnapshot::Linux {
        config_dir: paths
            .config_dir()
            .map_err(|error| format!("resolve config directory failed: {error}"))?,
        local_data_dir: paths
            .local_data_dir()
            .map_err(|error| format!("resolve local data directory failed: {error}"))?,
        state_dir: xdg_absolute("XDG_STATE_HOME")?,
        cache_dir: paths
            .cache_dir()
            .map_err(|error| format!("resolve cache directory failed: {error}"))?,
        runtime_dir: xdg_absolute("XDG_RUNTIME_DIR")?,
    };
    Ok((platform_directory_facts(snapshot), home))
}

#[cfg(target_os = "linux")]
fn xdg_absolute(name: &str) -> Result<PathBuf, String> {
    let path = std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("{name} is required for the platform-native storage profile"))?;
    if !path.is_absolute() {
        return Err(format!("{name} must be an absolute path"));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use longhorn_config::TargetPlatform;

    fn facts(platform: TargetPlatform) -> PlatformDirectoryFacts {
        match platform {
            TargetPlatform::MacOs => PlatformDirectoryFacts::complete(
                platform,
                "/Users/example/Library/Application Support",
                "/Users/example/Library/Application Support",
                "/Users/example/Library/Application Support",
                "/Users/example/Library/Caches",
                "/Users/example/Library/Logs",
                "/private/tmp",
            ),
            TargetPlatform::Windows => PlatformDirectoryFacts::complete(
                platform,
                "/windows/LocalAppData",
                "/windows/LocalAppData",
                "/windows/LocalAppData",
                "/windows/LocalAppData",
                "/windows/LocalAppData",
                "/windows/Temp",
            ),
            TargetPlatform::Linux => PlatformDirectoryFacts::complete(
                platform,
                "/home/example/.config",
                "/home/example/.local/share",
                "/home/example/.local/state",
                "/home/example/.cache",
                "/home/example/.local/state",
                "/run/user/1000",
            ),
        }
    }

    #[test]
    fn canonical_identity_drives_all_three_platform_defaults() {
        for (platform, expected_config, expected_database) in [
            (
                TargetPlatform::MacOs,
                "/Users/example/Library/Application Support/com.inflatablecookie.nucleus/config",
                "/Users/example/Library/Application Support/com.inflatablecookie.nucleus/data/databases/nucleus.sqlite",
            ),
            (
                TargetPlatform::Windows,
                "/windows/LocalAppData/com.inflatablecookie.nucleus/config",
                "/windows/LocalAppData/com.inflatablecookie.nucleus/data/databases/nucleus.sqlite",
            ),
            (
                TargetPlatform::Linux,
                "/home/example/.config/com.inflatablecookie.nucleus",
                "/home/example/.local/share/com.inflatablecookie.nucleus/databases/nucleus.sqlite",
            ),
        ] {
            let profile = DesktopProfile::from_values(
                facts(platform),
                None,
                None,
                None,
                Path::new("/nonexistent/nucleus-profile-test"),
            )
            .expect("platform profile");
            assert_eq!(profile.workspace_ui_paths().project_layouts(), Path::new(expected_config).join("project-layouts.json"));
            assert_eq!(profile.database_path(), Path::new(expected_database));
            assert_eq!(profile.profile_id(), "platform-native-v1");
        }
    }

    #[test]
    fn portable_profile_isolates_every_desktop_owned_path() {
        let profile = DesktopProfile::from_values(
            facts(TargetPlatform::MacOs),
            Some(OsStr::new("/tmp/nucleus-proof")),
            Some(OsStr::new("1250")),
            None,
            Path::new("/Users/example"),
        )
        .expect("portable profile");
        assert_eq!(
            profile.database_path(),
            Path::new("/tmp/nucleus-proof/data/databases/nucleus.sqlite")
        );
        assert_eq!(
            profile.snapshot_path(),
            Path::new("/tmp/nucleus-proof/state/task-review-snapshots")
        );
        assert_eq!(
            profile.workspace_ui_paths().window_placement(),
            Path::new("/tmp/nucleus-proof/state/window-placement.json")
        );
        assert_eq!(
            profile.workspace_ui_paths().project_layouts(),
            Path::new("/tmp/nucleus-proof/config/project-layouts.json")
        );
        assert_eq!(
            profile.editor_drafts_path(),
            Path::new("/tmp/nucleus-proof/state/editor-drafts")
        );
        assert_eq!(profile.chat_turn_timeout(), Duration::from_millis(1250));
        assert_eq!(profile.profile_id(), "portable-v1");
    }

    #[test]
    fn explicit_invalid_values_do_not_fall_back() {
        let result = DesktopProfile::from_values(
            facts(TargetPlatform::MacOs),
            Some(OsStr::new("relative")),
            None,
            None,
            Path::new("/Users/example"),
        );
        assert_eq!(
            result.unwrap_err(),
            format!("{PORTABLE_ROOT_ENV} must be an absolute path")
        );
        let result = DesktopProfile::from_values(
            facts(TargetPlatform::MacOs),
            Some(OsStr::new("/tmp/nucleus-proof")),
            Some(OsStr::new("0")),
            None,
            Path::new("/Users/example"),
        );
        assert_eq!(
            result.unwrap_err(),
            format!("{CHAT_TIMEOUT_ENV} must be between 1 and 180000")
        );
    }
}
