use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use notify::{Config, Event, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use nucleus_local_store::LocalStoreBackend;
use serde::{Deserialize, Serialize};

use crate::project_file_policy::admitted_project_watch_path;
use crate::project_resource_target::resolve_project_resource_target;
use crate::ServerStateService;

use super::invalidate_editor_file_discovery;

const WATCH_DEBOUNCE: Duration = Duration::from_millis(120);
const SCM_POLL_INTERVAL: Duration = Duration::from_millis(750);
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
    ScmChanged {
        subscription_id: String,
        project_id: String,
        resource_id: String,
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
    subscriptions: Mutex<HashMap<String, EditorFileWatchSubscription>>,
}

struct EditorFileWatchSubscription {
    _file_watcher: RecommendedWatcher,
    _scm_watcher: Option<PollWatcher>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct WatchTarget {
    resource_id: String,
    root: PathBuf,
    scm_roots: Vec<PathBuf>,
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
        let mut watcher = notify::recommended_watcher(event_sender.clone())
            .map_err(|error| format!("editor file watch setup failed: {error}"))?;
        let mut scm_watcher = targets
            .iter()
            .any(|target| !target.scm_roots.is_empty())
            .then(|| {
                PollWatcher::new(
                    event_sender,
                    Config::default().with_poll_interval(SCM_POLL_INTERVAL),
                )
                .map_err(|error| format!("SCM metadata watch setup failed: {error}"))
            })
            .transpose()?;

        for target in &targets {
            watcher
                .watch(&target.root, RecursiveMode::Recursive)
                .map_err(|error| {
                    format!(
                        "editor file watch failed for {}: {error}",
                        target.resource_id
                    )
                })?;
            if let Some(scm_watcher) = scm_watcher.as_mut() {
                for scm_root in &target.scm_roots {
                    scm_watcher
                        .watch(scm_root, RecursiveMode::NonRecursive)
                        .map_err(|error| {
                            format!(
                                "SCM metadata watch failed for {}: {error}",
                                target.resource_id
                            )
                        })?;
                    let refs = scm_root.join("refs");
                    if refs.is_dir() {
                        scm_watcher
                            .watch(&refs, RecursiveMode::Recursive)
                            .map_err(|error| {
                                format!("SCM refs watch failed for {}: {error}", target.resource_id)
                            })?;
                    }
                }
            }
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
            .insert(
                subscription_id.clone(),
                EditorFileWatchSubscription {
                    _file_watcher: watcher,
                    _scm_watcher: scm_watcher,
                },
            );
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
            let mut scm_changed = BTreeMap::<String, WatchTarget>::new();
            let mut failures = BTreeSet::new();
            merge_watch_result(
                first,
                &targets,
                &mut changed,
                &mut scm_changed,
                &mut failures,
            );
            let disconnected = loop {
                match receiver.recv_timeout(WATCH_DEBOUNCE) {
                    Ok(result) => merge_watch_result(
                        result,
                        &targets,
                        &mut changed,
                        &mut scm_changed,
                        &mut failures,
                    ),
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
            for target in scm_changed.into_values() {
                sink(EditorFileWatchEvent::ScmChanged {
                    subscription_id: subscription_id.clone(),
                    project_id: project_id.clone(),
                    resource_id: target.resource_id,
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
    scm_changed: &mut BTreeMap<String, WatchTarget>,
    failures: &mut BTreeSet<String>,
) {
    match result {
        Ok(event) => {
            for target in scm_changed_targets(targets, &event.paths) {
                scm_changed.insert(target.resource_id.clone(), target);
            }
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

fn scm_changed_targets(targets: &[WatchTarget], event_paths: &[PathBuf]) -> Vec<WatchTarget> {
    targets
        .iter()
        .filter(|target| {
            event_paths.iter().any(|path| {
                target
                    .scm_roots
                    .iter()
                    .any(|scm_root| path.starts_with(scm_root))
                    || path
                        .strip_prefix(&target.root)
                        .is_ok_and(|relative| relative.starts_with(".git"))
            })
        })
        .cloned()
        .collect()
}

fn resolve_scm_roots(root: &Path) -> Vec<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--absolute-git-dir"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .current_dir(root)
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() || output.stdout.len() > 4096 {
        return Vec::new();
    }

    let Ok(path) = String::from_utf8(output.stdout) else {
        return Vec::new();
    };
    let git_dir = PathBuf::from(path.trim());
    if git_dir.as_os_str().is_empty() {
        return Vec::new();
    }
    let git_dir = std::fs::canonicalize(&git_dir).unwrap_or(git_dir);

    let mut roots = vec![git_dir.clone()];
    if let Ok(common_dir) = std::fs::read_to_string(git_dir.join("commondir")) {
        let common_dir = common_dir.trim();
        if !common_dir.is_empty() {
            let common_dir = PathBuf::from(common_dir);
            let common_dir = if common_dir.is_absolute() {
                common_dir
            } else {
                git_dir.join(common_dir)
            };
            let common_dir = std::fs::canonicalize(&common_dir).unwrap_or(common_dir);
            if common_dir != git_dir {
                roots.push(common_dir);
            }
        }
    }
    roots
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
                scm_roots: resolve_scm_roots(&target.root),
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
                scm_roots: vec![PathBuf::from("/workspace/one/.git")],
            },
            WatchTarget {
                resource_id: "resource:two".to_owned(),
                root: PathBuf::from("/workspace/two"),
                scm_roots: vec![PathBuf::from("/workspace/two/.git")],
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

    #[test]
    fn root_git_metadata_changes_are_classified_separately() {
        let targets = vec![
            WatchTarget {
                resource_id: "resource:one".to_owned(),
                root: PathBuf::from("/workspace/one"),
                scm_roots: vec![PathBuf::from("/workspace/one/.git")],
            },
            WatchTarget {
                resource_id: "resource:two".to_owned(),
                root: PathBuf::from("/workspace/two"),
                scm_roots: vec![PathBuf::from("/workspace/two/.git")],
            },
        ];

        let changed = scm_changed_targets(
            &targets,
            &[
                PathBuf::from("/workspace/one/.git/index"),
                PathBuf::from("/workspace/one/.git/refs/heads/main"),
                PathBuf::from("/workspace/two/src/lib.rs"),
                PathBuf::from("/workspace/two/vendor/dependency/.git/index"),
            ],
        );

        assert_eq!(
            changed
                .into_iter()
                .map(|target| target.resource_id)
                .collect::<Vec<_>>(),
            vec!["resource:one"]
        );
    }

    #[test]
    fn native_watcher_emits_scm_change_for_an_atomic_index_replacement() {
        let root = tempfile::tempdir().expect("resource root");
        let git_dir = root.path().join(".git");
        std::fs::create_dir_all(&git_dir).expect("git directory");
        std::fs::write(git_dir.join("index"), b"before").expect("initial index");

        let (native_sender, native_receiver) = mpsc::channel();
        let mut watcher = PollWatcher::new(
            native_sender,
            Config::default().with_poll_interval(Duration::from_millis(100)),
        )
        .expect("SCM metadata watcher");
        watcher
            .watch(&git_dir, RecursiveMode::NonRecursive)
            .expect("watch SCM metadata root");

        let (sink_sender, sink_receiver) = mpsc::channel();
        spawn_event_forwarder(
            native_receiver,
            vec![WatchTarget {
                resource_id: "resource:test".to_owned(),
                root: root.path().to_path_buf(),
                scm_roots: vec![git_dir.clone()],
            }],
            "subscription:test".to_owned(),
            "project:test".to_owned(),
            Arc::new(move |event| {
                let _ = sink_sender.send(event);
            }),
        );

        // PollWatcher records whole-second mtimes, so cross the timestamp boundary before
        // replacing Git's index to exercise the same long-lived subscription used by the app.
        std::thread::sleep(Duration::from_millis(1_200));
        std::fs::write(git_dir.join("index.lock"), b"after").expect("replacement index");
        std::fs::rename(git_dir.join("index.lock"), git_dir.join("index"))
            .expect("atomic index replacement");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let event = sink_receiver
                .recv_timeout(remaining)
                .expect("SCM change event");
            if matches!(
                event,
                EditorFileWatchEvent::ScmChanged {
                    ref project_id,
                    ref resource_id,
                    ..
                } if project_id == "project:test" && resource_id == "resource:test"
            ) {
                break;
            }
        }

        drop(watcher);
    }
}
