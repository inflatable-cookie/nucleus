//! Reconcile native visibility independently of dispatch and API reads.

use std::{path::Path, time::Duration};

use nucleus_core::{Role, Task};
use nucleus_hosts::{
    ParentWrite, RowChange, RowChildren, RowObservation, RowVisibility, SendOutcome,
};
use nucleus_store::{RowSnooze, SnoozeOutcome, TaskRow};

use crate::{
    Service, ServiceError, State, attention::TaskAttention, event, now_ms, pass::DispatchTarget,
};

const HORIZON_MS: u64 = 48 * 60 * 60 * 1_000;
const RENEW_BEFORE_MS: u64 = HORIZON_MS / 2;
const RECHECK_MS: u64 = 15_000;

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
    let shown = visibility.snoozed_until_ms;
    let owned = receipt.as_ref().filter(|receipt| receipt.owns(shown));
    if let Some(receipt) = owned
        && receipt.outcome == SnoozeOutcome::Unknown
        && shown == Some(receipt.until_ms)
    {
        return Plan::Record(RowSnooze {
            outcome: SnoozeOutcome::Observed,
            previous_until_ms: None,
            ..receipt.clone()
        });
    }
    if attention != TaskAttention::Waiting || children == RowChildren::Active {
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

impl Service {
    pub(super) async fn reconcile_task_rows(
        &self,
        provider: &str,
        threads: &[String],
    ) -> Result<Option<Duration>, ServiceError> {
        let now = now_ms();
        let mut jobs = Vec::new();
        let mut next = None;
        {
            let state = self.state.lock().await;
            for thread in threads {
                let Some(hint) = self.host.row_visibility_hint(thread) else {
                    continue;
                };
                let Some(id) = state.store.task_with_title_thread(thread)? else {
                    continue;
                };
                let row = self.lookup(&state, &id)?;
                let Some(attention) = row_attention_for_effect(&state, &row)? else {
                    continue;
                };
                let receipt = state.store.row_snooze(&id, thread)?;
                let children = self.host.row_children(thread, &visibility_roles(&row.task));
                match plan_row(attention, hint, receipt, now, children) {
                    Plan::Idle(deadline) => next = earliest(next, deadline),
                    _ => jobs.push((row, thread)),
                }
            }
        }
        for (row, thread) in jobs {
            if let Err(error) = Box::pin(self.reconcile_task_row(&row, provider, thread)).await {
                eprintln!("{thread}: {error}");
            }
            next = earliest(next, Some(now + RECHECK_MS));
        }
        Ok(next.map(|deadline| Duration::from_millis(deadline.saturating_sub(now_ms()))))
    }

    async fn reconcile_task_row(
        &self,
        row: &TaskRow,
        provider: &str,
        thread: &str,
    ) -> Result<(), ServiceError> {
        let task = &row.task;
        let identity = task.identity();
        let id = &identity.id;
        let fence = self.task_fence(id).await;
        let Ok(_fence) = fence.try_lock_owned() else {
            return Ok(());
        };
        if self.task(id).await? != *row {
            return Ok(());
        }
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
            return Ok(());
        };
        let destination = DispatchTarget::Presentation {
            frozen: &binding,
            checkout: &checkout,
        };
        let Some(_permit) = self.dispatch_gate(task, destination).await? else {
            return Ok(());
        };
        let Some(observed) = self.host.observe_task_row(&binding, provider).await? else {
            return Ok(());
        };
        let roles = visibility_roles(task);
        let (change, mut receipt, prior) = {
            let state = self.state.lock().await;
            let Some(attention) = row_attention_for_effect(&state, row)? else {
                return Ok(());
            };
            let prior = state.store.row_snooze(id, thread)?;
            let children = self.host.row_children(thread, &roles);
            match plan_row(
                attention,
                observed.visibility,
                prior.clone(),
                now_ms(),
                children,
            ) {
                Plan::Idle(_) => return Ok(()),
                Plan::Forget => return Ok(state.store.forget_row_snooze(id)?),
                Plan::Record(receipt) => {
                    return Ok(state.store.save_row_snooze(id, thread, &receipt)?);
                }
                Plan::Write(change, receipt) => {
                    state.store.save_row_snooze(id, thread, &receipt)?;
                    (change, receipt, prior)
                }
            }
        };
        let command = snooze_command(id, thread, change, &receipt);
        let result = self
            .host
            .write_row_visibility(&binding, &command, change, Some(&target), &roles)
            .await;
        if matches!(result, Err(nucleus_hosts::HostError::RowChildBusy)) {
            let state = self.state.lock().await;
            match prior {
                Some(prior) => state.store.save_row_snooze(id, thread, &prior)?,
                None => state.store.forget_row_snooze(id)?,
            }
            return Ok(());
        }
        if matches!(result, Ok(SendOutcome::Rejected))
            && matches!(change, RowChange::SnoozeUntil(_))
        {
            receipt.outcome = SnoozeOutcome::Refused;
            self.state
                .lock()
                .await
                .store
                .save_row_snooze(id, thread, &receipt)?;
        }
        let fresh = self.host.observe_task_row(&binding, provider).await?;
        self.record_row_readback(id, thread, receipt, fresh).await?;
        result.map(|_| ()).map_err(ServiceError::from)
    }

    async fn record_row_readback(
        &self,
        id: &str,
        thread: &str,
        mut receipt: RowSnooze,
        observed: Option<RowObservation>,
    ) -> Result<(), ServiceError> {
        let Some(observed) = observed else {
            return Ok(());
        };
        let shown = observed.visibility.snoozed_until_ms;
        let state = self.state.lock().await;
        if let Some(cleared) = receipt.clear_attempted_for
            && shown != Some(cleared)
            && receipt.outcome != SnoozeOutcome::Unknown
        {
            state.store.forget_row_snooze(id)?;
        } else if receipt.outcome == SnoozeOutcome::Unknown && shown == Some(receipt.until_ms) {
            receipt.outcome = SnoozeOutcome::Observed;
            receipt.previous_until_ms = None;
            state.store.save_row_snooze(id, thread, &receipt)?;
        }
        Ok(())
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
            .claim_task_effect(id, &intent)?)
    }

    /// Wake an exact task parent before an already authorized native message.
    /// The caller holds the task and project fences. Readback gates delivery.
    #[expect(
        clippy::too_many_lines,
        reason = "keep the visibility claims and their readback in order"
    )]
    pub(super) async fn wake_parent_delivery(
        &self,
        row: &TaskRow,
        provider: &str,
        write: &ParentWrite,
    ) -> Result<(), ServiceError> {
        let Some(initial) = write.delivery_row() else {
            return Ok(());
        };
        let binding = write.binding();
        let thread = nucleus_hosts::parent_thread(Path::new(&binding.worktree_path));
        let id = &row.task.identity().id;
        let mut observed = initial;
        // Settling and snoozing are distinct in T3. Clear each one explicitly.
        for _ in 0..2 {
            let receipt = self.state.lock().await.store.row_snooze(id, &thread)?;
            let visibility = observed.visibility;
            let shown = visibility
                .snoozed_until_ms
                .filter(|&until| until > now_ms());
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
            } else if shown.is_some() {
                RowChange::Unsnooze
            } else {
                return Ok(());
            };
            let Some(fresh) = self
                .host
                .observe_task_row(binding, provider)
                .await
                .map_err(|error| {
                    self.parent_not_sent(format!("pre-wake visibility read failed: {error}"))
                })?
            else {
                return Err(self.parent_not_sent(format!(
                    "parent row unavailable before {change:?} (prepared revision {})",
                    observed.sequence
                )));
            };
            if fresh.visibility != visibility {
                return Err(self.parent_not_sent(format!(
                    "visibility changed before {change:?} (revision {} {visibility:?}, revision {} {:?})",
                    observed.sequence, fresh.sequence, fresh.visibility,
                )));
            }
            let (command, cleared) = if matches!(change, RowChange::Unsettle) {
                let occurrence = visibility
                    .settled_at_ms
                    .map_or_else(|| format!("version-{}", row.version), |at| at.to_string());
                let command = format!("task-{id}-{thread}-unsettle-{occurrence}");
                if !self.claim_row_unsettle(id, &command).await? {
                    return Err(self.parent_not_sent(format!(
                        "unsettle already claimed (revision {}, settled at {:?})",
                        fresh.sequence, visibility.settled_at_ms
                    )));
                }
                (command, None)
            } else {
                let Some(mut receipt) =
                    owned.filter(|receipt| receipt.clear_attempted_for != shown)
                else {
                    return Err(self.parent_not_sent(format!(
                        "unsnooze already attempted (revision {}, horizon {shown:?})",
                        fresh.sequence
                    )));
                };
                receipt.clear_attempted_for = shown;
                self.state
                    .lock()
                    .await
                    .store
                    .save_row_snooze(id, &thread, &receipt)?;
                (snooze_command(id, &thread, change, &receipt), Some(receipt))
            };
            let result = self
                .host
                .write_row_visibility(binding, &command, change, None, &[])
                .await;
            let fresh = self
                .host
                .observe_task_row(binding, provider)
                .await
                .map_err(|error| {
                    self.parent_not_sent(format!(
                        "{change:?} readback failed (write {result:?}): {error}"
                    ))
                })?;
            if let Some(receipt) = cleared {
                self.record_row_readback(id, &thread, receipt, fresh)
                    .await?;
            }
            let Some(fresh) = fresh else {
                return Err(self.parent_not_sent(format!(
                    "parent row unavailable after {change:?} (revision {}, write {result:?})",
                    observed.sequence
                )));
            };
            if fresh.visibility == visibility {
                return Err(self.parent_not_sent(format!(
                    "{change:?} has no visibility readback (revision {} to {}, visibility {visibility:?}, write {result:?})",
                    observed.sequence, fresh.sequence,
                )));
            }
            observed = fresh;
        }
        if observed.visibility.settled
            || observed
                .visibility
                .snoozed_until_ms
                .is_some_and(|until| until > now_ms())
        {
            return Err(self.parent_not_sent(format!(
                "row is still settled or snoozed after wake (revision {}, visibility {:?})",
                observed.sequence, observed.visibility
            )));
        }
        Ok(())
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
