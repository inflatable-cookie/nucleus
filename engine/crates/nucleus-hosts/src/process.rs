use std::{io, path::Path, process::Stdio, time::Duration};

use futures_util::future::try_join3;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time,
};

use crate::HostError;

const DEADLINE: Duration = Duration::from_secs(5);
const MAX_OUTPUT: u64 = 64 * 1024;

/// Check only the exact checkout. Unreadable, partial and timed-out listings
/// cannot establish that a terminal turn has released its workspace.
pub(crate) async fn busy(path: &Path) -> Result<bool, HostError> {
    if !path.is_absolute()
        || path.parent().is_none()
        || path.canonicalize().ok().as_deref() != Some(path)
    {
        return Err(HostError::Binding);
    }
    let mut child = Command::new("/usr/sbin/lsof")
        .args(["-n", "-P", "-F", "p", "+D"])
        .arg(path)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| HostError::Unavailable)?;
    let stdout = child.stdout.take().ok_or(HostError::Protocol)?;
    let stderr = child.stderr.take().ok_or(HostError::Protocol)?;
    let (status, stdout, stderr) = time::timeout(
        DEADLINE,
        try_join3(child.wait(), bounded(stdout), bounded(stderr)),
    )
    .await
    .map_err(|_| HostError::Timeout)?
    .map_err(|_| HostError::Uncertain)?;
    match status.code() {
        // Darwin lsof includes mandatory file records such as `fcwd` after
        // a matching PID, even when only the PID field was requested.
        Some(0) if stdout.split(|&byte| byte == b'\n').any(is_pid) => Ok(true),
        Some(1) if stdout.is_empty() && stderr.is_empty() => Ok(false),
        _ => Err(HostError::Uncertain),
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

fn is_pid(line: &[u8]) -> bool {
    line.strip_prefix(b"p")
        .is_some_and(|pid| !pid.is_empty() && pid.iter().all(u8::is_ascii_digit))
}
