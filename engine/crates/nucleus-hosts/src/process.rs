use std::{
    collections::HashMap,
    ffi::OsStr,
    io,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use futures_util::future::try_join3;
use rustix::{
    fs::{FileType, Mode, stat},
    io::Errno,
    process::{Pid, geteuid, test_kill_process},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time,
};

use crate::HostError;

const DEADLINE: Duration = Duration::from_secs(5);
const MAX_OUTPUT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(crate) enum Activity {
    Busy,
    Quiet,
    Unknown,
}

/// Snapshot of the local host user's processes. Missing lsof rows stay unknown
/// until a separate process enumeration proves their PIDs have exited.
pub(crate) struct Inventory {
    processes: HashMap<u32, ProcessPaths>,
}

#[derive(Default)]
struct ProcessPaths {
    cwd: Option<PathBuf>,
    open_paths: Vec<PathBuf>,
}

impl Inventory {
    #[cfg(test)]
    pub(crate) fn quiet_fixture() -> Self {
        Self {
            processes: HashMap::from([(
                1,
                ProcessPaths {
                    cwd: Some(PathBuf::from("/")),
                    open_paths: Vec::new(),
                },
            )]),
        }
    }

    pub(crate) async fn capture() -> Result<Self, HostError> {
        let user = geteuid().as_raw();
        let (listing, _) = capture(
            "/usr/sbin/lsof",
            &["-a", "-u", &user.to_string(), "-n", "-P", "-F0pfn"],
        )
        .await?;
        // The later inventory includes any new PID lsof did not see. A zombie
        // has already released its cwd and cannot access the checkout.
        let (processes, probe_pid) = capture("/bin/ps", &["-axo", "pid=,uid=,stat="]).await?;
        let mut inventory = Self::from_listings(&listing, &processes, user, probe_pid)?;
        inventory.complete_missing().await;
        Ok(inventory)
    }

    async fn complete_missing(&mut self) {
        // Processes begun during lsof's walk need their own read. This is one
        // bounded follow-up for the captured census, independent of task count.
        let missing = self
            .processes
            .iter()
            .filter(|(_, paths)| paths.cwd.is_none())
            .map(|(pid, _)| pid.to_string())
            .collect::<Vec<_>>()
            .join(",");
        if !missing.is_empty()
            && let Ok((listing, _)) =
                capture("/usr/sbin/lsof", &["-p", &missing, "-n", "-P", "-F0pfn"]).await
            && let Ok(paths) = process_paths(&listing)
        {
            for (pid, paths) in paths {
                if let Some(existing) = self.processes.get_mut(&pid) {
                    *existing = paths;
                }
            }
        }
        self.processes
            .retain(|&pid, paths| paths.cwd.is_some() || !gone(pid));
    }

    fn from_listings(
        listing: &[u8],
        processes: &[u8],
        user: u32,
        probe_pid: u32,
    ) -> Result<Self, HostError> {
        let mut by_pid = process_paths(listing)?;
        let processes = std::str::from_utf8(processes).map_err(|_| HostError::Protocol)?;
        let mut live = HashMap::new();
        for line in processes.lines() {
            let mut columns = line.split_whitespace();
            let pid = columns
                .next()
                .and_then(|pid| pid.parse::<u32>().ok())
                .ok_or(HostError::Protocol)?;
            let uid = columns
                .next()
                .and_then(|uid| uid.parse::<u32>().ok())
                .ok_or(HostError::Protocol)?;
            let status = columns.next().ok_or(HostError::Protocol)?;
            if pid != probe_pid && uid == user && !status.starts_with('Z') {
                live.insert(pid, by_pid.remove(&pid).unwrap_or_default());
            }
        }
        Ok(Self { processes: live })
    }

    pub(crate) fn activity(&self, path: &Path) -> Result<Activity, HostError> {
        let user = geteuid().as_raw();
        if !path.is_absolute()
            || path.canonicalize().ok().as_deref() != Some(path)
            || !path.ancestors().take(2).any(|directory| {
                stat(directory).is_ok_and(|metadata| {
                    FileType::from_raw_mode(metadata.st_mode) == FileType::Directory
                        && metadata.st_uid == user
                        && !Mode::from_raw_mode(metadata.st_mode)
                            .intersects(Mode::RWXG | Mode::RWXO)
                })
            })
        {
            return Err(HostError::Binding);
        }
        let mut missing = false;
        for process in self.processes.values() {
            if process
                .cwd
                .iter()
                .chain(&process.open_paths)
                .any(|candidate| candidate.starts_with(path))
            {
                return Ok(Activity::Busy);
            }
            missing |= process.cwd.is_none();
        }
        Ok(if missing || self.processes.is_empty() {
            Activity::Unknown
        } else {
            Activity::Quiet
        })
    }
}

fn gone(pid: u32) -> bool {
    i32::try_from(pid)
        .ok()
        .and_then(Pid::from_raw)
        .is_some_and(|pid| test_kill_process(pid) == Err(Errno::SRCH))
}

fn process_paths(stdout: &[u8]) -> Result<HashMap<u32, ProcessPaths>, HostError> {
    let mut pid = None;
    let mut is_cwd = false;
    let mut rows: HashMap<u32, ProcessPaths> = HashMap::new();
    for field in stdout.split(|&byte| byte == 0) {
        let field = field.strip_prefix(b"\n").unwrap_or(field);
        match field {
            [b'p', value @ ..] => {
                pid = std::str::from_utf8(value)
                    .ok()
                    .and_then(|value| value.parse().ok());
                if pid.is_none() {
                    return Err(HostError::Protocol);
                }
                is_cwd = false;
            }
            [b'f', file @ ..] => is_cwd = file == b"cwd",
            [b'n', path @ ..] if path.starts_with(b"/") => {
                let process = rows.entry(pid.ok_or(HostError::Protocol)?).or_default();
                let path = PathBuf::from(OsStr::from_bytes(path));
                if is_cwd {
                    if process.cwd.replace(path).is_some() {
                        return Err(HostError::Protocol);
                    }
                } else {
                    process.open_paths.push(path);
                }
            }
            _ => {}
        }
    }
    Ok(rows)
}

async fn capture(command: &str, args: &[&str]) -> Result<(Vec<u8>, u32), HostError> {
    let mut child = Command::new(command)
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| HostError::Unavailable)?;
    let pid = child.id().ok_or(HostError::Protocol)?;
    let stdout = child.stdout.take().ok_or(HostError::Protocol)?;
    let stderr = child.stderr.take().ok_or(HostError::Protocol)?;
    let (status, stdout, stderr) = time::timeout(
        DEADLINE,
        try_join3(child.wait(), bounded(stdout), bounded(stderr)),
    )
    .await
    .map_err(|_| HostError::Timeout)?
    .map_err(|_| HostError::Uncertain)?;
    if status.success() && stderr.is_empty() && !stdout.is_empty() {
        Ok((stdout, pid))
    } else {
        Err(HostError::Uncertain)
    }
}

async fn bounded(reader: impl AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let count = reader.take(MAX_OUTPUT + 1).read_to_end(&mut bytes).await?;
    if u64::try_from(count).unwrap_or(u64::MAX) > MAX_OUTPUT {
        return Err(io::Error::other(
            "process listing exceeded the output limit",
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::{fs::Permissions, os::unix::fs::PermissionsExt};

    use super::*;

    #[test]
    fn missing_cwd_is_unknown_even_when_other_processes_have_paths() {
        let path = tempfile::Builder::new()
            .permissions(Permissions::from_mode(0o700))
            .tempdir()
            .expect("checkout");
        let path = path.path().canonicalize().expect("canonical checkout");
        let inventory = Inventory::from_listings(
            b"p1\0\nfcwd\0n/elsewhere\0\n",
            b"1 501 S\n2 501 R\n3 501 Z\n4 501 R\n",
            501,
            4,
        )
        .expect("parse inventory");
        assert!(matches!(inventory.activity(&path), Ok(Activity::Unknown)));
    }

    #[tokio::test]
    async fn exit_one_with_no_output_is_incomplete() {
        assert!(matches!(
            capture("/usr/bin/false", &[]).await,
            Err(HostError::Uncertain)
        ));
    }
}
