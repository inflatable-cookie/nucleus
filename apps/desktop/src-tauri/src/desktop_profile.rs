use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

const DATA_ROOT_ENV: &str = "NUCLEUS_DESKTOP_DATA_ROOT";
const CHAT_TIMEOUT_ENV: &str = "NUCLEUS_AGENT_CHAT_TURN_TIMEOUT_MS";
const DEFAULT_CHAT_TIMEOUT_MS: u64 = 180_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesktopProfile {
    data_root: PathBuf,
    chat_turn_timeout: Duration,
}

impl DesktopProfile {
    pub fn from_environment() -> Result<Self, String> {
        Self::from_values(
            std::env::var_os(DATA_ROOT_ENV).as_deref(),
            std::env::var_os(CHAT_TIMEOUT_ENV).as_deref(),
            std::env::var_os("HOME").as_deref(),
        )
    }

    fn from_values(
        configured_root: Option<&OsStr>,
        configured_timeout: Option<&OsStr>,
        home: Option<&OsStr>,
    ) -> Result<Self, String> {
        let data_root = match configured_root {
            Some(root) => {
                let root = PathBuf::from(root);
                if root.as_os_str().is_empty() {
                    return Err(format!("{DATA_ROOT_ENV} must not be empty"));
                }
                if !root.is_absolute() {
                    return Err(format!("{DATA_ROOT_ENV} must be an absolute path"));
                }
                root
            }
            None => {
                let home = home
                    .filter(|home| !home.is_empty())
                    .map(PathBuf::from)
                    .ok_or_else(|| {
                        format!("HOME is required when {DATA_ROOT_ENV} is not configured")
                    })?;
                home.join(".nucleus")
            }
        };
        if data_root.exists() && !data_root.is_dir() {
            return Err(format!("{DATA_ROOT_ENV} does not identify a directory"));
        }

        let chat_timeout_ms = match configured_timeout {
            Some(value) => value
                .to_str()
                .ok_or_else(|| format!("{CHAT_TIMEOUT_ENV} must be valid UTF-8"))?
                .parse::<u64>()
                .map_err(|_| {
                    format!("{CHAT_TIMEOUT_ENV} must be an integer number of milliseconds")
                })?,
            None => DEFAULT_CHAT_TIMEOUT_MS,
        };
        if !(1..=DEFAULT_CHAT_TIMEOUT_MS).contains(&chat_timeout_ms) {
            return Err(format!(
                "{CHAT_TIMEOUT_ENV} must be between 1 and {DEFAULT_CHAT_TIMEOUT_MS}"
            ));
        }

        Ok(Self {
            data_root,
            chat_turn_timeout: Duration::from_millis(chat_timeout_ms),
        })
    }

    pub fn prepare(&self) -> Result<(), String> {
        create_directory(&self.data_root, "desktop data root")?;
        create_directory(&self.data_root.join("state"), "desktop state directory")?;
        create_directory(&self.data_root.join("config"), "desktop config directory")
    }

    pub fn database_path(&self) -> PathBuf {
        self.data_root.join("state").join("nucleus.sqlite")
    }

    pub fn snapshot_path(&self) -> PathBuf {
        self.data_root.join("state").join("task-review-snapshots")
    }

    pub fn workspace_ui_config_path(&self) -> PathBuf {
        self.data_root.join("config").join("ui.json")
    }

    pub fn chat_turn_timeout(&self) -> Duration {
        self.chat_turn_timeout
    }
}

fn create_directory(path: &Path, label: &str) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| format!("create {label} failed: {error}"))?;
    if !path.is_dir() {
        return Err(format!("{label} is not a directory"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{DesktopProfile, CHAT_TIMEOUT_ENV, DATA_ROOT_ENV};
    use std::ffi::OsStr;
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn default_profile_preserves_nucleus_home_paths_and_deadline() {
        let profile = DesktopProfile::from_values(None, None, Some(OsStr::new("/Users/example")))
            .expect("default profile");

        assert_eq!(
            profile.database_path(),
            Path::new("/Users/example/.nucleus/state/nucleus.sqlite")
        );
        assert_eq!(
            profile.snapshot_path(),
            Path::new("/Users/example/.nucleus/state/task-review-snapshots")
        );
        assert_eq!(
            profile.workspace_ui_config_path(),
            Path::new("/Users/example/.nucleus/config/ui.json")
        );
        assert_eq!(profile.chat_turn_timeout(), Duration::from_secs(180));
    }

    #[test]
    fn explicit_root_isolates_every_desktop_owned_path() {
        let profile = DesktopProfile::from_values(
            Some(OsStr::new("/tmp/nucleus-proof")),
            Some(OsStr::new("1250")),
            Some(OsStr::new("/Users/example")),
        )
        .expect("proof profile");

        assert_eq!(
            profile.database_path(),
            Path::new("/tmp/nucleus-proof/state/nucleus.sqlite")
        );
        assert_eq!(
            profile.snapshot_path(),
            Path::new("/tmp/nucleus-proof/state/task-review-snapshots")
        );
        assert_eq!(
            profile.workspace_ui_config_path(),
            Path::new("/tmp/nucleus-proof/config/ui.json")
        );
        assert_eq!(profile.chat_turn_timeout(), Duration::from_millis(1250));
    }

    #[test]
    fn explicit_invalid_values_do_not_fall_back() {
        assert_eq!(
            DesktopProfile::from_values(
                Some(OsStr::new("relative")),
                None,
                Some(OsStr::new("/Users/example")),
            ),
            Err(format!("{DATA_ROOT_ENV} must be an absolute path"))
        );
        assert_eq!(
            DesktopProfile::from_values(
                Some(OsStr::new("/tmp/nucleus-proof")),
                Some(OsStr::new("0")),
                Some(OsStr::new("/Users/example")),
            ),
            Err(format!("{CHAT_TIMEOUT_ENV} must be between 1 and 180000"))
        );
        assert_eq!(
            DesktopProfile::from_values(
                Some(OsStr::new("/tmp/nucleus-proof")),
                Some(OsStr::new("180001")),
                Some(OsStr::new("/Users/example")),
            ),
            Err(format!("{CHAT_TIMEOUT_ENV} must be between 1 and 180000"))
        );
    }
}
