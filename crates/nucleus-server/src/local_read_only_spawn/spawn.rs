use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use nucleus_command_policy::CommandInvocation;

use super::types::{LocalReadOnlySpawnError, LocalReadOnlySpawnOutputSummary};

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
    let mut child = Command::new(&invocation.executable)
        .args(&invocation.argv)
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
                child
                    .kill()
                    .map_err(|error| LocalReadOnlySpawnError::KillFailed(error.to_string()))?;
                let status = child
                    .wait()
                    .map_err(|error| LocalReadOnlySpawnError::WaitFailed(error.to_string()))?;
                return Ok((status.code(), true));
            }
            None => thread::sleep(Duration::from_millis(5)),
        }
    }
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
            Self::OutputPipeUnavailable(pipe) => format!("{pipe} pipe unavailable"),
            Self::OutputReadFailed(reason) => format!("output read failed: {reason}"),
            Self::OutputReaderPanicked => "output reader panicked".to_owned(),
        }
    }
}
