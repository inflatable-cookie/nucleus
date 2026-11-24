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
    Binding, HostError, RegisteredProject, T3,
    inbox::{self, INBOX_THREAD, InboxTarget},
    parent_thread,
    rpc::{Read, Reply},
    task_row::{RowVisibility, ThreadVisibility},
};

#[derive(Default)]
pub(crate) struct TitleShell {
    view: RwLock<Option<Shell>>,
    pub(crate) changed: Notify,
}

#[derive(Default)]
pub(crate) struct Shell {
    projects: BTreeMap<String, Project>,
    threads: BTreeMap<String, TitleThread>,
}

#[derive(PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    workspace_root: String,
    title: Option<String>,
    archived_at: Option<String>,
    deleted_at: Option<String>,
}

#[derive(PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleThread {
    id: String,
    project_id: String,
    provider_instance_id: String,
    worktree_path: Option<String>,
    branch: Option<String>,
    title: Option<String>,
    pinned_at: Option<String>,
    #[serde(flatten)]
    visibility: ThreadVisibility,
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
    binding: Option<Binding>,
    current_title: Option<String>,
    thread: String,
    provider: String,
    root: String,
    visibility: ThreadVisibility,
}

impl TitleTarget {
    #[must_use]
    pub const fn binding(&self) -> Option<&Binding> {
        self.binding.as_ref()
    }

    #[must_use]
    pub fn current_title(&self) -> Option<&str> {
        self.current_title.as_deref()
    }

    #[must_use]
    pub fn thread(&self) -> &str {
        &self.thread
    }

    pub(crate) fn matches_current_visibility(&self, host: &T3) -> bool {
        self.binding.as_ref().is_some_and(|binding| {
            host.title_target(binding, &self.provider, &self.root)
                .is_some_and(|current| current.visibility == self.visibility)
        })
    }
}

impl Shell {
    pub(crate) fn read(snapshot: &Value, provider: &str) -> Option<Self> {
        let mut view = Self::default();
        let mut project_ids = BTreeSet::new();
        for item in snapshot["projects"].as_array()? {
            let id = item["id"].as_str()?;
            if !project_ids.insert(id) {
                return None;
            }
            if let Ok(project) = serde_json::from_value(item.clone()) {
                view.projects.insert(id.into(), project);
            }
        }
        let mut seen = BTreeSet::new();
        for thread in snapshot["threads"].as_array()? {
            if !seen.insert(thread["id"].as_str()?) {
                return None;
            }
            view.update_thread(thread, provider);
        }
        Some(view)
    }

    fn update_thread(&mut self, thread: &Value, provider: &str) -> bool {
        let Some(id) = thread["id"].as_str() else {
            return false;
        };
        let parent = (thread["providerInstanceId"] == provider)
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

    pub(crate) fn update(&mut self, item: &Value, provider: &str) -> bool {
        match item["kind"].as_str() {
            Some("thread.updated") => self.update_thread(&item["thread"], provider),
            Some("thread.removed") => item["threadId"]
                .as_str()
                .is_some_and(|id| self.threads.remove(id).is_some()),
            Some("project.updated") => {
                let Some(id) = item["project"]["id"].as_str() else {
                    return false;
                };
                match serde_json::from_value(item["project"].clone()) {
                    Ok(project) if self.projects.get(id) != Some(&project) => {
                        self.projects.insert(id.into(), project);
                        true
                    }
                    Ok(_) => false,
                    Err(_) => self.projects.remove(id).is_some(),
                }
            }
            Some("project.removed") => item["projectId"]
                .as_str()
                .is_some_and(|id| self.projects.remove(id).is_some()),
            _ => false,
        }
    }

    fn active_project(&self, id: &str) -> Option<&Project> {
        self.projects
            .get(id)
            .filter(|project| project.archived_at.is_none() && project.deleted_at.is_none())
    }
}

impl TitleShell {
    pub(crate) fn replace(&self, shell: Option<Shell>) {
        if let Ok(mut view) = self.view.write() {
            *view = shell;
            self.changed.notify_one();
        }
    }

    pub(crate) fn update(&self, item: &Value, provider: &str) {
        if let Ok(mut lock) = self.view.write()
            && let Some(view) = lock.as_mut()
            && view.update(item, provider)
        {
            self.changed.notify_one();
        }
    }

    fn cached_project(&self, id: &str) -> Result<RegisteredProject, HostError> {
        let view = self.view.read().map_err(|_| HostError::Uncertain)?;
        let project = view
            .as_ref()
            .ok_or(HostError::Uncertain)?
            .active_project(id)
            .filter(|project| !project.workspace_root.is_empty())
            .ok_or(HostError::Binding)?;
        Ok(RegisteredProject {
            root: project.workspace_root.clone(),
            title: project.title.clone(),
        })
    }

    fn projects_synchronized(&self) -> bool {
        self.view.read().is_ok_and(|view| view.is_some())
    }

    fn threads(&self) -> Vec<String> {
        let Ok(view) = self.view.read() else {
            return Vec::new();
        };
        let Some(shell) = view.as_ref() else {
            return Vec::new();
        };
        shell
            .threads
            .values()
            .filter(|parent| {
                parent.archived_at.is_none()
                    && parent.deleted_at.is_none()
                    && shell.active_project(&parent.project_id).is_some()
            })
            .map(|parent| parent.id.clone())
            .collect()
    }

    fn target(&self, binding: &Binding, provider: &str, root: &str) -> Option<TitleTarget> {
        let view = self.view.read().ok()?;
        let shell = view.as_ref()?;
        let project = shell.active_project(&binding.project_id)?;
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let parent = shell.threads.get(&thread)?;
        if project.workspace_root != root
            || parent.project_id != project.id
            || parent.provider_instance_id != provider
            || parent.worktree_path.as_deref() != Some(&binding.worktree_path)
            || parent.branch.as_deref() != Some(&binding.branch)
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
            binding: Some(binding.clone()),
            current_title: parent.title.clone(),
            thread,
            provider: provider.into(),
            root: root.into(),
            visibility: parent.visibility.clone(),
        })
    }

    fn inbox_target(&self, target: &InboxTarget<'_>) -> Option<TitleTarget> {
        let view = self.view.read().ok()?;
        let shell = view.as_ref()?;
        let project = shell.active_project(inbox::PROJECT)?;
        let thread = shell.threads.get(INBOX_THREAD)?;
        if project.workspace_root != target.root
            || thread.project_id != project.id
            || thread.provider_instance_id != target.provider
            || thread.worktree_path.is_some()
            || thread.parent_thread_id.is_some()
            || thread
                .lineage
                .as_ref()
                .is_some_and(|lineage| lineage.parent_thread_id.is_some())
            || thread.archived_at.is_some()
            || thread.deleted_at.is_some()
            || thread.pinned_at.as_deref().is_none_or(str::is_empty)
            || thread.title.is_none()
        {
            return None;
        }
        Some(TitleTarget {
            binding: None,
            current_title: thread.title.clone(),
            thread: thread.id.clone(),
            provider: target.provider.into(),
            root: target.root.into(),
            visibility: thread.visibility.clone(),
        })
    }
}

impl T3 {
    #[cfg(feature = "loopback-fixture")]
    #[doc(hidden)]
    pub fn fixture_project_shell(&self, snapshot: &Value, provider: &str) {
        self.titles.replace(Shell::read(snapshot, provider));
    }

    /// Whether the shared T3 shell has supplied a complete project snapshot.
    #[must_use]
    pub fn projects_synchronized(&self) -> bool {
        self.titles.projects_synchronized()
    }

    /// Read an active project from the synchronized shell without contacting T3.
    ///
    /// # Errors
    /// Returns an error for an unknown snapshot or an inactive project.
    pub fn cached_project(&self, id: &str) -> Result<RegisteredProject, HostError> {
        self.titles.cached_project(id)
    }

    /// Scope title effects to parents visible on the existing shell stream.
    #[must_use]
    pub fn title_threads(&self) -> Vec<String> {
        self.titles.threads()
    }

    pub async fn title_shell_changed(&self) {
        self.titles.changed.notified().await;
    }

    /// Local visibility hints for the presentation scheduler. Mutations use an exact thread read.
    #[must_use]
    pub fn row_visibility_hint(&self, thread: &str) -> Option<RowVisibility> {
        let lock = self.titles.view.read().ok()?;
        let shell = lock.as_ref()?;
        let parent = shell.threads.get(thread)?;
        if parent.archived_at.is_some() || parent.deleted_at.is_some() {
            return None;
        }
        parent.visibility.read().ok()
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

    /// Prepare a title update for the verified pinned Inbox on the cached shell.
    #[must_use]
    pub fn inbox_title_target(&self, target: &InboxTarget<'_>) -> Option<TitleTarget> {
        self.titles.inbox_target(target)
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
        if target.current_title() == Some(title) {
            return Ok(());
        }
        let payload = json!({
            "type": "thread.metadata.update",
            "commandId": command_id,
            "threadId": target.thread,
            "title": title,
        });
        match self
            .rpc
            .call_guarded("orchestration.dispatchCommand", payload, Read::One, || {
                let current = match &target.binding {
                    Some(binding) => self.titles.target(binding, &target.provider, &target.root),
                    None => self.titles.inbox_target(&InboxTarget {
                        provider: &target.provider,
                        root: &target.root,
                    }),
                };
                current
                    .map(|current| current.current_title() != Some(title))
                    .ok_or(HostError::Binding)
            })
            .await?
        {
            Reply::Value(_) => Ok(()),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }
}
