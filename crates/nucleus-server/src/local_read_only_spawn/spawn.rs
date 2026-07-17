use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use nucleus_command_policy::{CommandEnvironmentPolicy, CommandInvocation, CommandSandboxProfile};

use super::types::{LocalReadOnlySpawnError, LocalReadOnlySpawnOutputSummary};

/// Environment keys inherited under `MinimalInheritedSafe`. Everything else
/// in the parent environment (tokens, cloud credentials) is dropped.
const MINIMAL_SAFE_ENVIRONMENT_KEYS: &[&str] = &[
    "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "TZ",
];

#[derive(Debug)]
pub(super) struct SpawnResult {
    pub(super) exit_status: Option<i32>,
    pub(super) timed_out: bool,
    pub(super) output: LocalReadOnlySpawnOutputSummary,
}

impl SpawnResult {
    pub(super) fn summary(&self) -> String {
        let exit = self
            .exit_status
            .map(|status| status.to_string())
            .unwrap_or_else(|| "none".to_owned());

        format!(
            "read-only spawn finished: exit_status={exit}, timed_out={}, stdout_captured_bytes={}, stderr_captured_bytes={}, stdout_truncated={}, stderr_truncated={}",
            self.timed_out,
            self.output.stdout_captured_bytes,
            self.output.stderr_captured_bytes,
            self.output.stdout_truncated,
            self.output.stderr_truncated
        )
    }
}

pub(super) fn spawn_and_wait(
    invocation: &CommandInvocation,
) -> Result<SpawnResult, LocalReadOnlySpawnError> {
    let mut command = sandboxed_command(invocation)?;
    apply_environment_policy(&mut command, &invocation.environment_policy);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group so timeout kill reaches grandchildren.
        command.process_group(0);
    }

    let mut child = command
        .current_dir(&invocation.working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| LocalReadOnlySpawnError::SpawnFailed(error.to_string()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| LocalReadOnlySpawnError::OutputPipeUnavailable("stdout".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| LocalReadOnlySpawnError::OutputPipeUnavailable("stderr".to_owned()))?;
    let stdout_reader = thread::spawn({
        let limit = invocation.stdout_limit_bytes;
        move || read_bounded(stdout, limit)
    });
    let stderr_reader = thread::spawn({
        let limit = invocation.stderr_limit_bytes;
        move || read_bounded(stderr, limit)
    });

    let (exit_status, timed_out) = wait_for_exit(&mut child, invocation.timeout)?;
    let stdout_summary = join_reader(stdout_reader)?;
    let stderr_summary = join_reader(stderr_reader)?;

    Ok(SpawnResult {
        exit_status,
        timed_out,
        output: LocalReadOnlySpawnOutputSummary {
            stdout_captured_bytes: stdout_summary.captured_bytes,
            stderr_captured_bytes: stderr_summary.captured_bytes,
            stdout_truncated: stdout_summary.truncated,
            stderr_truncated: stderr_summary.truncated,
        },
    })
}

/// Build the child command with the invocation's sandbox profile enforced.
///
/// On macOS this wraps the invocation in `sandbox-exec` with a seatbelt
/// profile derived from the sandbox enum. On other platforms sandbox
/// enforcement is unavailable and the spawn fails closed rather than running
/// unsandboxed under a sandboxed label.
fn sandboxed_command(invocation: &CommandInvocation) -> Result<Command, LocalReadOnlySpawnError> {
    #[cfg(target_os = "macos")]
    {
        let profile = seatbelt_profile(&invocation.sandbox, &invocation.working_directory)?;
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .arg("-p")
            .arg(profile)
            .arg("--")
            .arg(&invocation.executable)
            .args(&invocation.argv);
        Ok(command)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(LocalReadOnlySpawnError::SandboxUnavailable(format!(
            "no sandbox backend for profile {:?} on this platform",
            invocation.sandbox
        )))
    }
}

#[cfg(target_os = "macos")]
fn seatbelt_profile(
    sandbox: &CommandSandboxProfile,
    working_directory: &Path,
) -> Result<String, LocalReadOnlySpawnError> {
    match sandbox {
        CommandSandboxProfile::NoFilesystemWrite => Ok(concat!(
            "(version 1)\n",
            "(allow default)\n",
            "(deny file-write*)\n",
            "(allow file-write-data (literal \"/dev/null\"))\n",
        )
        .to_owned()),
        CommandSandboxProfile::ProjectRestricted => {
            let root = working_directory.canonicalize().map_err(|error| {
                LocalReadOnlySpawnError::SandboxUnavailable(format!(
                    "cannot canonicalize project root for sandbox: {error}"
                ))
            })?;
            let root = root.to_str().ok_or_else(|| {
                LocalReadOnlySpawnError::SandboxUnavailable(
                    "project root is not valid UTF-8 for sandbox profile".to_owned(),
                )
            })?;
            if root.contains('"') || root.contains('\\') {
                return Err(LocalReadOnlySpawnError::SandboxUnavailable(
                    "project root contains characters unsupported in sandbox profile".to_owned(),
                ));
            }
            Ok(format!(
                "(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath \"{root}\"))\n(allow file-write-data (literal \"/dev/null\"))\n"
            ))
        }
        unsupported => Err(LocalReadOnlySpawnError::SandboxUnavailable(format!(
            "no seatbelt mapping for sandbox profile {unsupported:?}"
        ))),
    }
}

/// Apply the invocation environment policy. The child never inherits the
/// full parent environment; `Custom` fails closed to an empty environment
/// (the runner rejects it before spawn).
fn apply_environment_policy(command: &mut Command, policy: &CommandEnvironmentPolicy) {
    command.env_clear();
    match policy {
        CommandEnvironmentPolicy::MinimalInheritedSafe => {
            for key in MINIMAL_SAFE_ENVIRONMENT_KEYS {
                if let Ok(value) = std::env::var(key) {
                    command.env(key, value);
                }
            }
        }
        CommandEnvironmentPolicy::AllowlistedKeys(keys) => {
            for key in keys {
                if let Ok(value) = std::env::var(key) {
                    command.env(key, value);
                }
            }
        }
        CommandEnvironmentPolicy::Empty | CommandEnvironmentPolicy::Custom(_) => {}
    }
}

fn wait_for_exit(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Result<(Option<i32>, bool), LocalReadOnlySpawnError> {
    let deadline = Instant::now() + timeout;

    loop {
        match child
            .try_wait()
            .map_err(|error| LocalReadOnlySpawnError::WaitFailed(error.to_string()))?
        {
            Some(status) => return Ok((status.code(), false)),
            None if Instant::now() >= deadline => {
                kill_process_group(child)?;
                let status = child
                    .wait()
                    .map_err(|error| LocalReadOnlySpawnError::WaitFailed(error.to_string()))?;
                return Ok((status.code(), true));
            }
            None => thread::sleep(Duration::from_millis(5)),
        }
    }
}

/// Kill the child's whole process group so grandchildren do not survive the
/// timeout; falls back to killing the direct child.
fn kill_process_group(child: &mut std::process::Child) -> Result<(), LocalReadOnlySpawnError> {
    #[cfg(unix)]
    {
        let group = child.id() as i32;
        let killed = unsafe { libc::kill(-group, libc::SIGKILL) };
        if killed == 0 {
            return Ok(());
        }
    }
    child
        .kill()
        .map_err(|error| LocalReadOnlySpawnError::KillFailed(error.to_string()))
}

#[derive(Debug)]
struct BoundedReadSummary {
    captured_bytes: usize,
    truncated: bool,
}

fn read_bounded<R: Read>(mut reader: R, limit: usize) -> Result<BoundedReadSummary, String> {
    let mut buffer = [0_u8; 8192];
    let mut captured_bytes = 0;
    let mut truncated = false;

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }

        let remaining = limit.saturating_sub(captured_bytes);
        captured_bytes += read.min(remaining);
        if read > remaining {
            truncated = true;
        }
    }

    Ok(BoundedReadSummary {
        captured_bytes,
        truncated,
    })
}

fn join_reader(
    handle: thread::JoinHandle<Result<BoundedReadSummary, String>>,
) -> Result<BoundedReadSummary, LocalReadOnlySpawnError> {
    handle
        .join()
        .map_err(|_| LocalReadOnlySpawnError::OutputReaderPanicked)?
        .map_err(LocalReadOnlySpawnError::OutputReadFailed)
}

impl LocalReadOnlySpawnError {
    pub(super) fn summary(&self) -> String {
        match self {
            Self::SpawnFailed(reason) => format!("spawn failed: {reason}"),
            Self::WaitFailed(reason) => format!("wait failed: {reason}"),
            Self::KillFailed(reason) => format!("kill failed: {reason}"),
            Self::SandboxUnavailable(reason) => format!("sandbox unavailable: {reason}"),
            Self::OutputPipeUnavailable(pipe) => format!("{pipe} pipe unavailable"),
            Self::OutputReadFailed(reason) => format!("output read failed: {reason}"),
            Self::OutputReaderPanicked => "output reader panicked".to_owned(),
        }
    }
}
