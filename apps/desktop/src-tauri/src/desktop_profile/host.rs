use std::path::PathBuf;

use longhorn_config::PlatformDirectoryFacts;
use longhorn_tauri_config::{platform_directory_facts, TauriDirectorySnapshot};
use tauri::Manager;

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
