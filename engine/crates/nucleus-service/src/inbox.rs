use std::time::Duration;

use nucleus_core::{Action, Answer, Authority, Command, WaitReason};
use nucleus_store::TaskRow;
use tokio::time::Instant;

use crate::{Preflight, Service, ServiceError, event};

#[cfg(test)]
mod tests;

const RESTORED_BINDING_RECHECK: Duration = Duration::from_secs(15);

pub(super) fn reference(row: &TaskRow) -> String {
    row.task
        .identity()
        .reference
        .trim()
        .chars()
        .take(120)
        .collect()
}

impl Service {
    pub(super) const fn uses_operator_inbox(&self) -> bool {
        self.native_inbox.is_some()
    }

    /// Configure the optional native Inbox from the environment.
    /// # Errors
    /// Returns an error if the flag, provider or native Inbox binding is invalid.
    pub fn with_inbox_from_env(mut self) -> Result<Self, ServiceError> {
        self.native_inbox = crate::native_inbox::NativeInbox::configured(&self)?;
        Ok(self)
    }

    pub(super) async fn operator_decision(&self, row: &TaskRow) -> Result<Action, ServiceError> {
        if row.task.operator_question().is_none() || !self.uses_operator_inbox() {
            return Ok(Action::Wait(WaitReason::Question));
        }
        let _fence = self.effect(row).await?;
        let id = &row.task.identity().id;
        // An old profile may hold a decision that the TypeScript bridge already offered.
        if self.state.lock().await.store.inbox_binding(id)?.is_some() {
            return Err(ServiceError::InboxUnavailable {
                until: Instant::now() + RESTORED_BINDING_RECHECK,
            });
        }
        self.native_task_decision(row).await
    }

    pub(super) async fn apply_operator_answer(
        &self,
        row: &TaskRow,
        actor: String,
        reason: String,
        declined: bool,
    ) -> Result<Action, ServiceError> {
        let waiting = Action::Wait(WaitReason::Question);
        let Some(head) = row.task.operator_question() else {
            return Ok(waiting);
        };
        let mut state = self.state.lock().await;
        let id = &row.task.identity().id;
        let current = self.lookup(&state, id)?;
        if current != *row {
            return Ok(waiting);
        }
        let observation = state.command_observation(&current);
        let mut updated = current.task.clone();
        let command = Command::Answer(Answer::Accept {
            head: head.clone(),
            // Decline uses the same exact-head preflight and discards the prospective acceptance.
            reason: if declined {
                "Check the declined head".into()
            } else {
                reason
            },
        });
        let authority = Authority::Operator { actor };
        if !matches!(
            state.preflight(&mut updated, &authority, &observation, command)?,
            Preflight::Ready
        ) {
            return Ok(waiting);
        }
        if declined {
            updated = current.task.clone();
            if !updated.decline_operator_question(head) {
                return Ok(waiting);
            }
        }
        self.commit(
            &mut state,
            row,
            &updated,
            &event(if declined {
                "operator_declined"
            } else {
                "operator_accepted"
            }),
            None,
        )?;
        Ok(waiting)
    }
}
