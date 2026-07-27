use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use nucleus_local_store::LocalStoreBackend;
use serde::{Deserialize, Serialize};

use crate::project_file_policy::admitted_project_watch_path;
use crate::project_resource_target::resolve_project_resource_target;
use crate::ServerStateService;

use super::invalidate_editor_file_discovery;

const WATCH_DEBOUNCE: Duration = Duration::from_millis(120);
const MAX_CHANGED_PATHS_PER_RESOURCE: usize = 256;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EditorFileWatchEvent {
    Changed {
        subscription_id: String,
        project_id: String,
        resource_id: String,
        paths: Vec<String>,
    },
    Failed {
        subscription_id: String,
        project_id: String,
        message: String,
    },
}

pub type EditorFileWatchEventSink = Arc<dyn Fn(EditorFileWatchEvent) + Send + Sync>;

#[derive(Clone, Default)]
pub struct EditorFileWatchRuntime {
    inner: Arc<EditorFileWatchRuntimeInner>,
}

#[derive(Default)]
struct EditorFileWatchRuntimeInner {
    next_subscription: AtomicU64,
    subscriptions: Mutex<HashMap<String, RecommendedWatcher>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct WatchTarget {
    resource_id: String,
    root: PathBuf,
}

impl EditorFileWatchRuntime {
    pub fn start<B>(
        &self,
        state: &ServerStateService<B>,
        project_id: &str,
        resource_ids: &[String],
        sink: EditorFileWatchEventSink,
    ) -> Result<String, String>
    where
        B: LocalStoreBackend,
    {
        let targets = resolve_targets(state, project_id, resource_ids)?;
        if targets.is_empty() {
            return Err("editor file watch requires at least one working resource".to_owned());
        }

        let subscription_id = format!(
            "editor-file-watch:{}",
            self.inner.next_subscription.fetch_add(1, Ordering::Relaxed)
        );
        let (event_sender, event_receiver) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(event_sender)
            .map_err(|error| format!("editor file watch setup failed: {error}"))?;

        for target in &targets {
            watcher
                .watch(&target.root, RecursiveMode::Recursive)
                .map_err(|error| {
                    format!(
                        "editor file watch failed for {}: {error}",
                        target.resource_id
                    )
                })?;
        }
        spawn_event_forwarder(
            event_receiver,
            targets,
            subscription_id.clone(),
            project_id.to_owned(),
            sink,
        );

        self.inner
            .subscriptions
            .lock()
            .map_err(|_| "editor file watch registry lock poisoned".to_owned())?
            .insert(subscription_id.clone(), watcher);
        Ok(subscription_id)
    }

    pub fn stop(&self, subscription_id: &str) -> Result<(), String> {
        self.inner
            .subscriptions
            .lock()
            .map_err(|_| "editor file watch registry lock poisoned".to_owned())?
            .remove(subscription_id);
        Ok(())
    }
}

fn spawn_event_forwarder(
    receiver: Receiver<notify::Result<Event>>,
    targets: Vec<WatchTarget>,
    subscription_id: String,
    project_id: String,
    sink: EditorFileWatchEventSink,
) {
    thread::spawn(move || {
        while let Ok(first) = receiver.recv() {
            let mut changed = BTreeMap::<String, (WatchTarget, BTreeSet<String>)>::new();
            let mut failures = BTreeSet::new();
            merge_watch_result(first, &targets, &mut changed, &mut failures);
            let disconnected = loop {
                match receiver.recv_timeout(WATCH_DEBOUNCE) {
                    Ok(result) => merge_watch_result(result, &targets, &mut changed, &mut failures),
                    Err(RecvTimeoutError::Timeout) => break false,
                    Err(RecvTimeoutError::Disconnected) => break true,
                }
            };

            for (target, paths) in changed.into_values() {
                invalidate_editor_file_discovery(&target.root);
                sink(EditorFileWatchEvent::Changed {
                    subscription_id: subscription_id.clone(),
                    project_id: project_id.clone(),
                    resource_id: target.resource_id,
                    paths: paths.into_iter().collect(),
                });
            }
            for failure in failures {
                sink(EditorFileWatchEvent::Failed {
                    subscription_id: subscription_id.clone(),
                    project_id: project_id.clone(),
                    message: failure,
                });
            }
            if disconnected {
                break;
            }
        }
    });
}

fn merge_watch_result(
    result: notify::Result<Event>,
    targets: &[WatchTarget],
    changed: &mut BTreeMap<String, (WatchTarget, BTreeSet<String>)>,
    failures: &mut BTreeSet<String>,
) {
    match result {
        Ok(event) => {
            for (target, paths) in changed_paths_by_resource(targets, &event.paths) {
                let pending = &mut changed
                    .entry(target.resource_id.clone())
                    .or_insert_with(|| (target, BTreeSet::new()))
                    .1;
                if pending.contains("") {
                    continue;
                }
                pending.extend(paths);
                if pending.len() > MAX_CHANGED_PATHS_PER_RESOURCE {
                    pending.clear();
                    pending.insert(String::new());
                }
            }
        }
        Err(error) => {
            failures.insert(format!("editor file watch failed: {error}"));
        }
    }
}

fn resolve_targets<B>(
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
                root: target.root,
            })
        })
        .collect()
}

fn changed_paths_by_resource(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_paths_are_relative_grouped_and_deduplicated() {
        let targets = vec![
            WatchTarget {
                resource_id: "resource:one".to_owned(),
                root: PathBuf::from("/workspace/one"),
            },
            WatchTarget {
                resource_id: "resource:two".to_owned(),
                root: PathBuf::from("/workspace/two"),
            },
        ];
        let changed = changed_paths_by_resource(
            &targets,
            &[
                PathBuf::from("/workspace/one/src/lib.rs"),
                PathBuf::from("/workspace/one/src/lib.rs"),
                PathBuf::from("/workspace/two/README.md"),
                PathBuf::from("/workspace/one/target/generated.rs"),
                PathBuf::from("/outside/ignored.txt"),
            ],
        );

        assert_eq!(changed.len(), 2);
        assert_eq!(changed[0].0.resource_id, "resource:one");
        assert_eq!(changed[0].1, vec!["src/lib.rs"]);
        assert_eq!(changed[1].0.resource_id, "resource:two");
        assert_eq!(changed[1].1, vec!["README.md"]);
    }
}
