//! Terminal cleanup only. Candidates come from the shared cwd census.
//! A tree is stopped only when one of its processes runs the checkout's own code.
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

/// One scan of the orphan trees under a checkout or run scratch.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct OrphanScan {
    /// Trees that run the task's own code, children before parents.
    pub targets: Vec<OrphanProcess>,
    /// Shared services that only inherited the cwd. They are never signalled.
    pub retained: Vec<OrphanProcess>,
}

impl Inventory {
    pub(crate) async fn terminal_orphans(
        &self,
        checkout: &Path,
        scratch: &Path,
    ) -> Result<OrphanScan, HostError> {
        verify_root(checkout)?;
        let mut trees: Vec<Vec<u32>> = Vec::new();
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
                trees.push(tree);
            }
        }
        // Sorting by root keeps the recorded evidence identical across passes.
        trees.sort_by_key(|tree| tree[0]);
        let members: BTreeSet<u32> = trees.iter().flatten().copied().collect();
        let lines = command_lines(&members, scratch).await?;
        let ids: BTreeMap<u32, u32> = trees
            .iter()
            .flat_map(|tree| tree.iter().map(|&pid| (pid, tree[0])))
            .collect();
        let mut current = process_identities(&ids, scratch).await?;
        let mut scan = OrphanScan::default();
        for tree in &trees {
            let owned = tree.iter().any(|pid| {
                lines.get(pid).is_some_and(|(executable, arguments)| {
                    runs_checkout_code(executable, arguments, checkout)
                })
            });
            if owned {
                // Signal children before their parents. Recheck membership at signal time.
                scan.targets
                    .extend(tree.iter().rev().filter_map(|pid| current.remove(pid)));
            } else {
                scan.retained
                    .extend(tree.iter().filter_map(|pid| current.remove(pid)));
            }
        }
        scan.retained.sort_by_key(|process| process.pid);
        Ok(scan)
    }
}

/// Executable path and argument string for each member of the candidate trees.
async fn command_lines(
    pids: &BTreeSet<u32>,
    scratch: &Path,
) -> Result<BTreeMap<u32, (String, String)>, HostError> {
    if pids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let selected = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let executables = ps_rows(&selected, "pid=,comm=", scratch).await?;
    let arguments = ps_rows(&selected, "pid=,args=", scratch).await?;
    Ok(executables
        .into_iter()
        .filter_map(|(pid, executable)| {
            let arguments = arguments.get(&pid)?.clone();
            Some((pid, (executable, arguments)))
        })
        .collect())
}

async fn ps_rows(
    selected: &str,
    format: &str,
    scratch: &Path,
) -> Result<BTreeMap<u32, String>, HostError> {
    let listing = read_listing(
        "/bin/ps",
        &["-p", selected, "-o", format],
        Some(scratch),
        MAX_PROBE_OUTPUT,
    )
    .await?;
    if listing.exit == Some(1) && listing.output.is_empty() {
        return Ok(BTreeMap::new());
    }
    let (output, _) = listing.successful()?;
    let mut rows = BTreeMap::new();
    for line in std::str::from_utf8(&output)
        .map_err(|_| HostError::Protocol)?
        .lines()
    {
        let (pid, rest) = line
            .trim_start()
            .split_once(' ')
            .unwrap_or((line.trim(), ""));
        let pid = pid.parse().map_err(|_| HostError::Protocol)?;
        rows.insert(pid, rest.trim().to_owned());
    }
    Ok(rows)
}

/// The task's own code runs when its executable or an absolute argument names
/// the checkout. A relative argument is not evidence: the inherited cwd would
/// place it inside the checkout, which is exactly what a shared service does.
fn runs_checkout_code(executable: &str, arguments: &str, checkout: &Path) -> bool {
    let checkout = checkout.to_string_lossy();
    names_path(executable, &checkout) || names_path(arguments, &checkout)
}

/// True when `text` contains `root` as a whole path, not as a prefix of a sibling.
fn names_path(text: &str, root: &str) -> bool {
    text.match_indices(root).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + root.len()..].chars().next();
        !before.is_some_and(|c| c.is_alphanumeric() || "-_./~".contains(c))
            && !after.is_some_and(|c| c.is_alphanumeric() || "-_.".contains(c))
    })
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

#[cfg(test)]
mod tests {
    use super::{names_path, runs_checkout_code};
    use std::path::Path;

    #[test]
    fn a_checkout_name_must_be_a_whole_path() {
        let root = "/work/ns-t-abc";
        assert!(names_path("/work/ns-t-abc", root));
        assert!(names_path(
            "node /work/ns-t-abc/node_modules/.bin/vite",
            root
        ));
        assert!(names_path("sh -c 'cd /work/ns-t-abc && run'", root));
        assert!(names_path("--path=/work/ns-t-abc/x", root));
        assert!(!names_path("/work/ns-t-abcd/x", root));
        assert!(!names_path("/other/work/ns-t-abc/x", root));
        assert!(!names_path("/work/ns-t-abc.bak", root));
    }

    #[test]
    fn a_shared_service_with_only_relative_arguments_is_not_own_code() {
        let checkout = Path::new("/work/ns-t-abc");
        assert!(!runs_checkout_code(
            "/usr/bin/limactl",
            "limactl hostagent default/diffdisk",
            checkout
        ));
        assert!(runs_checkout_code(
            "/usr/local/bin/node",
            "node node_modules/.bin/vite /work/ns-t-abc/src",
            checkout
        ));
    }
}
