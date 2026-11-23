use std::{
    collections::HashMap,
    ffi::OsStr,
    io,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::ffi::OsStrExt,
    },
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use futures_util::future::try_join3;
use rustix::{
    fs::{FileType, Mode, OFlags, open, stat},
    io::Errno,
    process::{Pid, geteuid, test_kill_process},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::Mutex,
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
    scoped: Mutex<HashMap<PathBuf, Result<Activity, HostError>>>,
}

#[derive(Default)]
struct ProcessPaths {
    cwd: Option<PathBuf>,
    ambiguous_path: bool,
}

impl Inventory {
    #[cfg(any(test, feature = "loopback-fixture"))]
    pub(crate) fn quiet_fixture() -> Self {
        Self {
            processes: HashMap::from([(
                1,
                ProcessPaths {
                    cwd: Some(PathBuf::from("/")),
                    ambiguous_path: false,
                },
            )]),
            scoped: Mutex::default(),
        }
    }

    pub(crate) async fn capture() -> Result<Self, HostError> {
        let user = geteuid().as_raw();
        let (listing, _) = capture(
            "/usr/sbin/lsof",
            &[
                "-a",
                "-u",
                &user.to_string(),
                "-d",
                "cwd",
                "-n",
                "-P",
                "-F0pfn",
            ],
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
            && let Ok((listing, _)) = capture(
                "/usr/sbin/lsof",
                &["-a", "-p", &missing, "-d", "cwd", "-n", "-P", "-F0pfn"],
            )
            .await
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
        Ok(Self {
            processes: live,
            scoped: Mutex::default(),
        })
    }

    pub(crate) fn activity(&self, path: &Path) -> Result<Activity, HostError> {
        verify_root(path)?;
        let mut missing = false;
        for process in self.processes.values() {
            if process
                .cwd
                .as_ref()
                .is_some_and(|cwd| cwd.starts_with(path))
            {
                return Ok(Activity::Busy);
            }
            missing |= process.cwd.is_none() || process.ambiguous_path;
        }
        Ok(if missing || self.processes.is_empty() {
            Activity::Unknown
        } else {
            Activity::Quiet
        })
    }

    pub(crate) async fn activity_for(
        &self,
        checkout: &Path,
        scratch: &Path,
    ) -> Result<Activity, HostError> {
        match (self.activity(checkout)?, self.activity(scratch)?) {
            (Activity::Busy, _) | (_, Activity::Busy) => return Ok(Activity::Busy),
            (Activity::Unknown, _) | (_, Activity::Unknown) => return Ok(Activity::Unknown),
            (Activity::Quiet, Activity::Quiet) => {}
        }
        let mut scoped = self.scoped.lock().await;
        if let Some(activity) = scoped.get(checkout) {
            return *activity;
        }
        let activity = scoped_activity(checkout, scratch).await;
        scoped.insert(checkout.to_path_buf(), activity);
        activity
    }
}

fn verify_root(path: &Path) -> Result<(), HostError> {
    let user = geteuid().as_raw();
    if !path.is_absolute()
        || path.canonicalize().ok().as_deref() != Some(path)
        || !path.ancestors().take(2).any(|directory| {
            stat(directory).is_ok_and(|metadata| {
                FileType::from_raw_mode(metadata.st_mode) == FileType::Directory
                    && metadata.st_uid == user
                    && !Mode::from_raw_mode(metadata.st_mode).intersects(Mode::RWXG | Mode::RWXO)
            })
        })
    {
        return Err(HostError::Binding);
    }
    Ok(())
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
            [b'n', path @ ..] if is_cwd && path.starts_with(b"/") => {
                let process = rows.entry(pid.ok_or(HostError::Protocol)?).or_default();
                let Some(path) = decode_lsof_path(path) else {
                    process.ambiguous_path = true;
                    continue;
                };
                if process.cwd.replace(path).is_some() {
                    return Err(HostError::Protocol);
                }
            }
            _ => {}
        }
    }
    Ok(rows)
}

fn decode_lsof_path(path: &[u8]) -> Option<PathBuf> {
    if !path.iter().any(|&byte| matches!(byte, b'\\' | b'^')) {
        return Some(PathBuf::from(OsStr::from_bytes(path)));
    }
    let mut decoded = Vec::with_capacity(path.len());
    let mut input = path.iter().copied().peekable();
    while let Some(byte) = input.next() {
        let byte = match byte {
            // lsof also prints control bytes in caret notation, but leaves
            // printable carets alone. This form cannot be inverted safely.
            b'^' if matches!(input.peek(), Some(b'?'..=b'_')) => return None,
            b'\\' => match input.next()? {
                b'x' => hex_digit(input.next()?)? * 16 + hex_digit(input.next()?)?,
                b'\\' => b'\\',
                b'b' => 8,
                b'f' => 12,
                b'n' => b'\n',
                b'r' => b'\r',
                b't' => b'\t',
                _ => return None,
            },
            other => other,
        };
        if byte == 0 {
            return None;
        }
        decoded.push(byte);
    }
    Some(PathBuf::from(OsStr::from_bytes(&decoded)))
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

struct Witness<'a> {
    path: &'a Path,
    fd: OwnedFd,
}

impl<'a> Witness<'a> {
    fn open(path: &'a Path) -> Result<Self, HostError> {
        let fd = open(
            path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| HostError::Uncertain)?;
        Ok(Self { path, fd })
    }
}

async fn scoped_activity(checkout: &Path, scratch: &Path) -> Result<Activity, HostError> {
    let mut witnesses = vec![Witness::open(checkout)?];
    if scratch != checkout {
        witnesses.push(Witness::open(scratch)?);
    }
    let mut args: Vec<&OsStr> = ["-n", "-P", "-V", "-F0pfn"]
        .into_iter()
        .map(OsStr::new)
        .collect();
    for witness in &witnesses {
        args.extend([OsStr::new("+D"), witness.path.as_os_str()]);
    }
    let listing = read_listing("/usr/sbin/lsof", &args).await?;
    // Keep the directory descriptors open while lsof runs. They are dropped
    // with the witnesses before the pass can authorize worktree removal.
    Ok(scoped_listing(&listing, &witnesses).unwrap_or(Activity::Unknown))
}

fn scoped_listing(listing: &Listing, witnesses: &[Witness<'_>]) -> Option<Activity> {
    let end = listing.output.iter().rposition(|&byte| byte == 0)?;
    let diagnostics = listing.output[end + 1..].strip_prefix(b"\n")?;
    // Darwin lsof exits 1 for any closed descendant found by +D. With -V,
    // distinguish these explicit search misses from all other failures.
    match listing.exit {
        Some(0) if diagnostics.is_empty() => {}
        Some(1) if closed_paths(diagnostics, witnesses) => {}
        _ => return None,
    }
    let mut seen = vec![false; witnesses.len()];
    let mut pid = None;
    let mut fd = None;
    let mut busy = false;
    for field in listing.output[..end].split(|&byte| byte == 0) {
        let field = field.strip_prefix(b"\n").unwrap_or(field);
        match field {
            [b'p', value @ ..] if fd.is_none() => {
                pid = Some(std::str::from_utf8(value).ok()?.parse::<u32>().ok()?);
            }
            [b'f', value @ ..] if pid.is_some() && fd.is_none() && !value.is_empty() => {
                fd = Some(value);
            }
            [b'n', name @ ..] if name.starts_with(b"/") => {
                let descriptor = fd.take()?;
                let path = decode_lsof_path(name)?;
                let witness = witnesses.iter().position(|witness| {
                    pid == Some(std::process::id())
                        && std::str::from_utf8(descriptor)
                            .ok()
                            .and_then(|fd| fd.parse().ok())
                            == Some(witness.fd.as_raw_fd())
                        && path == witness.path
                });
                if let Some(index) = witness {
                    if std::mem::replace(&mut seen[index], true) {
                        return None;
                    }
                } else {
                    busy = true;
                }
            }
            _ => return None,
        }
    }
    if fd.is_some() || !seen.into_iter().all(|found| found) {
        return None;
    }
    Some(if busy {
        Activity::Busy
    } else {
        Activity::Quiet
    })
}

fn closed_paths(diagnostics: &[u8], witnesses: &[Witness<'_>]) -> bool {
    diagnostics.strip_suffix(b"\n").is_some_and(|lines| {
        lines.split(|&byte| byte == b'\n').all(|line| {
            line.strip_prefix(b"lsof: no file use located: ")
                .and_then(decode_lsof_path)
                .is_some_and(|path| {
                    path.is_absolute()
                        && witnesses
                            .iter()
                            .any(|witness| path.starts_with(witness.path))
                })
        })
    })
}

struct Listing {
    exit: Option<i32>,
    output: Vec<u8>,
    pid: u32,
}

async fn capture(command: &str, args: &[&str]) -> Result<(Vec<u8>, u32), HostError> {
    let listing = read_listing(command, args).await?;
    if listing.exit == Some(0) && !listing.output.is_empty() {
        Ok((listing.output, listing.pid))
    } else {
        Err(HostError::Uncertain)
    }
}

async fn read_listing(command: &str, args: &[impl AsRef<OsStr>]) -> Result<Listing, HostError> {
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
    if stderr.is_empty() {
        Ok(Listing {
            exit: status.code(),
            output: stdout,
            pid,
        })
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

    #[test]
    fn a_missing_witness_is_incomplete() {
        let checkout = tempfile::tempdir().expect("checkout");
        let scratch = tempfile::tempdir().expect("scratch");
        let witnesses = [
            Witness::open(checkout.path()).expect("open checkout"),
            Witness::open(scratch.path()).expect("open scratch"),
        ];
        let listing = Listing {
            exit: Some(1),
            output: format!(
                "p{}\0\nf{}\0n{}\0\nlsof: no file use located: {}/closed\n",
                std::process::id(),
                witnesses[0].fd.as_raw_fd(),
                checkout.path().display(),
                scratch.path().display(),
            )
            .into_bytes(),
            pid: 0,
        };
        assert!(scoped_listing(&listing, &witnesses).is_none());
    }

    #[tokio::test]
    async fn scopes_distinguish_closed_descendants_from_nested_open_files() {
        let checkout = tempfile::tempdir().expect("checkout");
        let scratch = tempfile::tempdir().expect("scratch");
        let checkout = checkout.path().canonicalize().expect("canonical checkout");
        let scratch = scratch.path().canonicalize().expect("canonical scratch");
        let nested = checkout.join("nested");
        std::fs::create_dir(&nested).expect("nested directory");
        let path = nested.join("tool-file");
        std::fs::File::create(&path).expect("file initially closed");
        assert!(matches!(
            scoped_activity(&checkout, &scratch).await,
            Ok(Activity::Quiet)
        ));
        let held = std::fs::File::open(&path).expect("open file outside process cwd");
        assert!(matches!(
            scoped_activity(&checkout, &scratch).await,
            Ok(Activity::Busy)
        ));
        drop(held);
    }

    #[tokio::test]
    async fn escaped_unicode_checkout_cwd_is_busy() {
        let directory = tempfile::Builder::new()
            .prefix("unicode-é-")
            .permissions(Permissions::from_mode(0o700))
            .tempdir()
            .expect("checkout");
        let checkout = directory.path().canonicalize().expect("canonical checkout");
        let mut child = Command::new("/bin/sleep")
            .arg("60")
            .current_dir(&checkout)
            .kill_on_drop(true)
            .spawn()
            .expect("fixture child");
        let pid = child.id().expect("fixture PID");
        let (listing, _) = capture(
            "/usr/sbin/lsof",
            &["-p", &pid.to_string(), "-n", "-P", "-F0pfn"],
        )
        .await
        .expect("fixture lsof listing");
        let user = geteuid().as_raw();
        let census = format!("{pid} {user} S\n");
        let inventory =
            Inventory::from_listings(&listing, census.as_bytes(), user, 0).expect("inventory");
        assert_eq!(
            inventory.processes[&pid].cwd.as_deref(),
            Some(checkout.as_path())
        );
        assert!(matches!(inventory.activity(&checkout), Ok(Activity::Busy)));
        child.kill().await.expect("stop fixture child");
    }

    #[test]
    fn lsof_fields_preserve_non_utf8_paths_and_leave_ambiguity_unknown() {
        let directory = tempfile::Builder::new()
            .permissions(Permissions::from_mode(0o700))
            .tempdir()
            .expect("checkout");
        let checkout = directory.path().canonicalize().expect("canonical checkout");
        let listing = format!(
            "p1\0\nfcwd\0n{}/nested\\xfe\\n\\\\name\0\n",
            checkout.display()
        );
        let inventory =
            Inventory::from_listings(listing.as_bytes(), b"1 501 S\n", 501, 0).expect("inventory");
        let expected = checkout.join(OsStr::from_bytes(b"nested\xfe\n\\name"));
        assert_eq!(
            inventory.processes[&1].cwd.as_deref(),
            Some(expected.as_path())
        );
        assert!(matches!(inventory.activity(&checkout), Ok(Activity::Busy)));

        for field in [
            br"/elsewhere/^A".as_slice(),
            br"/elsewhere/\x0",
            br"/elsewhere/\q",
        ] {
            let mut listing = b"p1\0\nfcwd\0n".to_vec();
            listing.extend(field);
            listing.extend(b"\0\n");
            let inventory =
                Inventory::from_listings(&listing, b"1 501 S\n", 501, 0).expect("inventory");
            assert!(matches!(
                inventory.activity(&checkout),
                Ok(Activity::Unknown)
            ));
        }
    }
}
