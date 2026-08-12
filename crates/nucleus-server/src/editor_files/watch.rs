//! Editor file watch: native and SCM metadata watchers with debounced
//! change forwarding.
//!
//! Module index over the watch surface: the runtime and event types, event
//! forwarding, SCM classification, and target resolution.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Config, PollWatcher, RecursiveMode, Watcher};
use nucleus_local_store::LocalStoreBackend;
use serde::{Deserialize, Serialize};

use crate::ServerStateService;

mod forwarder;
mod scm;
mod targets;
#[cfg(test)]
mod tests;

use forwarder::spawn_event_forwarder;
use targets::resolve_targets;

const WATCH_DEBOUNCE: Duration = Duration::from_millis(120);
const SCM_POLL_INTERVAL: Duration = Duration::from_millis(750);
const MAX_CHANGED_PATHS_PER_RESOURCE: usize = 256;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
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

struct EditorFileWatchRuntimeInner {
    next_subscription: AtomicU64,
    subscriptions: Mutex<BTreeMap<String, EditorFileWatchSubscription>>,
}

impl Default for EditorFileWatchRuntimeInner {
    fn default() -> Self {
        Self {
            next_subscription: AtomicU64::new(1),
            subscriptions: Mutex::new(BTreeMap::new()),
        }
    }
}

struct EditorFileWatchSubscription {
    _file_watcher: notify::RecommendedWatcher,
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
