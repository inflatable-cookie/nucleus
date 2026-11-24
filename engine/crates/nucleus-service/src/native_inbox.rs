//! Native operator forms are a projection of ordinary planning decisions.

use std::{
    collections::BTreeSet,
    env,
    path::{Path, PathBuf},
};

use nucleus_core::{
    Action, Authority, WaitReason,
    acp::{InboxAnswer, InboxChoice, InboxForm, InboxSnapshot, inbox_field},
};
use nucleus_hosts::{HostError, INBOX_THREAD, InboxStep, InboxTarget, T3_RETRY_DELAY};
use nucleus_store::{
    EngineStorage, StoreError, TaskRow,
    planning::{
        Decision, DecisionAnswerInput, DecisionInput, DecisionOption, DecisionTarget, WriteAt,
    },
};
use subtle::ConstantTimeEq;
use tokio::{
    sync::{Notify, watch},
    time::Instant,
};

use crate::{Service, ServiceError, State, now_ms};

const INBOX_DIRECTORY: &str = "acp-inbox";
const ENGINE: &str = "Nucleus";
const ACCEPT: &str = "accept";
const DECLINE: &str = "decline";

pub(super) struct NativeInbox {
    credential: [u8; 32],
    root: String,
    legacy: Option<String>,
    observed: watch::Sender<Observation>,
    reconcile: Notify,
}

#[derive(PartialEq, Eq)]
pub(super) enum Observation {
    Unknown,
    Inactive,
    Pinned(BTreeSet<String>),
}

/// The dedicated native project root and ACP binding identity for this engine.
#[must_use]
pub fn native_inbox_directory(storage: &EngineStorage) -> PathBuf {
    storage.database().path().join(INBOX_DIRECTORY)
}

impl NativeInbox {
    pub(super) fn configured(service: &Service) -> Result<Option<Self>, ServiceError> {
        let Some(enabled) = env::var_os("NUCLEUS_RUST_NATIVE_INBOX") else {
            return Ok(None);
        };
        match enabled.to_str() {
            Some("0") => return Ok(None),
            Some("1") => {}
            _ => return Err(ServiceError::InboxConfiguration),
        }
        let legacy = env::var_os("NUCLEUS_RUST_LEGACY_INBOX_THREAD")
            .map(|id| {
                id.into_string()
                    .map_err(|_| ServiceError::InboxConfiguration)
            })
            .transpose()?;
        if service.project.acp_provider.is_none()
            || (service.inbox.is_some() && legacy.is_none())
            || legacy.as_ref().is_some_and(|id| {
                !id.starts_with("thread:")
                    || id == INBOX_THREAD
                    || id.len() > 200
                    || !id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b":-_".contains(&byte))
            })
        {
            return Err(ServiceError::InboxConfiguration);
        }
        Self::open(service, legacy).map(Some)
    }

    pub(super) fn open(service: &Service, legacy: Option<String>) -> Result<Self, ServiceError> {
        let storage = service.storage.database();
        storage.ensure_child(Path::new(INBOX_DIRECTORY))?;
        let root = native_inbox_directory(&service.storage);
        let credential = service.ensure_inbox_binding(&root)?;
        Ok(Self {
            credential,
            root: root
                .into_os_string()
                .into_string()
                .map_err(|_| ServiceError::AcpBinding)?,
            legacy,
            observed: watch::channel(Observation::Unknown).0,
            reconcile: Notify::new(),
        })
    }

    pub(super) fn matches_thread(&self, thread: &str) -> bool {
        thread == INBOX_THREAD || self.legacy.as_deref() == Some(thread)
    }

    pub(super) fn unobserved(&self) {
        self.set_observation(Observation::Unknown);
    }

    pub(super) fn wake(&self) {
        self.reconcile.notify_one();
    }

    pub(super) fn changes(&self) -> watch::Receiver<Observation> {
        self.observed.subscribe()
    }

    fn set_observation(&self, snapshot: Observation) {
        self.observed.send_if_modified(|prior| {
            if *prior == snapshot {
                return false;
            }
            *prior = snapshot;
            true
        });
    }
}

impl Service {
    pub(super) fn inbox_health(&self) -> serde_json::Value {
        serde_json::json!({
            "enabled": self.native_inbox.is_some(),
            "observed": self.native_inbox.as_ref().is_some_and(|inbox| matches!(
                &*inbox.observed.borrow(), Observation::Pinned(_)
            )),
            "threadId": INBOX_THREAD
        })
    }

    pub(super) fn inbox_changed(&self) {
        if let Some(inbox) = &self.native_inbox {
            inbox.observed.send_modify(|_| {});
            inbox.wake();
        }
    }

    pub(super) fn inbox_session(
        &self,
        credential: &[u8; 32],
    ) -> Result<&NativeInbox, ServiceError> {
        let inbox = self
            .native_inbox
            .as_ref()
            .filter(|inbox| bool::from(inbox.credential.ct_eq(credential)))
            .ok_or(ServiceError::AcpUnauthorized)?;
        self.storage.database().verify()?;
        Ok(inbox)
    }

    pub(super) async fn inbox_snapshot(
        &self,
        credential: &[u8; 32],
    ) -> Result<InboxSnapshot, ServiceError> {
        let inbox = self.inbox_session(credential)?;
        let state = self.state.lock().await;
        let observed = inbox.observed.borrow();
        if *observed == Observation::Inactive {
            return Ok(InboxSnapshot {
                pending: Vec::new(),
            });
        }
        let decisions = pending(&state, self)?;
        Ok(InboxSnapshot {
            pending: decisions
                .into_iter()
                .map(|decision| {
                    let field = inbox_field(&decision.project_id, &decision.id);
                    InboxForm {
                        offer: matches!(&*observed, Observation::Pinned(present) if !present.contains(&field)),
                        field,
                        question: decision.input.question,
                        choices: decision
                            .input
                            .options
                            .into_iter()
                            .map(|option| InboxChoice {
                                id: option.id,
                                label: option.label,
                            })
                            .collect(),
                    }
                })
                .collect(),
        })
    }

    pub(super) async fn answer_inbox(
        &self,
        credential: &[u8; 32],
        answer: InboxAnswer,
    ) -> Result<(), ServiceError> {
        let inbox = self.inbox_session(credential)?;
        let mut state = self.state.lock().await;
        if !matches!(&*inbox.observed.borrow(), Observation::Pinned(_)) {
            return Err(ServiceError::InboxUnavailable {
                until: Instant::now() + T3_RETRY_DELAY,
            });
        }
        let decision = pending(&state, self)?
            .into_iter()
            .find(|decision| inbox_field(&decision.project_id, &decision.id) == answer.field)
            .ok_or(StoreError::PlanningConflict)?;
        let authority = Authority::Operator {
            actor: format!("operator (T3 Inbox on {})", self.host.endpoint()),
        };
        self.record_decision_answer(
            &mut state,
            &decision.project_id,
            &decision.id,
            DecisionAnswerInput {
                option_id: answer.option_id,
                note: None,
            },
            &authority,
        )?;
        Ok(())
    }

    pub(super) async fn watch_inbox(&self) {
        let (Some(inbox), Some(provider)) = (
            self.native_inbox.as_ref(),
            self.project.acp_provider.as_deref(),
        ) else {
            return;
        };
        let target = InboxTarget {
            root: &inbox.root,
            provider,
            legacy: inbox.legacy.as_deref(),
        };
        loop {
            let retry = match self.reconcile_inbox(inbox, &target).await {
                Ok(()) => None,
                Err(error) => {
                    inbox.unobserved();
                    eprintln!("Nucleus Inbox: {error}");
                    Some(match error {
                        ServiceError::Host(HostError::Deferred { until }) => until,
                        _ => Instant::now() + T3_RETRY_DELAY,
                    })
                }
            };
            tokio::select! {
                () = inbox.reconcile.notified() => {}
                () = async {
                    if let Some(until) = retry {
                        tokio::time::sleep_until(until).await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => {}
            }
        }
    }

    async fn reconcile_inbox(
        &self,
        inbox: &NativeInbox,
        target: &InboxTarget<'_>,
    ) -> Result<(), ServiceError> {
        self.storage.database().verify()?;
        let fields = {
            let state = self.state.lock().await;
            pending(&state, self)?
                .into_iter()
                .map(|decision| inbox_field(&decision.project_id, &decision.id))
                .collect()
        };
        match self.host.prepare_inbox(target, &fields).await? {
            InboxStep::Wait => inbox.set_observation(Observation::Inactive),
            InboxStep::Ready(present) => inbox.set_observation(Observation::Pinned(present)),
            InboxStep::Write(write) => {
                self.storage.database().verify()?;
                self.host.write_inbox(write).await?;
            }
            InboxStep::Wake(write) => {
                self.storage.database().verify()?;
                // ACP can attach before T3 publishes the new turn. It needs the
                // exact pin proof before dispatch, while the Inbox is still idle.
                inbox.set_observation(Observation::Pinned(BTreeSet::new()));
                self.host.write_inbox(write).await?;
            }
        }
        Ok(())
    }

    pub(super) async fn native_task_decision(&self, row: &TaskRow) -> Result<Action, ServiceError> {
        let waiting = Action::Wait(WaitReason::Question);
        let Some(head) = row.task.operator_question() else {
            return Ok(waiting);
        };
        let target = task_target(row);
        let decision = {
            let mut state = self.state.lock().await;
            let project = state.settings.planning_project_id(&self.project).to_owned();
            if let Some(decision) = state.store.task_decision(&project, &target)? {
                decision
            } else {
                let decision = state.store.ensure_task_decision(
                    &project,
                    target,
                    DecisionInput {
                        question: format!(
                            "Accept the external merge for {} at {head}?",
                            super::inbox::reference(row)
                        ),
                        options: vec![
                            DecisionOption {
                                id: ACCEPT.into(),
                                label: "Accept merge".into(),
                            },
                            DecisionOption {
                                id: DECLINE.into(),
                                label: "Decline".into(),
                            },
                        ],
                    },
                    engine_stamp(),
                )?;
                self.inbox_changed();
                decision
            }
        };
        let Some(answer) = decision.answer else {
            return Ok(waiting);
        };
        let reason = answer
            .input
            .note
            .filter(|note| !note.trim().is_empty())
            .unwrap_or_else(|| "Accept merge in Nucleus Inbox".into());
        self.apply_operator_answer(
            row,
            answer.author,
            reason,
            answer.input.option_id == DECLINE,
        )
        .await
    }

    pub(super) fn retire_native_decision(&self, state: &mut State, row: &TaskRow) {
        if self.native_inbox.is_none() || row.task.operator_question().is_none() {
            return;
        }
        let project = state.settings.planning_project_id(&self.project);
        if let Err(error) =
            state
                .store
                .withdraw_task_decision(project, &task_target(row), engine_stamp())
        {
            // The old row version is already fenced by the shared pending and answer paths.
            eprintln!("{}: {error}", row.task.identity().id);
        }
        self.inbox_changed();
    }
}

fn pending(state: &State, service: &Service) -> Result<Vec<Decision>, StoreError> {
    let mut decisions = Vec::new();
    for project in state.settings.planning_projects(&service.project) {
        decisions.extend(state.store.decisions(project, true)?);
    }
    Ok(decisions)
}

fn engine_stamp() -> WriteAt<'static> {
    WriteAt {
        actor: ENGINE,
        at_ms: now_ms(),
    }
}

fn task_target(row: &TaskRow) -> DecisionTarget {
    DecisionTarget {
        task_id: row.task.identity().id.clone(),
        task_version: row.version,
    }
}

#[cfg(test)]
mod tests;
