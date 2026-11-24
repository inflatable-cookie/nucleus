//! Reconcile native visibility independently of dispatch and API reads.

use std::{path::Path, time::Duration};

use nucleus_core::{Role, Task};
use nucleus_hosts::{
    ParentSendError, ParentWrite, RowChange, RowChildren, RowObservation, RowVisibility,
    SendOutcome,
};
use nucleus_store::{RowSnooze, SnoozeOutcome, TaskRow};

use crate::{
    Service, ServiceError, State, attention::TaskAttention, event, now_ms, pass::DispatchTarget,
};

const HORIZON_MS: u64 = 48 * 60 * 60 * 1_000;
const RENEW_BEFORE_MS: u64 = HORIZON_MS / 2;
const RECHECK_MS: u64 = 15_000;
const UNSETTLE_NOT_SENT: &str = "native_row_unsettle_not_sent";

#[derive(Debug, PartialEq, Eq)]
enum Plan {
    Idle(Option<u64>),
    Forget,
    Record(RowSnooze),
    Write(RowChange, RowSnooze),
}

fn plan_row(
    attention: TaskAttention,
    visibility: RowVisibility,
    receipt: Option<RowSnooze>,
    now: u64,
    children: RowChildren,
) -> Plan {
    if visibility.settled && children != RowChildren::Active {
        return Plan::Idle(None);
    }
    let attention = if children == RowChildren::Active {
        TaskAttention::Active
    } else {
        attention
    };
    let shown = visibility.snoozed_until_ms;
    let cleared = receipt
        .as_ref()
        .is_some_and(|receipt| clear_observed(receipt, shown));
    if cleared && attention != TaskAttention::Waiting {
        return Plan::Forget;
    }
    let mut receipt = receipt.filter(|_| !cleared);
    if let Some(receipt) = receipt.as_mut()
        && confirm_snooze(receipt, shown)
        && attention == TaskAttention::Waiting
    {
        return Plan::Record(receipt.clone());
    }
    if attention != TaskAttention::Waiting {
        let Some(mut receipt) = receipt else {
            return Plan::Idle(None);
        };
        if receipt.owns(shown)
            && let Some(until) = shown
        {
            if receipt.clear_attempted_for == shown {
                return Plan::Idle(None);
            }
            receipt.clear_attempted_for = Some(until);
            return Plan::Write(RowChange::Unsnooze, receipt);
        }
        if receipt.outcome == SnoozeOutcome::Unknown && receipt.until_ms > now {
            if receipt.ended {
                return Plan::Idle(Some(receipt.until_ms));
            }
            receipt.ended = true;
            return Plan::Record(receipt);
        }
        return Plan::Forget;
    }
    let snoozed = shown.filter(|&until| until > now);
    let owned = receipt.as_ref().filter(|receipt| receipt.owns(shown));
    if let Some(until) = snoozed
        && owned.is_none()
    {
        return Plan::Idle(Some(until));
    }
    if let Some(prior) = &receipt {
        if prior.outcome == SnoozeOutcome::Refused && !prior.ended {
            return Plan::Idle(None);
        }
        if prior.outcome == SnoozeOutcome::Unknown && (!prior.ended || prior.until_ms > now) {
            return Plan::Idle(prior.ended.then_some(prior.until_ms));
        }
        if let Some(until) = snoozed
            && prior.clear_attempted_for == Some(until)
        {
            return Plan::Idle(Some(until));
        }
        if let Some(until) = snoozed
            && until.saturating_sub(now) >= RENEW_BEFORE_MS
        {
            return Plan::Idle(Some(until - RENEW_BEFORE_MS + 1));
        }
    }
    if children != RowChildren::Quiet {
        return Plan::Idle(None);
    }
    let until = now + HORIZON_MS;
    let episode = receipt
        .as_ref()
        .filter(|prior| !prior.ended)
        .map_or(now, |prior| prior.episode);
    Plan::Write(
        RowChange::SnoozeUntil(until),
        RowSnooze {
            episode,
            until_ms: until,
            previous_until_ms: owned.and(snoozed),
            outcome: SnoozeOutcome::Unknown,
            clear_attempted_for: None,
            ended: false,
        },
    )
}

fn clear_observed(receipt: &RowSnooze, shown: Option<u64>) -> bool {
    receipt.clear_attempted_for.is_some()
        && receipt.clear_attempted_for != shown
        && receipt.outcome != SnoozeOutcome::Unknown
}

fn confirm_snooze(receipt: &mut RowSnooze, shown: Option<u64>) -> bool {
    if receipt.outcome != SnoozeOutcome::Unknown || shown != Some(receipt.until_ms) {
        return false;
    }
    receipt.outcome = SnoozeOutcome::Observed;
    receipt.previous_until_ms = None;
    true
}

impl Service {
    pub(super) async fn reconcile_task_rows(
        &self,
        provider: &str,
        threads: &[String],
    ) -> Result<Option<Duration>, ServiceError> {
        let mut next = None;
        for thread in threads {
            let id = self
                .state
                .lock()
                .await
                .store
                .task_with_title_thread(thread)?;
            let Some(id) = id else { continue };
            let due = match Box::pin(self.reconcile_task_row(&id, provider, thread)).await {
                Ok(due) => due,
                Err(error) => {
                    eprintln!("{thread}: {error}");
                    Some(now_ms() + RECHECK_MS)
                }
            };
            next = earliest(next, due);
        }
        Ok(next.map(|deadline| Duration::from_millis(deadline.saturating_sub(now_ms()))))
    }

    async fn reconcile_task_row(
        &self,
        id: &str,
        provider: &str,
        thread: &str,
    ) -> Result<Option<u64>, ServiceError> {
        let retry = Some(now_ms() + RECHECK_MS);
        let fence = self.task_fence(id).await;
        let Ok(_fence) = fence.try_lock_owned() else {
            return Ok(retry);
        };
        let Some(visibility) = self.host.row_visibility_hint(thread) else {
            return Ok(None);
        };
        let (row, prior, plan, attention) = {
            let state = self.state.lock().await;
            let row = self.lookup(&state, id)?;
            let Some(attention) = row_attention_for_effect(&state, &row)? else {
                return Ok(None);
            };
            let prior = state.store.row_snooze(id, thread)?;
            let children = self.host.row_children(thread, &visibility_roles(&row.task));
            let plan = plan_row(attention, visibility, prior.clone(), now_ms(), children);
            (row, prior, plan, attention)
        };
        if let Plan::Idle(deadline) = plan {
            return Ok(deadline);
        }
        let task = &row.task;
        let identity = task.identity();
        let route = self.project_for(identity).await?;
        let work = self.worktrees()?;
        let checkout = work.checkout(&route.checkout, &identity.repository, id)?;
        let binding = route.binding(&checkout)?;
        let Some(target) = route
            .checkout
            .to_str()
            .and_then(|root| self.host.title_target(&binding, provider, root))
            .filter(|target| target.thread() == thread)
        else {
            return Ok(retry);
        };
        if target.visibility()? != visibility {
            return Ok(retry);
        }
        let destination = DispatchTarget::Presentation {
            frozen: &binding,
            checkout: &checkout,
        };
        let Some(_permit) = self.dispatch_gate(task, destination).await? else {
            return Ok(retry);
        };
        let (change, mut receipt) = {
            let state = self.state.lock().await;
            if row_attention_for_effect(&state, &row)? != Some(attention) {
                return Ok(retry);
            }
            match plan {
                Plan::Idle(deadline) => return Ok(deadline),
                Plan::Forget => {
                    state.store.forget_row_snooze(id)?;
                    return Ok(None);
                }
                Plan::Record(receipt) => {
                    state.store.save_row_snooze(id, thread, &receipt)?;
                    return Ok(retry);
                }
                Plan::Write(change, receipt) => {
                    state.store.save_row_snooze(id, thread, &receipt)?;
                    (change, receipt)
                }
            }
        };
        let roles = visibility_roles(task);
        let command = snooze_command(id, thread, change, &receipt);
        let result = self
            .host
            .write_row_visibility(&binding, &command, change, Some(&target), &roles, None)
            .await;
        if let Err(ParentSendError::NotSent(error)) = result {
            self.restore_row_snooze(id, thread, prior.as_ref()).await?;
            return match error {
                nucleus_hosts::HostError::RowChildBusy => Ok(retry),
                _ => Err(error.into()),
            };
        } else if matches!(result, Ok(SendOutcome::Rejected))
            && matches!(change, RowChange::SnoozeUntil(_))
        {
            receipt.outcome = SnoozeOutcome::Refused;
            self.state
                .lock()
                .await
                .store
                .save_row_snooze(id, thread, &receipt)?;
        }
        result.map(|_| retry).map_err(|error| match error {
            ParentSendError::NotSent(cause) | ParentSendError::Unknown(cause) => cause.into(),
        })
    }

    async fn restore_row_snooze(
        &self,
        id: &str,
        thread: &str,
        prior: Option<&RowSnooze>,
    ) -> Result<(), ServiceError> {
        let state = self.state.lock().await;
        match prior {
            Some(prior) => state.store.save_row_snooze(id, thread, prior)?,
            None => state.store.forget_row_snooze(id)?,
        }
        Ok(())
    }

    async fn snooze_for_delivery(
        &self,
        id: &str,
        thread: &str,
        visibility: RowVisibility,
    ) -> Result<Option<RowSnooze>, ServiceError> {
        let state = self.state.lock().await;
        let receipt = state.store.row_snooze(id, thread)?;
        if receipt
            .as_ref()
            .is_some_and(|prior| clear_observed(prior, visibility.snoozed_until_ms))
            && self.host.row_visibility_hint(thread) == Some(visibility)
        {
            state.store.forget_row_snooze(id)?;
            return Ok(None);
        }
        Ok(receipt)
    }

    pub(super) async fn claim_row_unsettle(
        &self,
        id: &str,
        command: &str,
    ) -> Result<bool, ServiceError> {
        let mut intent = event("native_row_unsettle");
        intent.detail = command.into();
        Ok(self
            .state
            .lock()
            .await
            .store
            .claim_task_effect_after(id, &intent, false, Some(UNSETTLE_NOT_SENT))?
            .is_some())
    }

    /// Clear one visibility barrier before the next delivery plan.
    pub(super) async fn wake_parent_delivery(
        &self,
        row: &TaskRow,
        write: &ParentWrite,
    ) -> Result<(), ServiceError> {
        if let Some((initial, provider)) = write.delivery_row() {
            self.wake_task_parent(row, write.binding(), provider, initial)
                .await?;
        }
        Ok(())
    }

    pub(super) async fn wake_task_parent(
        &self,
        row: &TaskRow,
        binding: &nucleus_hosts::Binding,
        provider: &str,
        observed: RowObservation,
    ) -> Result<(), ServiceError> {
        let thread = nucleus_hosts::parent_thread(Path::new(&binding.worktree_path));
        let id = &row.task.identity().id;
        let visibility = observed.visibility;
        let shown = visibility
            .snoozed_until_ms
            .filter(|&until| until > now_ms());
        let receipt = self.snooze_for_delivery(id, &thread, visibility).await?;
        if !visibility.settled && shown.is_none() {
            return Ok(());
        }
        let owned = receipt.filter(|receipt| receipt.owns(shown));
        if let Some(until) = shown
            && owned.is_none()
        {
            let retry = tokio::time::Instant::now()
                + Duration::from_millis(until.saturating_sub(now_ms()).min(45_000));
            return Err(ServiceError::ParentNotSent {
                reason: format!(
                    "operator snooze is active (horizon {until}, revision {})",
                    observed.sequence
                ),
                retry_at: self.host.request_retry_at().max(Some(retry)),
            });
        }
        let change = if visibility.settled {
            RowChange::Unsettle
        } else {
            RowChange::Unsnooze
        };
        let (command, cleared) = if matches!(change, RowChange::Unsettle) {
            let occurrence = visibility
                .settled_at_ms
                .map_or_else(|| format!("version-{}", row.version), |at| at.to_string());
            let command = format!("task-{id}-{thread}-unsettle-{occurrence}");
            if !self.claim_row_unsettle(id, &command).await? {
                return Err(self.parent_not_sent(format!(
                    "unsettle already claimed (revision {}, settled at {:?})",
                    observed.sequence, visibility.settled_at_ms
                )));
            }
            (command, None)
        } else {
            let Some(prior) = owned else {
                return Err(self.parent_not_sent("the owned snooze is no longer visible"));
            };
            let mut receipt = prior.clone();
            confirm_snooze(&mut receipt, shown);
            receipt.clear_attempted_for = shown;
            if receipt != prior {
                self.state
                    .lock()
                    .await
                    .store
                    .save_row_snooze(id, &thread, &receipt)?;
            }
            (snooze_command(id, &thread, change, &receipt), Some(prior))
        };
        let result = self
            .host
            .write_row_visibility(
                binding,
                &command,
                change,
                None,
                &[],
                Some((observed, provider)),
            )
            .await;
        if let Err(ParentSendError::NotSent(error)) = result {
            if let Some(prior) = &cleared {
                self.restore_row_snooze(id, &thread, Some(prior)).await?;
            } else {
                let mut refusal = event(UNSETTLE_NOT_SENT);
                refusal.detail = command;
                self.state
                    .lock()
                    .await
                    .store
                    .record_task_effect(id, &refusal)?;
            }
            return Err(self.parent_not_sent(format!(
                "{change:?} refused before send (prepared {observed:?}): {error}"
            )));
        }
        if change == RowChange::Unsnooze && matches!(result, Ok(SendOutcome::Rejected)) {
            return Err(self.parent_not_sent(format!(
                "T3 rejected clearing the snooze. Open the task thread and clear its snooze (revision {}, horizon {shown:?})",
                observed.sequence
            )));
        }
        Err(self.parent_not_sent(format!(
            "{change:?} is waiting for shell confirmation (revision {}, write {result:?})",
            observed.sequence
        )))
    }
}

pub(super) fn visibility_roles(task: &Task) -> Vec<&str> {
    [Role::Worker, Role::Reviewer]
        .into_iter()
        .filter_map(|role| task.threads().get(role))
        .chain(task.run().map(|run| run.launch().thread.as_str()))
        .collect()
}

fn row_attention_for_effect(
    state: &State,
    row: &TaskRow,
) -> Result<Option<TaskAttention>, ServiceError> {
    let attention = state.task_attention(row)?;
    // After a cold start a recorded send alone gives no evidence that a child is quiet.
    let awaiting_child_read = attention == TaskAttention::Waiting
        && row.task.run().is_some_and(|run| {
            !run.revoked() && run.report().is_none() && run.last_send_at_ms().is_some()
        })
        && state.role_observation(&row.task).is_none();
    Ok((attention != TaskAttention::Finished && !awaiting_child_read).then_some(attention))
}

fn earliest(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    left.into_iter().chain(right).min()
}

fn snooze_command(id: &str, thread: &str, change: RowChange, receipt: &RowSnooze) -> String {
    let (action, until) = if matches!(change, RowChange::Unsnooze) {
        (
            "unsnooze",
            receipt.clear_attempted_for.unwrap_or(receipt.until_ms),
        )
    } else {
        ("snooze", receipt.until_ms)
    };
    format!("task-{id}-{thread}-{action}-{}-{until}", receipt.episode)
}

#[cfg(test)]
mod tests;
