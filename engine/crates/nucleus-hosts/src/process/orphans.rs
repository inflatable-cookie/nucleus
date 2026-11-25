//! Terminal cleanup only. Candidates come from the shared cwd census.
//! Immediately before signalling, check root cwd, parentage and process identity.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use rustix::process::{Pid, Signal, kill_process};
use serde::Serialize;
use std::io;

use super::{HostError, Inventory, MAX_PROBE_OUTPUT, read_listing, verify_root};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OrphanProcess {
    pid: u32,
    root: u32,
    parent: u32,
    started: String,
    command: String,
}

impl Inventory {
    pub(crate) async fn terminal_orphans(
        &self,
        checkout: &Path,
        scratch: &Path,
    ) -> Result<Vec<OrphanProcess>, HostError> {
        verify_root(checkout)?;
        let mut candidates = Vec::new();
        for (&root, paths) in &self.processes {
            if root <= 1
                || paths.parent != 1
                || paths.ambiguous_path
                || !paths
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| cwd.starts_with(checkout))
            {
                continue;
            }
            let (host, _) = self.runtime.as_ref().ok_or(HostError::Uncertain)?;
            let mut tree = vec![root];
            let mut index = 0;
            while let Some(&parent) = tree.get(index) {
                tree.extend(
                    self.processes
                        .iter()
                        .filter_map(|(&pid, paths)| (paths.parent == parent).then_some(pid)),
                );
                index += 1;
            }
            if !tree.contains(host) && !tree.contains(&std::process::id()) {
                // Signal children before their parents. Recheck membership at signal time.
                candidates.extend(tree.into_iter().rev().map(|pid| (pid, root)));
            }
        }
        let mut current =
            process_identities(&candidates.iter().copied().collect(), scratch).await?;
        Ok(candidates
            .into_iter()
            .filter_map(|(pid, _)| current.remove(&pid))
            .collect())
    }
}

async fn root_still_in_checkout(
    root: u32,
    checkout: &Path,
    scratch: &Path,
) -> Result<bool, HostError> {
    let listing = read_listing(
        "/usr/sbin/lsof",
        &[
            "-a",
            "-p",
            &root.to_string(),
            "-d",
            "cwd",
            "-n",
            "-P",
            "-F0pfn",
        ],
        Some(scratch),
        MAX_PROBE_OUTPUT,
    )
    .await?;
    Ok(listing
        .cwd_followup()
        .and_then(|mut rows| rows.remove(&root))
        .is_some_and(|p| {
            !p.ambiguous_path && p.cwd.as_deref().is_some_and(|p| p.starts_with(checkout))
        }))
}

/// Confirm each PID immediately before signalling. After TERM, a surviving
/// child can belong to launchd because its original parent has exited.
/// # Errors
/// An unreadable identity cannot authorize a signal.
pub async fn verify_orphans(
    targets: &[OrphanProcess],
    checkout: &Path,
    scratch: &Path,
    force: bool,
) -> Result<Vec<OrphanProcess>, HostError> {
    verify_root(checkout)?;
    let now =
        process_identities(&targets.iter().map(|p| (p.pid, p.root)).collect(), scratch).await?;
    let mut allowed = BTreeSet::new();
    let mut result = Vec::new();
    for member in targets.iter().rev() {
        let Some(current) = now.get(&member.pid) else {
            continue;
        };
        if member.started != current.started || member.command != current.command {
            continue;
        }
        let owned = if member.pid == member.root {
            current.parent == 1 && root_still_in_checkout(member.pid, checkout, scratch).await?
        } else {
            (current.parent == member.parent && allowed.contains(&current.parent))
                || (force && current.parent == 1 && !now.contains_key(&member.parent))
        };
        if owned {
            allowed.insert(member.pid);
            result.push(member.clone());
        }
    }
    result.reverse();
    Ok(result)
}

impl OrphanProcess {
    /// Signal a verified member. Returns false if it has already exited.
    /// # Errors
    /// Returns the operating system's refusal if the signal could not be sent.
    pub fn signal(&self, force: bool) -> io::Result<bool> {
        let pid = i32::try_from(self.pid)
            .ok()
            .and_then(Pid::from_raw)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid process ID"))?;
        match kill_process(pid, if force { Signal::KILL } else { Signal::TERM }) {
            Ok(()) => Ok(true),
            Err(rustix::io::Errno::SRCH) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

async fn process_identities(
    ids: &BTreeMap<u32, u32>,
    scratch: &Path,
) -> Result<BTreeMap<u32, OrphanProcess>, HostError> {
    let mut result = BTreeMap::new();
    if ids.is_empty() {
        return Ok(result);
    }
    let selected = ids.keys().map(u32::to_string).collect::<Vec<_>>().join(",");
    let listing = read_listing(
        "/bin/ps",
        &[
            "-p",
            &selected,
            "-o",
            "pid=,ppid=,uid=,stat=,lstart=,ucomm=",
        ],
        Some(scratch),
        MAX_PROBE_OUTPUT,
    )
    .await?;
    if listing.exit == Some(1) && listing.output.is_empty() {
        return Ok(result);
    }
    let (output, _) = listing.successful()?;
    for line in std::str::from_utf8(&output)
        .map_err(|_| HostError::Protocol)?
        .lines()
    {
        let words: Vec<_> = line.split_ascii_whitespace().collect();
        let [
            pid,
            parent,
            uid,
            status,
            weekday,
            month,
            day,
            clock,
            year,
            command @ ..,
        ] = words.as_slice()
        else {
            return Err(HostError::Protocol);
        };
        let pid: u32 = pid.parse().map_err(|_| HostError::Protocol)?;
        let parent = parent.parse().map_err(|_| HostError::Protocol)?;
        let root = *ids.get(&pid).ok_or(HostError::Protocol)?;
        if command.is_empty() {
            return Err(HostError::Protocol);
        }
        if uid.parse::<u32>().ok() == Some(rustix::process::geteuid().as_raw())
            && !status.starts_with('Z')
        {
            result.insert(
                pid,
                OrphanProcess {
                    pid,
                    root,
                    parent,
                    started: [*weekday, *month, *day, *clock, *year].join(" "),
                    command: command.join(" "),
                },
            );
        }
    }
    Ok(result)
}
