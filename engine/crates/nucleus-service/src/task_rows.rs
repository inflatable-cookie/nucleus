//! Reconcile native visibility independently of dispatch and API reads.

use std::{path::Path, time::Duration};

use nucleus_core::{Role, Task, WaitReason};
use nucleus_hosts::{
    ParentSendError, RowChange, RowChildren, RowObservation, RowVisibility, SendOutcome,
};
use nucleus_store::{RowSnooze, SnoozeOutcome, TaskRow};

use crate::{Service, ServiceError, State, WaitDetail, now_ms, pass::DispatchTarget};

const HORIZON_MS: u64 = 48 * 60 * 60 * 1_000;
const RENEW_BEFORE_MS: u64 = HORIZON_MS / 2;
const HANDOVER_MS: u64 = 120_000;
const RECHECK_MS: u64 = 15_000;

#[derive(Debug, PartialEq, Eq)]
enum Plan {
    Idle(Option<u64>),
    Forget,
    Record(RowSnooze),
    Write(RowChange, RowSnooze),
}

fn plan_row(
    visible: bool,
    visibility: RowVisibility,
    receipt: Option<RowSnooze>,
    now: u64,
    message_at: Option<u64>,
) -> Plan {
    if visibility.settled {
        return Plan::Idle(None);
    }
    let shown = visibility.snoozed_until_ms;
    let cleared = receipt.as_ref().is_some_and(|prior| {
        // A later message clears the snooze even when the shell missed its horizon.
        clear_observed(prior, shown)
            || shown.is_none()
                && message_at
                    .is_some_and(|at| at > prior.until_ms.saturating_sub(HORIZON_MS) && at <= now)
    });
    if cleared && visible {
        return Plan::Forget;
    }
    let mut receipt = receipt.filter(|_| !cleared);
    if let Some(receipt) = receipt.as_mut()
        && confirm_snooze(receipt, shown)
        && !visible
    {
        return Plan::Record(receipt.clone());
    }
    if visible {
        let Some(mut receipt) = receipt else {
            return Plan::Idle(None);
        };
        if receipt.owns(shown)
            && let Some(until) = shown
        {
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
    #[cfg_attr(
        not(test),
        expect(clippy::unused_self, reason = "tests advance the clock per service")
    )]
    pub(super) fn visibility_now(&self) -> u64 {
        #[cfg(test)]
        {
            let time = self
                .visibility_time
                .load(std::sync::atomic::Ordering::Relaxed);
            if time != 0 {
                return time;
            }
        }
        now_ms()
    }

    pub(super) fn role_window(&self, parent: &str, task: &Task) -> (RowChildren, u64, Option<u64>) {
        let (activity, ended) = self.host.row_children(parent, &visibility_roles(task));
        let until = ended.saturating_add(HANDOVER_MS);
        let handover =
            (activity == RowChildren::Quiet && ended != 0 && self.visibility_now() < until)
                .then_some(until);
        (activity, ended, handover)
    }

    pub(super) async fn operator_snooze_wait(&self, row: &TaskRow) -> Option<ServiceError> {
        let state = self.state.lock().await;
        let WaitDetail::OperatorSnoozed {
            version,
            thread,
            until,
            ..
        } = state.wait_detail(&row.task.identity().id)?
        else {
            return None;
        };
        (*version == row.version
            && *until > now_ms()
            && self
                .host
                .row_visibility_hint(thread)
                .is_none_or(|row| row.snoozed_until_ms == Some(*until)))
        .then(|| ServiceError::OperatorSnoozed {
            thread: thread.clone(),
            until: *until,
        })
    }

    pub(super) async fn owned_delivery_snoozes(
        &self,
        row: &TaskRow,
        thread: &str,
    ) -> Result<Vec<u64>, ServiceError> {
        let receipt = self
            .state
            .lock()
            .await
            .store
            .row_snooze(&row.task.identity().id, thread)?;
        Ok(receipt.map_or_else(Vec::new, |receipt| {
            [Some(receipt.until_ms), receipt.previous_until_ms]
                .into_iter()
                .flatten()
                .filter(|&until| receipt.owns(Some(until)))
                .collect()
        }))
    }

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
                    Some(self.visibility_now() + RECHECK_MS)
                }
            };
            next = earliest(next, due);
        }
        Ok(next
            .map(|deadline| Duration::from_millis(deadline.saturating_sub(self.visibility_now()))))
    }

    fn row_plan(
        &self,
        state: &State,
        row: &TaskRow,
        thread: &str,
        visibility: RowVisibility,
        prior: Option<RowSnooze>,
    ) -> Result<(Plan, u64, Option<u64>), ServiceError> {
        let (activity, ended, handover) = self.role_window(thread, &row.task);
        let question = row_question(state, &row.task)?;
        if self.desire_title(state, &row.task, row.number) {
            self.publish_detail(&row.task.identity().id, row.version);
        }
        if activity == RowChildren::Unknown && !question {
            return Ok((Plan::Idle(None), ended, None));
        }
        let visible = question || activity == RowChildren::Active || handover.is_some();
        Ok((
            plan_row(
                visible,
                visibility,
                prior,
                self.visibility_now(),
                self.host.row_message_at(thread),
            ),
            ended,
            handover,
        ))
    }

    async fn reconcile_task_row(
        &self,
        id: &str,
        provider: &str,
        thread: &str,
    ) -> Result<Option<u64>, ServiceError> {
        let now = self.visibility_now();
        let retry = Some(now + RECHECK_MS);
        let Ok(_fence) = self.task_fence(id).await.try_lock_owned() else {
            return Ok(retry);
        };
        let Some(visibility) = self.host.row_visibility_hint(thread) else {
            return Ok(None);
        };
        let (row, prior, plan, ended, deadline) = {
            let state = self.state.lock().await;
            let row = self.lookup(&state, id)?;
            if row.task.phase().is_terminal() {
                return Ok(None);
            }
            let prior = state.store.row_snooze(id, thread)?;
            let (plan, ended, handover) =
                self.row_plan(&state, &row, thread, visibility, prior.clone())?;
            (row, prior, plan, ended, handover)
        };
        if let Plan::Idle(next) = plan {
            return Ok(earliest(next, deadline));
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
        let (change, receipt) = match plan {
            Plan::Write(change, receipt) => (change, receipt),
            Plan::Record(receipt) => {
                self.restore_row_snooze(id, thread, Some(&receipt)).await?;
                return Ok(retry);
            }
            Plan::Forget => {
                self.restore_row_snooze(id, thread, None).await?;
                return Ok(deadline);
            }
            Plan::Idle(next) => return Ok(earliest(deadline, next)),
        };
        {
            let state = self.state.lock().await;
            if matches!(change, RowChange::SnoozeUntil(_)) && row_question(&state, task)? {
                return Ok(retry);
            }
            state.store.save_row_snooze(id, thread, &receipt)?;
        }
        let command = snooze_command(id, thread, change, &receipt);
        let result = self
            .host
            .write_row_visibility(
                &binding,
                &command,
                change,
                &target,
                (&visibility_roles(task), ended),
            )
            .await;
        let outcome = match result {
            Err(ParentSendError::NotSent(error)) => {
                self.restore_row_snooze(id, thread, prior.as_ref()).await?;
                return if matches!(error, nucleus_hosts::HostError::RowChildBusy) {
                    Ok(retry)
                } else {
                    Err(error.into())
                };
            }
            result => result.map_err(nucleus_hosts::HostError::from)?,
        };
        self.finish_visibility_write(id, thread, change, outcome, receipt)
            .await?;
        Ok(earliest(
            deadline,
            retry.filter(|_| change != RowChange::Unsnooze),
        ))
    }

    async fn finish_visibility_write(
        &self,
        id: &str,
        thread: &str,
        change: RowChange,
        outcome: SendOutcome,
        mut receipt: RowSnooze,
    ) -> Result<(), ServiceError> {
        if change == RowChange::Unsnooze {
            self.restore_row_snooze(id, thread, None).await?;
        } else if outcome == SendOutcome::Rejected {
            receipt.outcome = SnoozeOutcome::Refused;
            self.restore_row_snooze(id, thread, Some(&receipt)).await?;
        }
        Ok(())
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

    pub(super) async fn check_parent_snooze(
        &self,
        row: &TaskRow,
        binding: &nucleus_hosts::Binding,
        observed: RowObservation,
    ) -> Result<(), ServiceError> {
        let thread = nucleus_hosts::parent_thread(Path::new(&binding.worktree_path));
        let id = &row.task.identity().id;
        let visibility = observed.visibility;
        let shown = visibility
            .snoozed_until_ms
            .filter(|&until| until > now_ms());
        let receipt = self.snooze_for_delivery(id, &thread, visibility).await?;
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
        Ok(())
    }
}

pub(super) fn visibility_roles(task: &Task) -> Vec<&str> {
    [Role::Worker, Role::Reviewer]
        .into_iter()
        .filter_map(|role| task.threads().get(role))
        .chain(
            task.run()
                .filter(|run| run.last_send_at_ms().is_some())
                .map(|run| run.launch().thread.as_str()),
        )
        .collect()
}

fn row_question(state: &State, task: &Task) -> Result<bool, ServiceError> {
    Ok((task.operator_decline().is_none()
        && (task.operator_question().is_some() || task.question().is_some()))
        || matches!(
            state.wait_reason(&task.identity().id),
            Some(WaitReason::Permission | WaitReason::Input)
        )
        || state.has_open_usage_decision(task)?)
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
