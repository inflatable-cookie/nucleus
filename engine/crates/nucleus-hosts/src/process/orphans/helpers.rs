//! Helpers a provider session leaves under the host's app-server. The app-server
//! starts them in the session's working directory and outlives the session, so
//! they never become orphans.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use tokio::time;

use super::{
    OrphanProcess, command_lines, observed_seconds, process_identities, settled, start_epoch,
};
use crate::{
    HostError,
    process::{DEADLINE, Inventory, verify_roots},
    runtime::is_provider_app_server,
};

impl Inventory {
    /// Direct children of a provider app-server, with their descendants, that
    /// work under `roots` and started after the checkout, the first root, was
    /// created. Children come before parents. The app-server and the host are
    /// never members. The caller must establish that every task role has ended.
    pub(crate) async fn terminal_helpers(
        &self,
        roots: &[PathBuf],
        scratch: &Path,
    ) -> Result<Vec<OrphanProcess>, HostError> {
        // Without a verified T3 server there is no app-server to identify.
        let (Some(checkout), Some((server, _))) = (roots.first(), &self.runtime) else {
            return Ok(Vec::new());
        };
        let inside = |pid: u32| {
            self.processes.get(&pid).is_some_and(|process| {
                !process.ambiguous_path
                    && process
                        .cwd
                        .as_deref()
                        .is_some_and(|cwd| roots.iter().any(|root| cwd.starts_with(root)))
            })
        };
        let candidates: BTreeMap<u32, u32> = self
            .processes
            .iter()
            .filter(|&(&pid, process)| {
                inside(pid)
                    && self
                        .processes
                        .get(&process.parent)
                        .is_some_and(|parent| parent.parent == *server)
            })
            .map(|(&pid, process)| (pid, process.parent))
            .collect();
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        verify_roots(
            &roots
                .iter()
                .map(|root| Some(root.as_path()))
                .collect::<Vec<_>>(),
        )
        .await?;
        // Taken before any evidence read: a PID reused during this scan starts at or after it.
        let observed = observed_seconds()?;
        let created = created_seconds(checkout).await?;
        let parents: BTreeSet<u32> = candidates.values().copied().collect();
        let providers: BTreeSet<u32> = command_lines(&parents, scratch)
            .await?
            .into_iter()
            .filter(|(_, line)| is_provider_app_server(&line.executable, &line.arguments))
            .map(|(pid, _)| pid)
            .collect();
        let mut trees = Vec::new();
        for (&root, provider) in &candidates {
            if !providers.contains(provider) {
                continue;
            }
            let mut tree = vec![root];
            let mut index = 0;
            while let Some(&parent) = tree.get(index) {
                tree.extend(
                    self.processes
                        .iter()
                        .filter_map(|(&pid, process)| (process.parent == parent).then_some(pid)),
                );
                index += 1;
            }
            if !tree.contains(server) && !tree.contains(&std::process::id()) {
                trees.push((*provider, tree));
            }
        }
        let ids: BTreeMap<u32, u32> = trees
            .iter()
            .flat_map(|(_, tree)| tree.iter().map(|&pid| (pid, tree[0])))
            .collect();
        let mut current = process_identities(&ids, scratch).await?;
        if current
            .values()
            .any(|identity| !settled(&identity.started, observed))
        {
            return Err(HostError::Uncertain);
        }
        let mut targets = Vec::new();
        for (provider, tree) in &trees {
            targets.extend(tree.iter().rev().filter_map(|&pid| {
                let mut member = current.remove(&pid)?;
                // A changed parent since the census is not the process it listed.
                let listed = self.processes.get(&pid)?.parent == member.parent;
                // A start in the creation second cannot be ordered after the checkout.
                let newer = start_epoch(&member.started).is_some_and(|start| start > created);
                member.provider = Some(*provider);
                (listed && newer && inside(pid)).then_some(member)
            }));
        }
        // A descendant is stopped only with its root.
        let rooted: BTreeSet<u32> = targets
            .iter()
            .filter(|member| member.pid == member.root)
            .map(|member| member.pid)
            .collect();
        targets.retain(|member| rooted.contains(&member.root));
        Ok(targets)
    }
}

/// The checkout directory's creation time, read off the async worker because the
/// work volume can stall.
async fn created_seconds(checkout: &Path) -> Result<i64, HostError> {
    let checkout = checkout.to_owned();
    let read = tokio::task::spawn_blocking(move || std::fs::metadata(checkout)?.created());
    let created = time::timeout(DEADLINE, read)
        .await
        .map_err(|_| HostError::Timeout)?
        .map_err(|_| HostError::Uncertain)?
        .map_err(|_| HostError::Uncertain)?;
    let since = created
        .duration_since(UNIX_EPOCH)
        .map_err(|_| HostError::Uncertain)?;
    i64::try_from(since.as_secs()).map_err(|_| HostError::Uncertain)
}
