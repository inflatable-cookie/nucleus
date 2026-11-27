#[cfg(target_os = "macos")]
mod detached;
#[cfg(target_os = "macos")]
mod native_cwd;
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
#[cfg(target_os = "macos")]
const PS_COLUMNS: &str = "pid=,ppid=,uid=,stat=,lstart=,flags=,acflag=,ucomm=";
#[cfg(not(target_os = "macos"))]
const PS_COLUMNS: &str = "pid=,ppid=,uid=,stat=,lstart=,comm=";

#[derive(Debug, Clone, Copy, thiserror::Error)]
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

/// A process that holds a retirement root or whose custody could not be verified.
#[derive(Debug, PartialEq, Eq)]
pub struct RetirementBlocker {
    pub pid: u32,
    pub command: String,
    pub started: Option<i64>,
    pub unverified: bool,
    pub detached: bool,
}

impl std::fmt::Display for RetirementBlocker {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "PID {} ({}) ", self.pid, self.command)?;
        if self.detached {
            out.write_str("has an unreadable working directory and an open reference in the task checkout or run scratch.")
        } else if self.unverified {
            out.write_str("has an unreadable working directory. The local process check could not rule out this checkout or its run scratch.")
        } else {
            out.write_str("has its working directory in the task checkout or run scratch.")
        }
    }
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
    Busy(u32),
    Quiet,
    Unknown(Option<u32>),
}

/// Snapshot of the local host user's processes. Missing cwd evidence stays
/// unknown until a follow-up verifies the directory or confirms exit.
pub(crate) struct Inventory {
    processes: HashMap<u32, ProcessPaths>,
    runtime: Option<(u32, HashMap<u32, RuntimeProcess>)>,
}

#[derive(Default)]
struct ProcessPaths {
    parent: u32,
    cwd: Option<PathBuf>,
    ambiguous_path: bool,
    cwd_device: Option<u32>,
    cwd_inode: Option<u64>,
    command: String,
    started: Option<i64>,
    #[cfg(target_os = "macos")]
    missing_directory: bool,
    #[cfg(target_os = "macos")]
    inherits_root: bool,
    detached_references: Option<Vec<PathBuf>>,
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

    #[cfg(any(test, feature = "loopback-fixture"))]
    pub(crate) fn process_fixture(pid: u32, path: &Path) -> Self {
        let mut inventory = Self::quiet_fixture();
        inventory.processes.insert(
            pid,
            ProcessPaths {
                parent: 1,
                cwd: Some(path.into()),
                command: "fixture-process".into(),
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
            &["-axww", "-o", PS_COLUMNS],
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

    pub(crate) async fn complete_missing(&mut self, scratch: &Path) {
        // Processes begun during lsof's walk need their own read. This is one
        // bounded follow-up for the captured census, independent of task count.
        let missing: Vec<u32> = self
            .processes
            .iter()
            .filter_map(|(&pid, paths)| paths.unverified().then_some(pid))
            .collect();
        if missing.is_empty() {
            return;
        }
        let selected = missing
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        #[cfg(target_os = "macos")]
        let paths_only = !self
            .processes
            .values()
            .any(|process| process.missing_directory);
        #[cfg(not(target_os = "macos"))]
        let paths_only = true;
        let mut args = vec!["-a", "-p", &selected, "-n", "-P"];
        if paths_only {
            args.extend(["-d", "cwd", "-F0pfnDi"]);
        } else {
            args.push("-F0pftDin");
        }
        #[cfg(target_os = "macos")]
        let mut references = None;
        if let Ok(listing) =
            read_listing("/usr/sbin/lsof", &args, Some(scratch), MAX_PROBE_OUTPUT).await
            && let Some(paths) = listing.cwd_followup()
        {
            #[cfg(target_os = "macos")]
            if !paths_only && listing.exit == Some(0) {
                references = detached::file_references(&listing.output);
            }
            for (pid, paths) in paths {
                if let Some(existing) = self.processes.get_mut(&pid)
                    && existing.unverified()
                {
                    existing.cwd = paths.cwd;
                    existing.ambiguous_path = paths.ambiguous_path;
                    existing.cwd_device = paths.cwd_device;
                    existing.cwd_inode = paths.cwd_inode;
                    #[cfg(target_os = "macos")]
                    {
                        existing.missing_directory &= paths.missing_directory;
                    }
                }
            }
        }
        // Query again even if lsof returned a path. A reaped PID and a zombie
        // are both gone for custody purposes. A reused PID starts unverified.
        if let Ok(listing) = read_listing(
            "/bin/ps",
            &["-ww", "-p", &selected, "-o", PS_COLUMNS],
            Some(scratch),
            MAX_PROBE_OUTPUT,
        )
        .await
            && let Ok((rows, _)) = listing.successful()
            && let Ok(mut current) = Self::from_listings(&[], &rows, geteuid().as_raw(), 0)
        {
            for pid in missing {
                match (self.processes.get_mut(&pid), current.processes.remove(&pid)) {
                    (Some(previous), Some(latest)) if previous.started != latest.started => {
                        *previous = latest;
                    }
                    #[cfg(target_os = "macos")]
                    (Some(previous), Some(latest)) => {
                        previous.inherits_root &=
                            latest.inherits_root && previous.parent == latest.parent;
                    }
                    (_, None) => {
                        self.processes.remove(&pid);
                    }
                    _ => {}
                }
            }
            #[cfg(target_os = "macos")]
            {
                self.recover_paths().await;
                if let Some(references) = references {
                    self.scope_detached(references).await;
                }
            }
        }
        self.processes.retain(|&pid, _| !gone(pid));
    }

    #[cfg(target_os = "macos")]
    async fn recover_paths(&mut self) {
        let unresolved = self
            .processes
            .iter()
            .filter_map(|(&pid, paths)| {
                paths.started?;
                paths
                    .unverified()
                    .then_some((pid, paths.cwd_device?, paths.cwd_inode?))
            })
            .collect();
        for (pid, path) in native_cwd::recover(unresolved).await {
            if let Some(process) = self.processes.get_mut(&pid) {
                process.cwd = Some(path);
                process.ambiguous_path = false;
            }
        }
    }

    #[cfg(target_os = "macos")]
    async fn scope_detached(&mut self, mut references: HashMap<u32, Vec<PathBuf>>) {
        // Darwin's cwd error also covers a custom process root. A live birth
        // parent with the default root and a child that has neither exec'd
        // nor used privilege rule out an error reading a custom process root.
        let candidates: Vec<_> = self
            .processes
            .iter()
            .filter_map(|(&pid, process)| {
                if !process.unverified()
                    || !process.missing_directory
                    || !process.inherits_root
                    || !references.contains_key(&pid)
                    || process.parent <= 1
                {
                    return None;
                }
                let parent = self.processes.get(&process.parent)?;
                let (started, parent_started) = (process.started?, parent.started?);
                (parent_started <= started).then_some(detached::Ancestry {
                    pid,
                    started,
                    parent: process.parent,
                    parent_started,
                })
            })
            .collect();
        for pid in detached::default_root_children(candidates).await {
            if let Some(process) = self.processes.get_mut(&pid) {
                process.detached_references = references.remove(&pid);
            }
        }
    }

    #[cfg(all(target_os = "macos", any(test, feature = "loopback-fixture")))]
    pub(crate) async fn scoped_fixture(files: &[u8], ps: &[u8]) -> Result<Self, HostError> {
        let mut inventory = Self::from_listings(files, ps, geteuid().as_raw(), 0)?;
        let references = detached::file_references(files).ok_or(HostError::Protocol)?;
        inventory.scope_detached(references).await;
        Ok(inventory)
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
            let uid = columns
                .next()
                .and_then(|uid| uid.parse::<u32>().ok())
                .ok_or(HostError::Protocol)?;
            let status = columns.next().ok_or(HostError::Protocol)?;
            if pid != probe_pid && uid == user && !status.starts_with('Z') {
                let mut process = by_pid.remove(&pid).unwrap_or_default();
                process.parent = parent;
                let started = columns.by_ref().take(5).collect::<Vec<_>>().join(" ");
                process.started = orphans::start_epoch(&started);
                #[cfg(target_os = "macos")]
                {
                    process.inherits_root = detached::inherits_root(columns.next(), columns.next());
                }
                process.command = columns.collect::<Vec<_>>().join(" ");
                live.insert(pid, process);
            }
        }
        Ok(Self {
            processes: live,
            runtime: None,
        })
    }

    pub(crate) fn activity(
        &self,
        path: &Path,
        scratch: Option<&Path>,
        runtime: &HashSet<u32>,
    ) -> Activity {
        self.activity_with(path, scratch, runtime, false)
    }

    fn activity_with(
        &self,
        path: &Path,
        scratch: Option<&Path>,
        runtime: &HashSet<u32>,
        retiring: bool,
    ) -> Activity {
        let mut missing: Option<u32> = None;
        for (&pid, process) in &self.processes {
            if runtime.contains(&pid) {
                continue;
            }
            if process.cwd.as_ref().is_some_and(|cwd| {
                cwd.starts_with(path) || scratch.is_some_and(|root| cwd.starts_with(root))
            }) {
                return Activity::Busy(pid);
            }
            if process.unverified() {
                if retiring && let Some(references) = &process.detached_references {
                    if references
                        .iter()
                        .any(|reference| reference.starts_with(path))
                    {
                        return Activity::Busy(pid);
                    }
                    continue;
                }
                missing = Some(missing.map_or(pid, |prior| prior.min(pid)));
            }
        }
        if missing.is_some() || self.processes.is_empty() {
            Activity::Unknown(missing)
        } else {
            Activity::Quiet
        }
    }

    pub(crate) fn retirement_blocker(
        &self,
        root: &Path,
    ) -> Result<Option<RetirementBlocker>, HostError> {
        let (pid, unverified) = match self.activity_with(root, None, &HashSet::new(), true) {
            Activity::Busy(pid) => (pid, false),
            Activity::Unknown(Some(pid)) => (pid, true),
            Activity::Unknown(None) => {
                return Err(HostError::ProcessCoverage(
                    ProcessEvidenceFailure::Incomplete,
                ));
            }
            Activity::Quiet => return Ok(None),
        };
        let process = &self.processes[&pid];
        Ok(Some(RetirementBlocker {
            pid,
            command: if process.command.is_empty() {
                "command unavailable".into()
            } else {
                process.command.clone()
            },
            started: process.started,
            unverified,
            detached: process.detached_references.is_some(),
        }))
    }

    pub(crate) fn unresolved(&self) -> Option<Vec<(u32, i64)>> {
        if self.processes.is_empty() {
            return None;
        }
        self.processes
            .iter()
            .filter(|(_, paths)| paths.unverified() && paths.detached_references.is_none())
            .map(|(&pid, paths)| Some((pid, paths.started?)))
            .collect()
    }

    pub(crate) fn writer(
        &self,
        checkout: &Path,
        scratch: Option<&Path>,
        runtime: &HashSet<u32>,
    ) -> Result<Option<u32>, HostError> {
        match self.activity(checkout, scratch, runtime) {
            Activity::Busy(pid) => Ok(Some(pid)),
            Activity::Quiet => Ok(None),
            Activity::Unknown(pid) => Err(HostError::ProcessCoverage(
                pid.map_or(ProcessEvidenceFailure::Incomplete, |pid| {
                    ProcessEvidenceFailure::Cwd { pid }
                }),
            )),
        }
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
            #[cfg(target_os = "macos")]
            detached::MISSING_DIRECTORY if is_cwd => {
                rows.entry(pid.ok_or(HostError::Protocol)?)
                    .or_default()
                    .missing_directory = true;
            }
            [b'D', device @ ..] if is_cwd => {
                let process = rows.entry(pid.ok_or(HostError::Protocol)?).or_default();
                process.cwd_device = std::str::from_utf8(device)
                    .ok()
                    .and_then(|value| value.strip_prefix("0x"))
                    .and_then(|value| u32::from_str_radix(value, 16).ok());
            }
            [b'i', inode @ ..] if is_cwd => {
                let process = rows.entry(pid.ok_or(HostError::Protocol)?).or_default();
                process.cwd_inode = std::str::from_utf8(inode)
                    .ok()
                    .and_then(|value| value.parse().ok());
            }
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
            inventory.activity(&path, None, &HashSet::new()),
            Activity::Unknown(Some(2))
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
            inventory.activity(&checkout, None, &HashSet::new()),
            Activity::Unknown(Some(pid)) if pid == exited
        ));
        inventory.complete_missing(&checkout).await;
        assert!(matches!(
            inventory.activity(&checkout, None, &HashSet::new()),
            Activity::Quiet
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
            inventory.activity(&checkout, None, &HashSet::new()),
            Activity::Busy(_)
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
            inventory.activity(&checkout, None, &HashSet::new()),
            Activity::Busy(_)
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
                inventory.activity(&checkout, None, &HashSet::new()),
                Activity::Unknown(Some(1))
            ));
        }
    }
}
