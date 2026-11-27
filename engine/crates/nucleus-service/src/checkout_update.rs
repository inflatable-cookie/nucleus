//! Keep each registered checkout's local base current after a task's merge
//! (Spec 070 ruling 61). This is housekeeping beside closeout: one attempt per
//! merge, and the next merge catches up after a failure or a restart.

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{Head, Identity};
use nucleus_store::StorageError;
use nucleus_work::WorkError;
use tokio::sync::{Mutex, mpsc};

use crate::{Service, ServiceError, event, volume::Limit};

pub(crate) struct Merges {
    landed: mpsc::UnboundedSender<(Identity, Head)>,
    /// One consumer, so updates never overlap and run in the order they landed.
    due: Mutex<mpsc::UnboundedReceiver<(Identity, Head)>>,
    /// Held for each fetch into a registered repository.
    pub(crate) fetching: Mutex<()>,
}

impl Default for Merges {
    fn default() -> Self {
        let (landed, due) = mpsc::unbounded_channel();
        Self {
            landed,
            due: Mutex::new(due),
            fetching: Mutex::default(),
        }
    }
}

impl Merges {
    pub(crate) fn landed(&self, task: Identity, commit: Head) {
        // The receiver lives as long as this sender.
        let _ = self.landed.send((task, commit));
    }
}

#[cfg(test)]
impl Merges {
    pub(crate) async fn due_for_test(&self) -> Vec<(Identity, Head)> {
        let mut due = self.due.lock().await;
        std::iter::from_fn(|| due.try_recv().ok()).collect()
    }
}

impl Service {
    pub(crate) async fn watch_merges(&self) {
        let mut due = self.merges.due.lock().await;
        while let Some((task, commit)) = due.recv().await {
            self.keep_current(&task, commit).await;
        }
    }

    /// Attempt every queued update, as the watcher would.
    #[cfg(test)]
    pub(crate) async fn apply_merges(&self) {
        for (task, commit) in self.merges.due_for_test().await {
            self.keep_current(&task, commit).await;
        }
    }

    async fn keep_current(&self, task: &Identity, commit: Head) {
        let Err(error) = self.update_registered(task, commit.clone()).await else {
            return;
        };
        let reason = match error {
            ServiceError::Workspace(WorkError::Storage(StorageError::CallHeld {
                step, ..
            })) => {
                format!("{step} has not returned, so its outcome is unknown")
            }
            error => error.to_string(),
        };
        let mut audit = event("checkout_not_updated");
        audit.detail = serde_json::json!({ "commit": commit, "reason": reason }).to_string();
        let recorded = self
            .state
            .lock()
            .await
            .store
            .record_task_effect(&task.id, &audit);
        if let Err(error) = recorded {
            service_log!("{}: checkout_not_updated: {error}", task.id);
        }
    }

    async fn update_registered(&self, task: &Identity, commit: Head) -> Result<(), ServiceError> {
        let route = self.project_for(task).await?;
        let worktrees = self.worktrees();
        let checkout = worktrees.registered(&route.checkout, &task.repository, &task.id)?;
        let base = task.base.clone();
        let published = self
            .fetch_registered(&checkout, move |checkout| checkout.fetch_base(&base))
            .await?;
        let base = task.base.clone();
        let update = checkout.job(
            self.git.clone(),
            Redactor::new([], RedactionRules::common()),
            move |checkout| checkout.fast_forward(&base, &published, &commit),
        );
        // Its own owner: an update still running holds back later updates here,
        // never a task's start or closeout.
        let owner = format!("registered {}", route.checkout.display());
        let step = "updating the registered checkout";
        self.volume
            .run(&owner, step, Limit::Change, update)
            .await
            .map_err(WorkError::from)??;
        Ok(())
    }
}
