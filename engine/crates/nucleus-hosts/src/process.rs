pub(crate) mod orphans;

use std::{
    collections::{HashMap, HashSet},
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

use crate::{
    HostError,
    runtime::{
        RuntimeProcess, RuntimeShape, ServerRuntime, read_candidates, standing_runtime_pids,
    },
};

const DEADLINE: Duration = Duration::from_secs(5);
const MAX_PROBE_OUTPUT: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProcessEvidenceFailure {
    #[error("the census timed out")]
    Timeout,
    #[error("the census exceeded its output limit")]
    Truncated,
    #[error("the checkout or scratch directory could not be verified")]
    Scope,
    #[error("the process listing was incomplete")]
    Incomplete,
    #[error("PID {pid} has no verified working directory after the cwd follow-up")]
    Cwd { pid: u32 },
}

pub(crate) const fn coverage_error(error: HostError) -> HostError {
    HostError::ProcessCoverage(match error {
        HostError::ProcessCoverage(reason) => reason,
        HostError::Timeout => ProcessEvidenceFailure::Timeout,
        HostError::Binding => ProcessEvidenceFailure::Scope,
        _ => ProcessEvidenceFailure::Incomplete,
    })
}

/// Snapshot of the local host user's processes. A missing cwd stays unknown to
/// the writer check unless a follow-up reads it or confirms the process exited.
pub(crate) struct Inventory {
    processes: HashMap<u32, ProcessPaths>,
    runtime: Option<(u32, HashMap<u32, RuntimeProcess>)>,
}

#[derive(Default)]
struct ProcessPaths {
    parent: u32,
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
                    parent: 0,
                    cwd: Some(PathBuf::from("/")),
                    ..ProcessPaths::default()
                },
            )]),
            runtime: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn cwd_fixture(path: &Path) -> Self {
        Self::process_fixture(2, path)
    }

    #[cfg(test)]
    fn process_fixture(pid: u32, path: &Path) -> Self {
        let mut inventory = Self::quiet_fixture();
        inventory.processes.insert(
            pid,
            ProcessPaths {
                parent: 1,
                cwd: Some(path.into()),
                ..ProcessPaths::default()
            },
        );
        inventory
    }

    #[cfg(test)]
    pub(crate) fn bound_helper_fixture(checkout: &Path, thread: &str, unrelated: bool) -> Self {
        let mut inventory = Self::quiet_fixture();
        inventory.processes.insert(
            4,
            ProcessPaths {
                parent: 3,
                cwd: Some(checkout.to_path_buf()),
                ..ProcessPaths::default()
            },
        );
        if unrelated {
            inventory.processes.insert(
                5,
                ProcessPaths {
                    parent: 4,
                    cwd: Some(checkout.to_path_buf()),
                    ..ProcessPaths::default()
                },
            );
        }
        let provider = RuntimeProcess::from_command(1, "codex app-server").expect("provider");
        let helper = RuntimeProcess::from_command(
            3,
            &format!("/fixture/node_repl T3CODE_THREAD_ID={thread}"),
        )
        .expect("bound helper");
        inventory.runtime = Some((1, HashMap::from([(3, provider), (4, helper)])));
        inventory
    }

    pub(crate) async fn capture(
        server: Option<ServerRuntime>,
        scratch: &Path,
    ) -> Result<Self, HostError> {
        let user = geteuid().as_raw();
        let (listing, _) = read_listing(
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
            Some(scratch),
            u64::MAX,
        )
        .await?
        .successful()?;
        // The later inventory includes any new PID lsof did not see. A zombie
        // has already released its cwd and cannot access the checkout.
        let (processes, probe_pid) = read_listing(
            "/bin/ps",
            &["-axo", "pid=,ppid=,uid=,stat="],
            Some(scratch),
            u64::MAX,
        )
        .await?
        .successful()?;
        let mut inventory = Self::from_listings(&listing, &processes, user, probe_pid)?;
        inventory.complete_missing(scratch).await;
        if let Some(server) = server
            && inventory.processes.contains_key(&server.pid)
            && server.still_current(Some(scratch)).await
        {
            let candidates = inventory
                .processes
                .iter()
                .filter_map(|(&pid, process)| {
                    let direct = process.parent == server.pid;
                    let second = inventory
                        .processes
                        .get(&process.parent)
                        .is_some_and(|parent| parent.parent == server.pid);
                    ((direct || second) && process.cwd.is_some() && !process.ambiguous_path)
                        .then_some((pid, process.parent))
                })
                .collect();
            inventory.runtime = Some((server.pid, read_candidates(candidates, scratch).await));
        }
        Ok(inventory)
    }

    async fn complete_missing(&mut self, scratch: &Path) {
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
            && let Ok(listing) = read_listing(
                "/usr/sbin/lsof",
                &["-a", "-p", &missing, "-d", "cwd", "-n", "-P", "-F0pfn"],
                Some(scratch),
                MAX_PROBE_OUTPUT,
            )
            .await
            && let Some(paths) = listing.cwd_followup()
        {
            for (pid, paths) in paths {
                if let Some(existing) = self.processes.get_mut(&pid) {
                    existing.cwd = paths.cwd;
                    existing.ambiguous_path = paths.ambiguous_path;
                }
            }
        }
        self.processes.retain(|&pid, _| !gone(pid));
    }

    pub(crate) fn from_listings(
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
            let parent = columns
                .next()
                .and_then(|parent| parent.parse::<u32>().ok())
                .ok_or(HostError::Protocol)?;
            // `ps` prints a uid outside u32, such as -2 for a system daemon. That row
            // is never this user's, so it must not fail the whole census.
            let uid = columns.next().ok_or(HostError::Protocol)?;
            let status = columns.next().ok_or(HostError::Protocol)?;
            if pid != probe_pid && uid.parse::<u32>().ok() == Some(user) && !status.starts_with('Z')
            {
                let mut process = by_pid.remove(&pid).unwrap_or_default();
                process.parent = parent;
                live.insert(pid, process);
            }
        }
        Ok(Self {
            processes: live,
            runtime: None,
        })
    }

    /// A trash entry stays while a listed process works inside it. A process
    /// whose cwd cannot be read does not keep it.
    pub(crate) async fn trash_clear(&self, root: &Path) -> bool {
        verify_roots(&[Some(root)]).await.is_ok()
            && !self.processes.is_empty()
            && !self.processes.values().any(|process| process.under(root))
    }

    /// The first listed writer in the checkout or run scratch, outside `runtime`.
    pub(crate) fn writer(
        &self,
        checkout: &Path,
        scratch: Option<&Path>,
        runtime: &HashSet<u32>,
    ) -> Result<Option<u32>, HostError> {
        let mut missing: Option<u32> = None;
        for (&pid, process) in &self.processes {
            if runtime.contains(&pid) {
                continue;
            }
            if process.under(checkout) || scratch.is_some_and(|root| process.under(root)) {
                return Ok(Some(pid));
            }
            if process.unverified() {
                missing = Some(missing.map_or(pid, |prior| prior.min(pid)));
            }
        }
        if missing.is_none() && !self.processes.is_empty() {
            return Ok(None);
        }
        Err(HostError::ProcessCoverage(
            missing.map_or(ProcessEvidenceFailure::Incomplete, |pid| {
                ProcessEvidenceFailure::Cwd { pid }
            }),
        ))
    }

    pub(crate) fn standing_pids(&self, thread: &str) -> HashSet<u32> {
        self.runtime
            .as_ref()
            .map_or_else(HashSet::new, |(server, processes)| {
                standing_runtime_pids(*server, processes, thread)
            })
    }

    // A recorded role may still have a standing helper in this checkout after
    // its turn ends. The caller must establish native idleness for that role.
    pub(crate) fn bound_helpers(&self, checkout: &Path, thread: &str) -> Vec<u32> {
        let Some((_, processes)) = &self.runtime else {
            return Vec::new();
        };
        self.standing_pids(thread)
            .into_iter()
            .filter(|pid| {
                processes.get(pid).is_some_and(|process| {
                    process.shape == RuntimeShape::Helper
                        && process.thread.as_deref() == Some(thread)
                }) && self.processes.get(pid).is_some_and(|paths| {
                    !paths.ambiguous_path
                        && paths
                            .cwd
                            .as_ref()
                            .is_some_and(|cwd| cwd.starts_with(checkout))
                })
            })
            .collect()
    }
}

impl ProcessPaths {
    fn unverified(&self) -> bool {
        self.cwd.is_none() || self.ambiguous_path
    }

    fn under(&self, root: &Path) -> bool {
        self.cwd.as_ref().is_some_and(|cwd| cwd.starts_with(root))
    }
}

/// Verify that census roots are private directories of this user. They can sit on
/// the work volume, so the read runs off the async worker under the probe deadline.
pub(crate) async fn verify_roots(roots: &[Option<&Path>]) -> Result<(), HostError> {
    let roots: Vec<PathBuf> = roots.iter().flatten().map(|&root| root.into()).collect();
    let check =
        tokio::task::spawn_blocking(move || roots.iter().try_for_each(|root| verify_root(root)));
    time::timeout(DEADLINE, check)
        .await
        .map_err(|_| HostError::Timeout)?
        .map_err(|_| HostError::Uncertain)?
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

struct Listing {
    exit: Option<i32>,
    output: Vec<u8>,
    pid: u32,
}

impl Listing {
    fn cwd_followup(&self) -> Option<HashMap<u32, ProcessPaths>> {
        // Darwin returns 1 if a selected PID exited, even when it reports
        // the other PIDs. Only the returned cwd rows count as evidence.
        if !matches!(self.exit, Some(0 | 1)) || self.output.is_empty() {
            return None;
        }
        process_paths(&self.output).ok()
    }
}

pub(crate) async fn capture(
    command: &str,
    args: &[&str],
    scratch: Option<&Path>,
) -> Result<(Vec<u8>, u32), HostError> {
    read_listing(command, args, scratch, MAX_PROBE_OUTPUT)
        .await?
        .successful()
}

impl Listing {
    fn successful(self) -> Result<(Vec<u8>, u32), HostError> {
        if self.exit == Some(0) && !self.output.is_empty() {
            Ok((self.output, self.pid))
        } else {
            Err(HostError::Uncertain)
        }
    }
}

async fn read_listing(
    command: &str,
    args: &[impl AsRef<OsStr>],
    scratch: Option<&Path>,
    stdout_limit: u64,
) -> Result<Listing, HostError> {
    let mut process = Command::new(command);
    if let Some(scratch) = scratch {
        process.envs(["TMPDIR", "TMP", "TEMP"].map(|name| (name, scratch)));
    }
    let mut child = process
        .args(args)
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
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
        try_join3(
            child.wait(),
            bounded(stdout, stdout_limit),
            bounded(stderr, MAX_PROBE_OUTPUT),
        ),
    )
    .await
    .map_err(|_| HostError::Timeout)?
    .map_err(|error| match error.kind() {
        io::ErrorKind::FileTooLarge => {
            HostError::ProcessCoverage(ProcessEvidenceFailure::Truncated)
        }
        _ => HostError::Uncertain,
    })?;
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

async fn bounded(reader: impl AsyncRead + Unpin, limit: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let count = reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .await?;
    if u64::try_from(count).unwrap_or(u64::MAX) > limit {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
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
            b"1 0 501 S\n2 1 501 R\n3 1 501 Z\n4 1 501 R\n",
            501,
            4,
        )
        .expect("parse inventory");
        assert!(matches!(
            inventory.writer(&path, None, &HashSet::new()),
            Err(HostError::ProcessCoverage(ProcessEvidenceFailure::Cwd {
                pid: 2
            }))
        ));
    }

    #[tokio::test]
    async fn one_bounded_cwd_followup_drops_an_exited_missing_pid() {
        let scratch = tempfile::Builder::new()
            .permissions(Permissions::from_mode(0o700))
            .tempdir()
            .expect("private scratch");
        let checkout = scratch.path().canonicalize().expect("canonical");
        let exited = u32::try_from(i32::MAX).unwrap();
        assert!(gone(exited), "fixture PID must not exist");
        let mut inventory = Inventory::quiet_fixture();
        inventory.processes.insert(exited, ProcessPaths::default());
        assert!(matches!(
            inventory.writer(&checkout, None, &HashSet::new()),
            Err(HostError::ProcessCoverage(ProcessEvidenceFailure::Cwd { pid })) if pid == exited
        ));
        inventory.complete_missing(&checkout).await;
        assert!(matches!(
            inventory.writer(&checkout, None, &HashSet::new()),
            Ok(None)
        ));
    }

    #[tokio::test]
    async fn the_cwd_followup_names_a_live_writer_the_walk_missed() {
        let directory = tempfile::Builder::new()
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
        let mut inventory = Inventory::quiet_fixture();
        inventory.processes.insert(pid, ProcessPaths::default());
        inventory.complete_missing(&checkout).await;
        assert!(matches!(
            inventory.writer(&checkout, None, &HashSet::new()),
            Ok(Some(writer)) if writer == pid
        ));
        assert!(!inventory.trash_clear(&checkout).await);
        child.kill().await.expect("stop fixture child");
    }

    #[tokio::test]
    async fn only_a_listed_working_directory_keeps_a_trash_entry() {
        let directory = tempfile::Builder::new()
            .permissions(Permissions::from_mode(0o700))
            .tempdir()
            .expect("trash entry");
        let entry = directory.path().canonicalize().expect("canonical entry");
        let rows = b"1 0 501 S\n2 1 501 S\n3 1 501 S\n";
        // PID 2 has no cwd row. PID 3's caret path cannot be decoded.
        let unreadable = b"p1\0\nfcwd\0n/elsewhere\0\np3\0\nfcwd\0n/elsewhere/^A\0\n";
        let inventory = Inventory::from_listings(unreadable, rows, 501, 0).expect("inventory");
        assert!(inventory.trash_clear(&entry).await);

        let mut held = unreadable.to_vec();
        held.extend(format!("p2\0\nfcwd\0n{}/nested\0\n", entry.display()).bytes());
        let inventory = Inventory::from_listings(&held, rows, 501, 0).expect("inventory");
        assert!(!inventory.trash_clear(&entry).await);

        let empty = Inventory::from_listings(b"", b"", 501, 0).expect("inventory");
        assert!(!empty.trash_clear(&entry).await);
    }

    #[tokio::test]
    async fn exit_one_with_no_output_is_incomplete() {
        assert!(matches!(
            capture("/usr/bin/false", &[], None).await,
            Err(HostError::Uncertain)
        ));
    }

    #[tokio::test]
    async fn an_engine_child_gets_all_three_temp_variables() {
        let scratch = tempfile::tempdir().expect("scratch");
        let (output, _) = capture(
            "/bin/sh",
            &["-c", r#"printf '%s\n' "$TMPDIR" "$TMP" "$TEMP""#],
            Some(scratch.path()),
        )
        .await
        .expect("probe");
        let paths = std::str::from_utf8(&output).expect("printed environment");
        assert_eq!(
            paths.lines().collect::<Vec<_>>(),
            vec![scratch.path().to_str().expect("scratch path"); 3]
        );
    }

    #[test]
    fn an_exited_pid_does_not_discard_other_positive_cwd_rows() {
        let reply = Listing {
            exit: Some(1),
            output: b"p12\0\nfcwd\0n/checkout\0\n".to_vec(),
            pid: 0,
        };
        let covered = reply.cwd_followup().expect("positive rows");
        assert_eq!(covered[&12].cwd.as_deref(), Some(Path::new("/checkout")));
        assert!(!covered.contains_key(&13));
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
            Some(&checkout),
        )
        .await
        .expect("fixture lsof listing");
        let user = geteuid().as_raw();
        let census = format!("{pid} 0 {user} S\n");
        let inventory =
            Inventory::from_listings(&listing, census.as_bytes(), user, 0).expect("inventory");
        assert_eq!(
            inventory.processes[&pid].cwd.as_deref(),
            Some(checkout.as_path())
        );
        assert!(matches!(
            inventory.writer(&checkout, None, &HashSet::new()),
            Ok(Some(writer)) if writer == pid
        ));
        child.kill().await.expect("stop fixture child");
    }

    #[test]
    fn a_daemon_with_a_signed_uid_is_not_a_census_failure() {
        // The row shape `ps -axo pid=,ppid=,uid=,stat=` prints for a uid -2 system daemon.
        let processes = b"1 0 501 S\n74465 1 -2 Ss\n";
        let inventory = Inventory::from_listings(b"", processes, 501, 0).expect("inventory");
        assert!(inventory.processes.contains_key(&1));
        assert!(!inventory.processes.contains_key(&74465));
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
        let inventory = Inventory::from_listings(listing.as_bytes(), b"1 0 501 S\n", 501, 0)
            .expect("inventory");
        let expected = checkout.join(OsStr::from_bytes(b"nested\xfe\n\\name"));
        assert_eq!(
            inventory.processes[&1].cwd.as_deref(),
            Some(expected.as_path())
        );
        assert!(matches!(
            inventory.writer(&checkout, None, &HashSet::new()),
            Ok(Some(1))
        ));

        for field in [
            br"/elsewhere/^A".as_slice(),
            br"/elsewhere/\x0",
            br"/elsewhere/\q",
        ] {
            let mut listing = b"p1\0\nfcwd\0n".to_vec();
            listing.extend(field);
            listing.extend(b"\0\n");
            let inventory =
                Inventory::from_listings(&listing, b"1 0 501 S\n", 501, 0).expect("inventory");
            assert!(matches!(
                inventory.writer(&checkout, None, &HashSet::new()),
                Err(HostError::ProcessCoverage(ProcessEvidenceFailure::Cwd {
                    pid: 1
                }))
            ));
        }
    }
}
