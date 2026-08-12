//! Editor file watch target resolution and per-resource change grouping.
//!
//! Split from the watch god file; behavior unchanged.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use nucleus_local_store::LocalStoreBackend;

use super::scm::resolve_scm_roots;
use super::WatchTarget;
use crate::project_file_policy::admitted_project_watch_path;
use crate::project_resource_target::resolve_project_resource_target;
use crate::ServerStateService;

pub(super) fn resolve_targets<B>(
    state: &ServerStateService<B>,
    project_id: &str,
    resource_ids: &[String],
) -> Result<Vec<WatchTarget>, String>
where
    B: LocalStoreBackend,
{
    let mut seen = BTreeSet::new();
    resource_ids
        .iter()
        .filter(|resource_id| seen.insert((*resource_id).clone()))
        .map(|resource_id| {
            let target =
                resolve_project_resource_target(state, project_id, Some(resource_id.as_str()))?;
            Ok(WatchTarget {
                resource_id: target.resource_id,
                scm_roots: resolve_scm_roots(&target.root),
                root: target.root,
            })
        })
        .collect()
}

pub(super) fn changed_paths_by_resource(
    targets: &[WatchTarget],
    event_paths: &[PathBuf],
) -> Vec<(WatchTarget, Vec<String>)> {
    let mut changed = BTreeMap::<String, (WatchTarget, BTreeSet<String>)>::new();
    for target in targets {
        for path in event_paths {
            let Ok(relative) = path.strip_prefix(&target.root) else {
                continue;
            };
            if !admitted_project_watch_path(relative) {
                continue;
            }
            let display_path = normalized_relative_path(relative);
            changed
                .entry(target.resource_id.clone())
                .or_insert_with(|| (target.clone(), BTreeSet::new()))
                .1
                .insert(display_path);
        }
    }
    changed
        .into_values()
        .map(|(target, paths)| (target, paths.into_iter().collect()))
        .collect()
}

fn normalized_relative_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
