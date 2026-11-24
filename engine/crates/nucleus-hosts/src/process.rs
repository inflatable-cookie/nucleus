use std::{
    collections::{HashMap, HashSet, hash_map::Entry},
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

use futures_util::future::{try_join, try_join3};
use rustix::{
    fs::{FileType, Mode, OFlags, Stat, fstat, open, stat},
    io::Errno,
    process::{Pid, geteuid, test_kill_process},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::Mutex,
    time,
};

use crate::{
    HostError,
    runtime::{
        RuntimeProcess, RuntimeShape, ServerRuntime, read_candidates, standing_runtime_pids,
    },
};

const DEADLINE: Duration = Duration::from_secs(5);
const MAX_OUTPUT: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, thiserror::Error)]
pub enum ProcessEvidenceFailure {
    #[error("the census timed out")]
    Timeout,
    #[error("the census exceeded its output limit")]
    Truncated,
    #[error("the mount or directory witness could not be verified")]
    Scope,
    #[error("the process listing was incomplete")]
    Incomplete,
}

pub(crate) const fn coverage_error(error: HostError) -> HostError {
    HostError::ProcessCoverage(match error {
        HostError::ProcessCoverage(reason) => reason,
        HostError::Timeout => ProcessEvidenceFailure::Timeout,
        HostError::Binding => ProcessEvidenceFailure::Scope,
        _ => ProcessEvidenceFailure::Incomplete,
    })
}

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
    runtime: Option<(u32, HashMap<u32, RuntimeProcess>)>,
    scoped: Mutex<HashMap<(PathBuf, Option<PathBuf>), ScopedResult>>,
}

type ScopedResult = Result<OpenOwners, HostError>;

#[derive(Default)]
struct OpenOwners {
    cwd: HashSet<u32>,
    files: HashSet<u32>,
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
                    ambiguous_path: false,
                },
            )]),
            runtime: None,
            scoped: Mutex::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn cwd_fixture(path: &Path) -> Self {
        let mut inventory = Self::quiet_fixture();
        inventory.processes.insert(
            2,
            ProcessPaths {
                parent: 1,
                cwd: Some(path.into()),
                ambiguous_path: false,
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
                ambiguous_path: false,
            },
        );
        if unrelated {
            inventory.processes.insert(
                5,
                ProcessPaths {
                    parent: 4,
                    cwd: Some(checkout.to_path_buf()),
                    ambiguous_path: false,
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
            Some(scratch),
        )
        .await?;
        // The later inventory includes any new PID lsof did not see. A zombie
        // has already released its cwd and cannot access the checkout.
        let (processes, probe_pid) =
            capture("/bin/ps", &["-axo", "pid=,ppid=,uid=,stat="], Some(scratch)).await?;
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
            let parent = columns
                .next()
                .and_then(|parent| parent.parse::<u32>().ok())
                .ok_or(HostError::Protocol)?;
            let uid = columns
                .next()
                .and_then(|uid| uid.parse::<u32>().ok())
                .ok_or(HostError::Protocol)?;
            let status = columns.next().ok_or(HostError::Protocol)?;
            if pid != probe_pid && uid == user && !status.starts_with('Z') {
                let mut process = by_pid.remove(&pid).unwrap_or_default();
                process.parent = parent;
                live.insert(pid, process);
            }
        }
        Ok(Self {
            processes: live,
            runtime: None,
            scoped: Mutex::default(),
        })
    }

    pub(crate) fn activity(
        &self,
        path: &Path,
        runtime: &HashSet<u32>,
    ) -> Result<Activity, HostError> {
        verify_root(path)?;
        let mut missing = false;
        for (&pid, process) in &self.processes {
            if runtime.contains(&pid) {
                continue;
            }
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

    pub(crate) async fn activity_for(
        &self,
        checkout: &Path,
        run_scratch: Option<&Path>,
        temporary: &Path,
        runtime: &HashSet<u32>,
    ) -> Result<Activity, HostError> {
        let cwd = self.activity(checkout, runtime)?;
        if matches!(cwd, Activity::Busy) {
            return Ok(Activity::Busy);
        }
        match (
            cwd,
            run_scratch.map_or(Ok(Activity::Quiet), |path| self.activity(path, runtime))?,
        ) {
            (_, Activity::Busy) => return Ok(Activity::Busy),
            (Activity::Unknown, _) | (_, Activity::Unknown) => return Ok(Activity::Unknown),
            _ => {}
        }
        let mut scoped = self.scoped.lock().await;
        let key = (checkout.to_path_buf(), run_scratch.map(Path::to_path_buf));
        let scan = match scoped.entry(key) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                entry.insert(scoped_activity(checkout, run_scratch, temporary).await)
            }
        };
        let paths = scan.as_ref().map_err(|error| *error)?;
        Ok(
            if !paths.files.is_empty() || paths.cwd.iter().any(|pid| !runtime.contains(pid)) {
                Activity::Busy
            } else {
                Activity::Quiet
            },
        )
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
        .map_err(|_| HostError::ProcessCoverage(ProcessEvidenceFailure::Scope))?;
        Ok(Self { path, fd })
    }
}

async fn scoped_activity(
    checkout: &Path,
    run_scratch: Option<&Path>,
    temporary: &Path,
) -> ScopedResult {
    let mut witnesses = vec![Witness::open(checkout)?];
    if let Some(path) = run_scratch.filter(|path| *path != checkout) {
        witnesses.push(Witness::open(path)?);
    }
    let mounts = scoped_mounts(&witnesses, temporary).await?;
    let mut args: Vec<&OsStr> = ["-n", "-P", "-F0pfn", "+f", "--"]
        .into_iter()
        .map(OsStr::new)
        .collect();
    args.extend(mounts.values().map(|mount| mount.as_os_str()));
    let listing = read_listing("/usr/sbin/lsof", &args, Some(temporary)).await?;
    // Keep the directory descriptors open while lsof runs. They are dropped
    // with the witnesses before the pass can authorize worktree removal.
    if mounts != scoped_mounts(&witnesses, temporary).await? {
        return Err(HostError::ProcessCoverage(ProcessEvidenceFailure::Scope));
    }
    scoped_listing(&listing, &witnesses)
        .ok_or(HostError::ProcessCoverage(ProcessEvidenceFailure::Scope))
}

fn identity(metadata: Stat) -> (i128, u64) {
    (i128::from(metadata.st_dev), metadata.st_ino)
}

async fn scoped_mounts(
    witnesses: &[Witness<'_>],
    temporary: &Path,
) -> Result<HashMap<i128, PathBuf>, HostError> {
    let mut paths = vec![OsStr::new("-P"), OsStr::new("--")];
    paths.extend(witnesses.iter().map(|witness| witness.path.as_os_str()));
    let (anchors, listed) = try_join(
        read_listing("/bin/df", &paths, Some(temporary)),
        read_listing("/bin/df", &["-P"], Some(temporary)),
    )
    .await?;
    select_mounts(&anchors, &listed, witnesses)
        .ok_or(HostError::ProcessCoverage(ProcessEvidenceFailure::Scope))
}

fn select_mounts(
    anchors: &Listing,
    listed: &Listing,
    witnesses: &[Witness<'_>],
) -> Option<HashMap<i128, PathBuf>> {
    let roots = witnesses
        .iter()
        .map(|witness| {
            let open = identity(fstat(&witness.fd).ok()?);
            (identity(stat(witness.path).ok()?) == open).then_some(open)
        })
        .collect::<Option<Vec<_>>>()?;
    // lsof can reject two names for the same device. Use the name df
    // resolves for the witnessed directory, including APFS aliases.
    let anchors = mount_points(anchors)?;
    if anchors.len() != roots.len() {
        return None;
    }
    let mut selected = HashMap::new();
    for (path, &(device, _)) in anchors.into_iter().zip(&roots) {
        if identity(stat(path).ok()?).0 != device {
            return None;
        }
        selected.entry(device).or_insert_with(|| path.into());
    }
    for mount in mount_points(listed)? {
        let device = identity(stat(mount).ok()?).0;
        // Comparing ancestor identities also finds a nested mount below
        // the physical spelling of a logical APFS directory.
        if mount
            .ancestors()
            .skip(1)
            .any(|path| stat(path).is_ok_and(|metadata| roots.contains(&identity(metadata))))
        {
            selected.entry(device).or_insert_with(|| mount.into());
        }
    }
    Some(selected)
}

fn mount_points(listed: &Listing) -> Option<Vec<&Path>> {
    if listed.exit != Some(0) {
        return None;
    }
    let lines = listed
        .output
        .strip_suffix(b"\n")?
        .split(|&byte| byte == b'\n');
    lines
        .skip(1)
        .map(|mut line| {
            // The filesystem label can contain spaces. The percentage column
            // precedes the complete mount path, which may contain spaces too.
            loop {
                let end = line.iter().position(u8::is_ascii_whitespace)?;
                let word = &line[..end];
                line = line[end..].trim_ascii_start();
                if word
                    .strip_suffix(b"%")
                    .is_some_and(|value| !value.is_empty() && value.iter().all(u8::is_ascii_digit))
                {
                    break;
                }
            }
            // df display escapes are ambiguous. An unrepresentable mount
            // cannot provide negative evidence.
            let path = Path::new(OsStr::from_bytes(line));
            (path.is_absolute() && !line.contains(&b'\\')).then_some(path)
        })
        .collect::<Option<Vec<_>>>()
        .filter(|mounts| !mounts.is_empty())
}

fn scoped_listing(listing: &Listing, witnesses: &[Witness<'_>]) -> Option<OpenOwners> {
    if listing.exit != Some(0) {
        return None;
    }
    let fields = listing.output.strip_suffix(b"\0\n")?;
    let mut seen = vec![false; witnesses.len()];
    let mut pid = None;
    let mut fd = None;
    let mut owners = OpenOwners::default();
    for field in fields.split(|&byte| byte == 0) {
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
                } else if witnesses
                    .iter()
                    .any(|witness| path.starts_with(witness.path))
                {
                    if descriptor == b"cwd" {
                        owners.cwd.insert(pid?);
                    } else {
                        owners.files.insert(pid?);
                    }
                }
            }
            _ => return None,
        }
    }
    if fd.is_some() || !seen.into_iter().all(|found| found) {
        return None;
    }
    Some(owners)
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
    let listing = read_listing(command, args, scratch).await?;
    if listing.exit == Some(0) && !listing.output.is_empty() {
        Ok((listing.output, listing.pid))
    } else {
        Err(HostError::Uncertain)
    }
}

async fn read_listing(
    command: &str,
    args: &[impl AsRef<OsStr>],
    scratch: Option<&Path>,
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
        try_join3(child.wait(), bounded(stdout), bounded(stderr)),
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

async fn bounded(reader: impl AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let count = reader.take(MAX_OUTPUT + 1).read_to_end(&mut bytes).await?;
    if u64::try_from(count).unwrap_or(u64::MAX) > MAX_OUTPUT {
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
            inventory.activity(&path, &HashSet::new()),
            Ok(Activity::Unknown)
        ));
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

    #[test]
    fn a_missing_witness_is_incomplete() {
        let checkout = tempfile::tempdir().expect("checkout");
        let scratch = tempfile::tempdir().expect("scratch");
        let witnesses = [
            Witness::open(checkout.path()).expect("open checkout"),
            Witness::open(scratch.path()).expect("open scratch"),
        ];
        let listing = Listing {
            exit: Some(0),
            output: format!(
                "p{}\0\nf{}\0n{}\0\n",
                std::process::id(),
                witnesses[0].fd.as_raw_fd(),
                checkout.path().display(),
            )
            .into_bytes(),
            pid: 0,
        };
        assert!(scoped_listing(&listing, &witnesses).is_none());
    }

    #[test]
    fn mount_scope_includes_nested_devices_and_rejects_display_escapes() {
        let root = Witness::open(Path::new("/")).expect("root witness");
        let listing = Listing {
            exit: Some(0),
            output: b"Filesystem 512-blocks Used Available Capacity Mounted on\nroot 20 1 19 5% /\ndevfs 10 10 0 100% /dev\n".to_vec(),
            pid: 0,
        };
        let anchor = Listing {
            exit: Some(0),
            output: b"Filesystem 512-blocks Used Available Capacity Mounted on
root 20 1 19 5% /
"
            .to_vec(),
            pid: 0,
        };
        let mounts = select_mounts(&anchor, &listing, &[root]).expect("mount scope");
        assert!(mounts.values().any(|path| path == Path::new("/dev")));
        assert_eq!(mounts.len(), 2);
        let undecodable = Listing {
            output: b"Filesystem 512-blocks Used Available Capacity Mounted on\nsource with spaces 20 1 19 5% /Volume\\040Alias\n".to_vec(),
            ..listing
        };
        assert!(mount_points(&undecodable).is_none());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn internal_directory_witness_sees_one_selector_for_apfs_aliases() {
        let users = Path::new("/Users");
        let temporary = tempfile::tempdir().expect("scratch");
        let witness = Witness::open(users).expect("internal directory witness");
        let mounts = scoped_mounts(&[witness], temporary.path())
            .await
            .expect("internal mount");
        let device = identity(stat(users).expect("directory facts")).0;
        assert_eq!(
            mounts.get(&device).map(PathBuf::as_path),
            Some(Path::new("/System/Volumes/Data"))
        );
        let scan = scoped_activity(users, None, temporary.path()).await;
        assert!(
            scan.is_ok(),
            "the real census should verify its internal directory witness"
        );
    }

    #[tokio::test]
    async fn a_standing_runtime_releases_both_scopes_but_its_tool_holds() {
        let private = || {
            tempfile::Builder::new()
                .permissions(Permissions::from_mode(0o700))
                .tempdir()
                .expect("private scope")
        };
        let checkout = private();
        let scratch = private();
        let checkout = checkout.path().canonicalize().expect("canonical checkout");
        let scratch = scratch.path().canonicalize().expect("canonical scratch");
        let mut listing = String::from("p10\0\nfcwd\0n/\0\np24\0\nfcwd\0n/\0\n");
        for pid in 20..=23 {
            use std::fmt::Write;
            writeln!(listing, "p{pid}\0\nfcwd\0n{}\0", checkout.display()).expect("cwd entry");
        }
        let census =
            b"10 1 501 S\n20 10 501 S\n21 20 501 S\n22 20 501 S\n23 20 501 S\n24 21 501 S\n";
        let mut inventory =
            Inventory::from_listings(listing.as_bytes(), census, 501, 0).expect("processes");
        let runtime = [
            (20, 10, "codex app-server"),
            (21, 20, "/plugins/node_repl"),
            (22, 20, "/plugins/node_repl"),
            (23, 20, "/plugins/cua-driver mcp"),
        ]
        .into_iter()
        .filter_map(|(pid, parent, command)| {
            RuntimeProcess::from_command(parent, command).map(|facts| (pid, facts))
        })
        .collect();
        inventory.runtime = Some((10, runtime));
        inventory.scoped.get_mut().insert(
            (checkout.clone(), Some(scratch.clone())),
            Ok(OpenOwners {
                cwd: HashSet::from([21, 22, 23]),
                files: HashSet::new(),
            }),
        );
        let runtime = inventory.standing_pids("fixture-thread");
        assert!(matches!(
            inventory
                .activity_for(&checkout, Some(&scratch), &scratch, &runtime)
                .await,
            Ok(Activity::Quiet)
        ));
        inventory.scoped.get_mut().insert(
            (checkout.clone(), Some(scratch.clone())),
            Ok(OpenOwners {
                cwd: HashSet::from([21, 22, 23]),
                files: HashSet::from([21]),
            }),
        );
        assert!(matches!(
            inventory
                .activity_for(&checkout, Some(&scratch), &scratch, &runtime)
                .await,
            Ok(Activity::Busy)
        ));
    }

    #[tokio::test]
    async fn a_large_checkout_distinguishes_closed_files_from_a_nested_open_file() {
        let checkout = tempfile::tempdir().expect("checkout");
        let scratch = tempfile::tempdir().expect("scratch");
        let checkout = checkout.path().canonicalize().expect("canonical checkout");
        let scratch = scratch.path().canonicalize().expect("canonical scratch");
        let nested = checkout.join("nested");
        std::fs::create_dir(&nested).expect("nested directory");
        for index in 0..80_001 {
            std::fs::File::create(nested.join(format!("closed-{index}"))).expect("closed file");
        }
        let path = nested.join("tool-file");
        std::fs::File::create(&path).expect("file initially closed");
        assert!(matches!(
            scoped_activity(&checkout, Some(&scratch), &scratch).await,
            Ok(owners) if owners.cwd.is_empty() && owners.files.is_empty()
        ));
        let held = std::fs::File::open(&path).expect("open file outside process cwd");
        assert!(matches!(
            scoped_activity(&checkout, Some(&scratch), &scratch).await,
            Ok(owners) if owners.files.contains(&std::process::id())
        ));
        drop(held);
    }

    #[tokio::test]
    async fn positive_cwd_evidence_wins_when_open_file_coverage_is_truncated() {
        let checkout = tempfile::Builder::new()
            .permissions(Permissions::from_mode(0o700))
            .tempdir()
            .expect("checkout");
        let checkout = checkout.path().canonicalize().expect("canonical checkout");
        let mut inventory = Inventory::cwd_fixture(&checkout);
        inventory.scoped.get_mut().insert(
            (checkout.clone(), None),
            Err(HostError::ProcessCoverage(
                ProcessEvidenceFailure::Truncated,
            )),
        );
        assert!(matches!(
            inventory
                .activity_for(&checkout, None, &checkout, &HashSet::new())
                .await,
            Ok(Activity::Busy)
        ));
        assert!(matches!(
            bounded(tokio::io::repeat(0)).await.unwrap_err().kind(),
            io::ErrorKind::FileTooLarge
        ));
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
            inventory.activity(&checkout, &HashSet::new()),
            Ok(Activity::Busy)
        ));
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
        let inventory = Inventory::from_listings(listing.as_bytes(), b"1 0 501 S\n", 501, 0)
            .expect("inventory");
        let expected = checkout.join(OsStr::from_bytes(b"nested\xfe\n\\name"));
        assert_eq!(
            inventory.processes[&1].cwd.as_deref(),
            Some(expected.as_path())
        );
        assert!(matches!(
            inventory.activity(&checkout, &HashSet::new()),
            Ok(Activity::Busy)
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
                inventory.activity(&checkout, &HashSet::new()),
                Ok(Activity::Unknown)
            ));
        }
    }
}
