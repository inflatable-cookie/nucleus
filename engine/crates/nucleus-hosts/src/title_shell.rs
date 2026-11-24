//! Presentation proof from the existing synchronized T3 shell subscription.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::RwLock,
};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::{
    Binding, HostError, T3, parent_thread,
    rpc::{Read, Reply},
};

#[derive(Default)]
pub(crate) struct TitleShell {
    view: RwLock<Option<Shell>>,
    pub(crate) changed: Notify,
}

#[derive(Default)]
pub(crate) struct Shell {
    project: Option<Project>,
    threads: BTreeMap<String, TitleThread>,
}

#[derive(PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    workspace_root: String,
    archived_at: Option<String>,
    deleted_at: Option<String>,
}

#[derive(PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleThread {
    id: String,
    project_id: String,
    provider_instance_id: String,
    worktree_path: String,
    branch: String,
    parent_thread_id: Option<String>,
    lineage: Option<Lineage>,
    archived_at: Option<String>,
    deleted_at: Option<String>,
}

#[derive(PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lineage {
    parent_thread_id: Option<String>,
}

/// The matching parent record from T3's synchronized shell.
pub struct TitleTarget {
    binding: Binding,
    thread: String,
    provider: String,
    root: String,
}

impl TitleTarget {
    #[must_use]
    pub const fn binding(&self) -> &Binding {
        &self.binding
    }

    #[must_use]
    pub fn thread(&self) -> &str {
        &self.thread
    }
}

impl Shell {
    pub(crate) fn read(snapshot: &Value, project: &str, provider: &str) -> Option<Self> {
        let projects = snapshot["projects"].as_array()?;
        let mut matching = projects.iter().filter(|item| item["id"] == project);
        let item = matching.next();
        if matching.next().is_some() {
            return None;
        }
        let mut view = Self {
            project: item.and_then(|item| serde_json::from_value(item.clone()).ok()),
            ..Self::default()
        };
        let mut seen = BTreeSet::new();
        for thread in snapshot["threads"].as_array()? {
            if !seen.insert(thread["id"].as_str()?) {
                return None;
            }
            view.update_thread(thread, project, provider);
        }
        Some(view)
    }

    fn update_thread(&mut self, thread: &Value, project: &str, provider: &str) -> bool {
        let Some(id) = thread["id"].as_str() else {
            return false;
        };
        let parent = (thread["projectId"] == project && thread["providerInstanceId"] == provider)
            .then(|| serde_json::from_value::<TitleThread>(thread.clone()).ok())
            .flatten();
        match parent {
            Some(parent) if self.threads.get(id) != Some(&parent) => {
                self.threads.insert(id.to_owned(), parent);
                true
            }
            Some(_) => false,
            None => self.threads.remove(id).is_some(),
        }
    }

    pub(crate) fn update(&mut self, item: &Value, project: &str, provider: &str) -> bool {
        match item["kind"].as_str() {
            Some("thread.updated") => self.update_thread(&item["thread"], project, provider),
            Some("thread.removed") => item["threadId"]
                .as_str()
                .is_some_and(|id| self.threads.remove(id).is_some()),
            Some("project.updated") if item["project"]["id"] == project => {
                let next = serde_json::from_value(item["project"].clone()).ok();
                if self.project == next {
                    return false;
                }
                self.project = next;
                true
            }
            Some("project.removed") if item["projectId"] == project => {
                self.project.take().is_some()
            }
            _ => false,
        }
    }

    fn project_at(&self, root: &str) -> Option<&Project> {
        self.project.as_ref().filter(|project| {
            project.workspace_root == root
                && project.archived_at.is_none()
                && project.deleted_at.is_none()
        })
    }
}

impl TitleShell {
    pub(crate) fn replace(&self, shell: Option<Shell>) {
        if let Ok(mut view) = self.view.write() {
            *view = shell;
            self.changed.notify_one();
        }
    }

    pub(crate) fn update(&self, item: &Value, project: &str, provider: &str) {
        if let Ok(mut lock) = self.view.write()
            && let Some(view) = lock.as_mut()
            && view.update(item, project, provider)
        {
            self.changed.notify_one();
        }
    }

    fn threads(&self, root: &str) -> Vec<String> {
        let Ok(view) = self.view.read() else {
            return Vec::new();
        };
        let Some(shell) = view
            .as_ref()
            .filter(|shell| shell.project_at(root).is_some())
        else {
            return Vec::new();
        };
        shell
            .threads
            .values()
            .filter(|parent| parent.archived_at.is_none() && parent.deleted_at.is_none())
            .map(|parent| parent.id.clone())
            .collect()
    }

    fn target(&self, binding: &Binding, provider: &str, root: &str) -> Option<TitleTarget> {
        let view = self.view.read().ok()?;
        let shell = view.as_ref()?;
        let project = shell.project_at(root)?;
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let parent = shell.threads.get(&thread)?;
        if project.id != binding.project_id
            || parent.project_id != project.id
            || parent.provider_instance_id != provider
            || parent.worktree_path != binding.worktree_path
            || parent.branch != binding.branch
            || parent.parent_thread_id.is_some()
            || parent
                .lineage
                .as_ref()
                .is_some_and(|lineage| lineage.parent_thread_id.is_some())
            || parent.archived_at.is_some()
            || parent.deleted_at.is_some()
        {
            return None;
        }
        Some(TitleTarget {
            binding: binding.clone(),
            thread,
            provider: provider.into(),
            root: root.into(),
        })
    }
}

impl T3 {
    /// Scope title effects to parents visible on the existing shell stream.
    #[must_use]
    pub fn title_threads(&self, root: &str) -> Vec<String> {
        self.titles.threads(root)
    }

    pub async fn title_shell_changed(&self) {
        self.titles.changed.notified().await;
    }

    /// Prepare a title write with positive local shell proof of its destination.
    #[must_use]
    pub fn title_target(
        &self,
        binding: &Binding,
        provider: &str,
        root: &str,
    ) -> Option<TitleTarget> {
        self.titles.target(binding, provider, root)
    }

    /// Deliver the same title bytes under the receipt ID until T3 confirms it.
    /// # Errors
    /// Returns an error if the proof changes or the write cannot be confirmed.
    pub async fn write_title(
        &self,
        target: TitleTarget,
        command_id: &str,
        title: &str,
    ) -> Result<(), HostError> {
        let payload = json!({
            "type": "thread.metadata.update",
            "commandId": command_id,
            "threadId": target.thread,
            "title": title,
        });
        match self
            .rpc
            .call_guarded("orchestration.dispatchCommand", payload, Read::One, || {
                self.titles
                    .target(&target.binding, &target.provider, &target.root)
                    .map(|_| ())
                    .ok_or(HostError::Binding)
            })
            .await?
        {
            Reply::Value(_) => Ok(()),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }
}
