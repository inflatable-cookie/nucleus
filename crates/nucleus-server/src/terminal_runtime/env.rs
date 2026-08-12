//! Terminal host environment: request validation, working-directory
//! resolution, shell discovery, and session identity helpers.
//!
//! Split from the terminal_runtime god file; behavior unchanged.

use std::path::{Path, PathBuf};

use nucleus_local_store::LocalStoreBackend;
use portable_pty::{CommandBuilder, PtySize};

use super::types::TerminalOpenRequest;
use super::LOCAL_HOST_ID;
use crate::project_resource_target::resolve_optional_project_resource_target_on_host;
use crate::ServerStateService;

pub(super) fn validate_open_request(request: &TerminalOpenRequest) -> Result<(), String> {
    if request.project_id.trim().is_empty() || request.panel_id.trim().is_empty() {
        return Err("terminal project and panel ids are required".to_owned());
    }
    validate_size(request.rows, request.cols)
}

pub(super) fn validate_size(rows: u16, cols: u16) -> Result<(), String> {
    if rows == 0 || cols == 0 {
        Err("terminal rows and columns must be positive".to_owned())
    } else {
        Ok(())
    }
}

pub(super) fn terminal_working_directory<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_id: Option<&str>,
) -> Result<(PathBuf, Option<String>), String>
where
    B: LocalStoreBackend,
{
    terminal_working_directory_with(
        state,
        project_id,
        resource_id,
        host_default_working_directory,
    )
}

pub(super) fn terminal_working_directory_with<B, F>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_id: Option<&str>,
    host_default: F,
) -> Result<(PathBuf, Option<String>), String>
where
    B: LocalStoreBackend,
    F: FnOnce() -> Result<PathBuf, String>,
{
    match resolve_optional_project_resource_target_on_host(
        state,
        project_id,
        resource_id,
        LOCAL_HOST_ID,
    )? {
        Some(target) => Ok((target.root, Some(target.resource_id))),
        None => host_default().map(|root| (root, None)),
    }
}

fn host_default_working_directory() -> Result<PathBuf, String> {
    let path = host_home_directory()
        .ok_or_else(|| "terminal host has no available default working directory".to_owned())?;
    std::fs::canonicalize(path)
        .map_err(|error| format!("terminal host default working directory is unavailable: {error}"))
}

#[cfg(not(windows))]
fn host_home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

#[cfg(windows)]
fn host_home_directory() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            let drive = std::env::var_os("HOMEDRIVE")?;
            let path = std::env::var_os("HOMEPATH")?;
            if drive.is_empty() || path.is_empty() {
                return None;
            }
            let mut home = PathBuf::from(drive);
            home.push(path);
            Some(home)
        })
}

pub(super) fn pty_size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub(super) fn shell_command(project_root: &Path) -> CommandBuilder {
    let mut command = CommandBuilder::new(shell_path());
    command.cwd(project_root);
    command
}

fn shell_path() -> PathBuf {
    std::env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(platform_shell)
}

#[cfg(windows)]
fn platform_shell() -> PathBuf {
    PathBuf::from("powershell.exe")
}

#[cfg(not(windows))]
fn platform_shell() -> PathBuf {
    PathBuf::from("/bin/sh")
}

pub(super) fn session_id(project_id: &str, panel_id: &str) -> String {
    let input = format!("{project_id}\0{panel_id}");
    format!("terminal:{}", blake3::hash(input.as_bytes()).to_hex())
}

pub(super) fn short_session_ref(session_id: &str) -> &str {
    session_id
        .strip_prefix("terminal:")
        .unwrap_or(session_id)
        .get(..12)
        .unwrap_or(session_id)
}
