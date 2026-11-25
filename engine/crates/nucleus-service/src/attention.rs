//! One local read model for the board, next and native task rows.

use nucleus_core::{Host, Observed, Phase, RunState, Task, WaitReason};
use nucleus_store::TaskRow;
use serde::Serialize;

use crate::{Service, ServiceError, State};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum TaskAttention {
    Finished,
    Attention,
    Active,
    Waiting,
}

pub(super) fn waiting_for_person(task: &Task, wait: Option<WaitReason>) -> bool {
    (task.operator_decline().is_none() && task.question().is_some())
        || wait == Some(WaitReason::Question)
        || waiting_for_operator_input(wait)
}

fn waiting_for_operator_input(wait: Option<WaitReason>) -> bool {
    matches!(
        wait,
        Some(WaitReason::Permission | WaitReason::Input | WaitReason::UsagePermission)
    )
}

impl State {
    pub(super) fn task_attention(&self, row: &TaskRow) -> Result<TaskAttention, ServiceError> {
        let task = &row.task;
        if task.phase().is_terminal() {
            return Ok(TaskAttention::Finished);
        }
        let id = &task.identity().id;
        let wait = self.wait_reason(id);
        if self.has_open_usage_decision(task)?
            || (task.operator_question().is_some() && task.operator_decline().is_none())
            || waiting_for_operator_input(wait)
            || wait == Some(WaitReason::HostObservationBlocked)
        {
            return Ok(TaskAttention::Attention);
        }
        let role_state = self.role_observation(task);
        match role_state {
            Some(RunState::Input | RunState::Permission) => return Ok(TaskAttention::Attention),
            Some(RunState::Running | RunState::Starting) => return Ok(TaskAttention::Active),
            _ => {}
        }
        if role_state.is_none()
            && (wait == Some(WaitReason::Starting)
                || ((wait == Some(WaitReason::Running)
                    || (self.waits.contains_key(id) && wait.is_none() && task.hold().is_none()))
                    && task
                        .run()
                        .is_some_and(|run| !run.revoked() && run.report().is_none())))
        {
            return Ok(TaskAttention::Active);
        }
        if task.phase() != Phase::Closing && self.store.dependency_blocked(id)? {
            return Ok(if self.store.dependency_needs_edit(id)? {
                TaskAttention::Attention
            } else {
                TaskAttention::Waiting
            });
        }
        if task.hold().is_some() || task.question().is_some() || wait == Some(WaitReason::Question)
        {
            return Ok(TaskAttention::Waiting);
        }
        Ok(match task.phase() {
            Phase::Blocked | Phase::Error => TaskAttention::Attention,
            _ => TaskAttention::Waiting,
        })
    }

    pub(super) fn role_observation(&self, task: &nucleus_core::Task) -> Option<RunState> {
        let run = task.run().filter(|run| !run.revoked())?;
        let (instance, state) = self.role_observations.get(&task.identity().id)?;
        (instance == &run.launch().instance).then_some(*state)
    }
}

impl Service {
    pub(super) async fn observe_run_routing(
        &self,
        row: &TaskRow,
        run: &nucleus_core::Run,
        routing: &nucleus_hosts::RunRouting,
    ) -> Result<(), ServiceError> {
        let id = &row.task.identity().id;
        let mut state = self.state.lock().await;
        if self.lookup(&state, id)?.version != row.version {
            return Err(nucleus_store::StoreError::StaleTask.into());
        }
        let mut audit = crate::event("run_routing_observed");
        audit.detail = serde_json::json!({"presentation":[nucleus_core::acp::lifecycle::Milestone::RunRouting {
            instance: run.launch().instance.clone(),
            provider_instance: routing.provider.clone(),
            provider: self.host.cached_provider_family(&routing.provider),
            model: routing.model.clone(),
        }]}).to_string();
        if state.store.claim_task_effect(id, &audit, false)?.is_some() {
            self.publish(id, row.version);
        }
        Ok(())
    }

    pub(super) async fn observe_role_state(
        &self,
        row: &TaskRow,
        observation: &Observed<Host>,
    ) -> Result<(), ServiceError> {
        let Observed::Known(Host::Current {
            instance,
            state: run_state,
        }) = observation
        else {
            return Ok(());
        };
        let id = &row.task.identity().id;
        let mut state = self.state.lock().await;
        if self.lookup(&state, id)?.version != row.version {
            return Err(nucleus_store::StoreError::StaleTask.into());
        }
        let next = (instance.clone(), *run_state);
        if state.role_observations.get(id) != Some(&next) {
            state.role_observations.insert(id.clone(), next);
            self.title_wake.notify_one();
            self.publish(id, row.version);
        }
        Ok(())
    }
}
