//! Editor file watch event forwarding: debounced merging and sink dispatch.
//!
//! Split from the watch god file; behavior unchanged.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::thread;

use notify::Event;

use super::scm::scm_changed_targets;
use super::targets::changed_paths_by_resource;
use super::{EditorFileWatchEvent, EditorFileWatchEventSink, WatchTarget, MAX_CHANGED_PATHS_PER_RESOURCE, WATCH_DEBOUNCE};
use crate::editor_files::discovery::invalidate_editor_file_discovery;

pub(super) fn spawn_event_forwarder(
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
