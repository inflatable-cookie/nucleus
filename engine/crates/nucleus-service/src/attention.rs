//! One local read model for the board, next and native task rows.

use nucleus_core::{Host, Observed, Phase, RunState, WaitReason};
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

impl State {
    pub(super) fn task_attention(&self, row: &TaskRow) -> Result<TaskAttention, ServiceError> {
        let task = &row.task;
        if task.phase().is_terminal() {
            return Ok(TaskAttention::Finished);
        }
        let id = &task.identity().id;
        let wait = self.wait_reason(id);
        if self.has_open_usage_decision(task)?
            || (task.question().is_some() && task.operator_decline().is_none())
            || matches!(
                wait,
                Some(
                    WaitReason::Question
                        | WaitReason::Permission
                        | WaitReason::Input
                        | WaitReason::HostUnknown
                        | WaitReason::HostObservationBlocked
                )
            )
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
                    || (wait.is_none() && task.hold().is_none()))
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
        if task.hold().is_some() || task.operator_decline().is_some() {
            return Ok(TaskAttention::Waiting);
        }
        Ok(match task.phase() {
            Phase::Blocked | Phase::Error => TaskAttention::Attention,
            _ => TaskAttention::Waiting,
        })
    }

    pub(super) fn role_observation(&self, task: &nucleus_core::Task) -> Option<RunState> {
        let run = task
            .run()
            .filter(|run| !run.revoked() && run.report().is_none())?;
        let (instance, state) = self.role_observations.get(&task.identity().id)?;
        (instance == &run.launch().instance).then_some(*state)
    }
}

impl Service {
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
