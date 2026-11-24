//! Presentation proof from the synchronized T3 shell subscription.

use std::{path::Path, sync::Arc};

use serde_json::{Value, json};

use crate::{
    Binding, HostError, RegisteredProject, T3,
    inbox::{INBOX_THREAD, InboxTarget, PROJECT},
    parent_thread,
    rpc::{Read, Reply, closed_row},
    task_row::{RowVisibility, visibility},
    thread_snapshots::ThreadSnapshots,
};

/// The matching parent record from T3's synchronized shell.
pub struct TitleTarget {
    binding: Option<Binding>,
    id: String,
    row: Arc<Value>,
    root: String,
}

impl TitleTarget {
    #[must_use]
    pub const fn binding(&self) -> Option<&Binding> {
        self.binding.as_ref()
    }

    #[must_use]
    pub fn current_title(&self) -> Option<&str> {
        self.row["title"].as_str()
    }

    #[must_use]
    pub fn thread(&self) -> &str {
        &self.id
    }

    pub(crate) const fn marker(&self) -> &Arc<Value> {
        &self.row
    }

    /// Read the captured visibility of this bound shell row.
    ///
    /// # Errors
    /// Returns an error for an invalid native timestamp.
    pub fn visibility(&self) -> Result<RowVisibility, HostError> {
        visibility(&self.row)
    }

    pub(crate) fn row_in(&self, shell: &ThreadSnapshots) -> Option<Arc<Value>> {
        let project = self
            .binding
            .as_ref()
            .map_or(PROJECT, |binding| binding.project_id.as_str());
        presentation_row(
            shell,
            self.thread(),
            project,
            self.row["providerInstanceId"].as_str()?,
            &self.root,
            self.binding.as_ref(),
        )
    }
}

fn presentation_row(
    shell: &ThreadSnapshots,
    id: &str,
    project: &str,
    provider: &str,
    root: &str,
    binding: Option<&Binding>,
) -> Option<Arc<Value>> {
    let row = shell.marker(id)?;
    if shell.project(project)?.root != root
        || row["projectId"] != project
        || row["providerInstanceId"] != provider
        || closed_row(&row)
        || !row["parentThreadId"].is_null()
        || !row["lineage"]["parentThreadId"].is_null()
    {
        return None;
    }
    match binding {
        Some(binding)
            if row["worktreePath"] == binding.worktree_path.as_str()
                && row["branch"] == binding.branch.as_str() =>
        {
            Some(row)
        }
        None if row["worktreePath"].is_null()
            && row["title"].is_string()
            && row["pinnedAt"].as_str().is_some_and(|at| !at.is_empty()) =>
        {
            Some(row)
        }
        _ => None,
    }
}

impl T3 {
    #[cfg(feature = "loopback-fixture")]
    #[doc(hidden)]
    pub fn fixture_project_shell(&self, snapshot: &Value, _provider: &str) {
        self.rpc
            .fixture_shell(&json!({"kind":"snapshot","snapshot":snapshot}));
    }

    #[cfg(feature = "loopback-fixture")]
    #[doc(hidden)]
    pub fn fixture_shell_delta(&self, item: &Value) {
        self.rpc.fixture_shell(item);
    }

    /// Whether the shared T3 shell has supplied a complete project snapshot.
    #[must_use]
    pub fn projects_synchronized(&self) -> bool {
        self.rpc.with_shell(|shell| shell.is_some())
    }

    /// Read an active project from the synchronized shell.
    ///
    /// # Errors
    /// Returns an error for an unknown snapshot or an inactive project.
    pub fn cached_project(&self, id: &str) -> Result<RegisteredProject, HostError> {
        self.rpc.with_shell(|shell| {
            shell
                .ok_or(HostError::Uncertain)?
                .project(id)
                .ok_or(HostError::Binding)
        })
    }

    /// Scope title effects to parents visible on the existing shell stream.
    #[must_use]
    pub fn title_threads(&self, provider: &str) -> Vec<String> {
        self.rpc
            .with_shell(|shell| shell.map_or_else(Vec::new, |view| view.title_threads(provider)))
    }

    pub async fn title_shell_changed(&self) {
        self.rpc.shell_changed.notified().await;
    }

    /// Current visibility from the synchronized shell.
    #[must_use]
    pub fn row_visibility_hint(&self, thread: &str) -> Option<RowVisibility> {
        let row = self.rpc.thread_row(thread)?;
        (!closed_row(&row)).then(|| visibility(&row).ok()).flatten()
    }

    /// Prepare a title write with positive local proof of its destination.
    #[must_use]
    pub fn title_target(
        &self,
        binding: &Binding,
        provider: &str,
        root: &str,
    ) -> Option<TitleTarget> {
        self.presentation_target(
            &parent_thread(Path::new(&binding.worktree_path)),
            &binding.project_id,
            provider,
            root,
            Some(binding),
        )
    }

    /// Prepare a title update for the verified pinned Inbox.
    #[must_use]
    pub fn inbox_title_target(&self, target: &InboxTarget<'_>) -> Option<TitleTarget> {
        self.presentation_target(INBOX_THREAD, PROJECT, target.provider, target.root, None)
    }

    fn presentation_target(
        &self,
        id: &str,
        project: &str,
        provider: &str,
        root: &str,
        binding: Option<&Binding>,
    ) -> Option<TitleTarget> {
        self.rpc.with_shell(|shell| {
            let row = presentation_row(shell?, id, project, provider, root, binding)?;
            Some(TitleTarget {
                binding: binding.cloned(),
                id: id.into(),
                row,
                root: root.into(),
            })
        })
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
        let payload = json!({"type":"thread.metadata.update","commandId":command_id,"threadId":target.thread(),"title":title});
        match self
            .rpc
            .call_guarded(
                "orchestration.dispatchCommand",
                payload,
                Read::Background,
                || {
                    self.rpc.with_shell(|shell| {
                        shell
                            .and_then(|shell| target.row_in(shell))
                            .map(|row| row["title"] != title)
                            .ok_or(HostError::Binding)
                    })
                },
            )
            .await?
        {
            Reply::Value(_) => Ok(()),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }
}
