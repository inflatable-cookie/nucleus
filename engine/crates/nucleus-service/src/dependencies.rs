use nucleus_core::{Authority, Entry, Phase, Task};
use nucleus_hosts::{NoticeHost, NoticeWrite, T3};
use nucleus_store::{Dependencies, DependencyEdit, StoreError, TaskRow};
use serde::{Deserialize, Serialize};

use crate::{ControllerScope, Service, ServiceError, State, event, schedule::Priority};

pub(super) fn checks_prerequisites(task: &Task) -> bool {
    !matches!(
        task.phase(),
        Phase::Done | Phase::Cancelled | Phase::Closing
    ) && task.run().is_none()
        && task.hold().is_none()
        && task.question().is_none()
}

const MAX_PREREQUISITES: usize = 100;
const MAX_REFERENCE_LENGTH: usize = 160;
const MAX_REASON_LENGTH: usize = 4000;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum DependencyCommand {
    SetDependencies {
        version: i64,
        depends_on: Vec<String>,
    },
    SetPrerequisiteWait {
        version: i64,
        waits_for: Vec<String>,
        reason: String,
    },
}

impl DependencyCommand {
    fn parts(&self) -> Result<(i64, &[String], Option<&str>), ServiceError> {
        let (version, references, reason) = match self {
            Self::SetDependencies {
                version,
                depends_on,
            } => (*version, depends_on, None),
            Self::SetPrerequisiteWait {
                version,
                waits_for,
                reason,
            } => {
                let reason = reason.trim();
                if reason.is_empty() || reason.chars().count() > MAX_REASON_LENGTH {
                    return Err(ServiceError::DependencyInput(
                        "prerequisite waits require a reason of 1 to 4000 characters".into(),
                    ));
                }
                (*version, waits_for, Some(reason))
            }
        };
        Ok((version, references, reason))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyState {
    Satisfied,
    Pending,
    Cancelled,
    Missing,
}

impl DependencyState {
    fn for_phase(phase: Phase) -> Self {
        match phase {
            Phase::Done => Self::Satisfied,
            Phase::Cancelled => Self::Cancelled,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyFact {
    pub task_id: String,
    pub reference: String,
    pub title: Option<String>,
    pub phase: Option<Phase>,
    pub status: DependencyState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrerequisiteWaitView {
    pub reason: String,
    pub released_at_ms: Option<i64>,
    pub prerequisites: Vec<DependencyFact>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    pub dependencies: Vec<DependencyFact>,
    pub prerequisite_wait: Option<PrerequisiteWaitView>,
    pub blocking: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEdits {
    pub set_dependencies: bool,
    pub set_prerequisite_wait: bool,
}

impl DependencyEdits {
    fn for_task(task: &Task, open_wait: bool) -> Self {
        let dispatched = task.dispatch_started();
        Self {
            set_dependencies: !dispatched
                && (task.phase() == Phase::Queued
                    || (task.identity().entry == Entry::ReviewEntry
                        && task.phase() == Phase::Reviewing
                        && task.question().is_none()
                        && task.verdict().is_none())),
            set_prerequisite_wait: dispatched
                && match task.phase() {
                    // The review can settle while an open wait still fences merge.
                    Phase::Merging => open_wait,
                    Phase::Queued | Phase::Closing | Phase::Done | Phase::Cancelled => false,
                    _ => true,
                },
        }
    }

    pub(super) fn read(
        state: &State,
        task: &Task,
        authority: Option<&Authority>,
        status: &DependencyStatus,
    ) -> Self {
        if authority.is_none_or(|actor| check_authority(state, task, actor).is_err()) {
            return Self::unavailable();
        }
        let mut edits = Self::for_task(
            task,
            status
                .prerequisite_wait
                .as_ref()
                .is_some_and(|wait| wait.released_at_ms.is_none()),
        );
        edits.set_dependencies &= status
            .dependencies
            .iter()
            .all(|fact| !fact.task_id.is_empty());
        if let Some(wait) = &status.prerequisite_wait {
            edits.set_prerequisite_wait &= wait
                .prerequisites
                .iter()
                .all(|fact| !fact.task_id.is_empty());
        }
        edits
    }

    pub(super) const fn unavailable() -> Self {
        Self {
            set_dependencies: false,
            set_prerequisite_wait: false,
        }
    }
}

impl DependencyStatus {
    pub(super) fn read(
        state: &State,
        row: &TaskRow,
        scope: &ControllerScope,
    ) -> Result<Self, ServiceError> {
        let id = &row.task.identity().id;
        let Dependencies {
            before_dispatch,
            wait,
        } = state.store.dependencies(id)?;
        let facts = |ids: Vec<String>| -> Result<Vec<_>, ServiceError> {
            ids.into_iter().map(|id| fact(state, id, scope)).collect()
        };
        let dependencies = facts(before_dispatch)?;
        let prerequisite_wait = wait
            .map(|wait| -> Result<_, ServiceError> {
                Ok(PrerequisiteWaitView {
                    reason: wait.reason,
                    released_at_ms: wait.released_at_ms,
                    prerequisites: facts(wait.ids)?,
                })
            })
            .transpose()?;
        Ok(Self {
            dependencies,
            prerequisite_wait,
            blocking: !matches!(
                row.task.phase(),
                Phase::Done | Phase::Cancelled | Phase::Closing
            ) && state.store.dependency_blocked(id)?,
        })
    }
}

fn fact(
    state: &State,
    id: String,
    scope: &ControllerScope,
) -> Result<DependencyFact, ServiceError> {
    let row = state.store.row(&id)?;
    Ok(match row {
        Some(row) => {
            let visible = scope.task(state, row.task.identity()).is_ok();
            let phase = row.task.phase();
            DependencyFact {
                reference: if visible {
                    row.reference().into_owned()
                } else {
                    String::new()
                },
                title: visible.then(|| crate::titles::brief(&row.task)),
                task_id: if visible { id } else { String::new() },
                phase: visible.then_some(phase),
                status: DependencyState::for_phase(phase),
            }
        }
        None => DependencyFact {
            reference: id.clone(),
            task_id: id,
            title: None,
            phase: None,
            status: DependencyState::Missing,
        },
    })
}

fn require_visible_dependencies(
    state: &State,
    scope: &ControllerScope,
    ids: &[String],
) -> Result<(), ServiceError> {
    for id in ids {
        if let Some(row) = state.store.row(id)? {
            scope.task(state, row.task.identity())?;
        }
    }
    Ok(())
}

fn check_authority(state: &State, task: &Task, authority: &Authority) -> Result<(), ServiceError> {
    match authority {
        Authority::Planner { actor } => state.check_planner_authority(task, actor),
        Authority::Operator { .. } => Ok(()),
    }
}

impl Service {
    pub(super) fn resolve_dependencies(
        &self,
        state: &State,
        identity: &nucleus_core::Identity,
        inputs: &[String],
        scope: &ControllerScope,
    ) -> Result<(Vec<String>, bool), ServiceError> {
        if inputs.len() > MAX_PREREQUISITES {
            return Err(ServiceError::DependencyInput(
                "at most 100 prerequisites are allowed".into(),
            ));
        }
        let mut blocked = false;
        let mut ids = Vec::with_capacity(inputs.len());
        for named in inputs {
            if named.is_empty() || named.chars().count() > MAX_REFERENCE_LENGTH {
                return Err(ServiceError::DependencyInput(
                    "prerequisites must have 1 to 160 characters".into(),
                ));
            }
            let missing = || {
                ServiceError::DependencyInput(format!(
                    "prerequisite task does not exist: {named}. Submit prerequisites first."
                ))
            };
            let id = if named.contains('#') {
                self.resolve_reference_in_state(state, named, scope, Some(&identity.repository))
                    .map_err(|error| match error {
                        ServiceError::TaskReferenceMissing => missing(),
                        error => error,
                    })?
            } else {
                named.clone()
            };
            if id == identity.id {
                return Err(ServiceError::DependencyInput(
                    "a task cannot depend on itself".into(),
                ));
            }
            let prerequisite = state.store.row(&id)?.ok_or_else(missing)?;
            self.task_scope(prerequisite.task.identity())?;
            scope.task(state, prerequisite.task.identity())?;
            blocked |= prerequisite.task.phase() != Phase::Done;
            ids.push(id);
        }
        ids.sort_unstable();
        if ids.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(ServiceError::DependencyInput(
                "duplicate prerequisite task IDs".into(),
            ));
        }
        Ok((ids, blocked))
    }

    pub(super) fn amended_dependencies(
        &self,
        state: &State,
        scope: &ControllerScope,
        prior: &Task,
        amended: &Task,
    ) -> Result<Option<Vec<String>>, ServiceError> {
        use nucleus_core::profiles::BriefPolicy;

        let before = BriefPolicy::parse(&prior.brief().text).unwrap_or_default();
        let after = BriefPolicy::parse(&amended.brief().text)?;
        if before.depends_on == after.depends_on {
            return Ok(None);
        }
        if !DependencyEdits::for_task(prior, false).set_dependencies {
            return Err(ServiceError::DependencyEdit(
                "dependencies can only change before dispatch begins",
            ));
        }
        require_visible_dependencies(
            state,
            scope,
            &state
                .store
                .dependencies(&prior.identity().id)?
                .before_dispatch,
        )?;
        let (ids, _) =
            self.resolve_dependencies(state, prior.identity(), &after.depends_on, scope)?;
        Ok(Some(ids))
    }

    /// Apply an owner dependency edit against the observed task version.
    ///
    /// # Errors
    /// Returns an error for invalid references, stale state or lost owner authority.
    pub async fn command_dependencies(
        &self,
        id: &str,
        authority: &Authority,
        command: DependencyCommand,
    ) -> Result<TaskRow, ServiceError> {
        self.command_dependencies_in_scope(
            id,
            authority,
            command,
            None,
            &ControllerScope::default(),
        )
        .await
    }

    pub(super) async fn command_dependencies_in_scope(
        &self,
        id: &str,
        authority: &Authority,
        command: DependencyCommand,
        session: Option<&crate::acp::WriteAccess>,
        scope: &ControllerScope,
    ) -> Result<TaskRow, ServiceError> {
        let fence = self.task_fence(id).await;
        let _fence = if session.is_some() {
            fence
                .try_lock_owned()
                .map_err(|_| ServiceError::EffectInProgress)?
        } else {
            fence.lock_owned().await
        };
        self.storage.database().verify()?;
        let mut state = self.state.lock().await;
        let mut row = self.lookup(&state, id)?;
        let task = &row.task;
        scope.task(&state, task.identity())?;
        if let Some(session) = session
            && crate::acp::writer_controller(&state, id, &session.credential)
                != Some(session.controller)
        {
            return Err(ServiceError::AcpUnauthorized);
        }
        let authority_check = check_authority(&state, task, authority);
        if matches!(authority_check, Err(ServiceError::PlannerAuthorityUnknown)) {
            self.request_planner_check(&mut state, task);
        }
        authority_check?;
        let (version, named, reason) = command.parts()?;
        if row.version != version {
            return Err(StoreError::StaleTask.into());
        }
        let prior = state.store.dependencies(id)?;
        let edits = DependencyEdits::for_task(
            task,
            prior
                .wait
                .as_ref()
                .is_some_and(|wait| wait.released_at_ms.is_none()),
        );
        match reason {
            None if !edits.set_dependencies => {
                return Err(ServiceError::DependencyEdit(
                    "dependencies can only change before dispatch begins",
                ));
            }
            Some(_) if !edits.set_prerequisite_wait => {
                return Err(ServiceError::DependencyEdit(
                    "prerequisite waits require a dispatched, unmerged task before merge intent",
                ));
            }
            _ => {}
        }
        let current_ids = if reason.is_some() {
            prior
                .wait
                .as_ref()
                .map_or(&[][..], |wait| wait.ids.as_slice())
        } else {
            &prior.before_dispatch
        };
        require_visible_dependencies(&state, scope, current_ids)?;
        let (ids, _) = self.resolve_dependencies(&state, task.identity(), named, scope)?;
        let (kind, edit) = match reason {
            None if ids == prior.before_dispatch => return Ok(row),
            None => ("dependencies_changed", DependencyEdit::BeforeDispatch(&ids)),
            Some(reason) => {
                let unchanged = prior.wait.as_ref().map_or(ids.is_empty(), |wait| {
                    wait.released_at_ms.is_none() && wait.ids == ids && wait.reason == reason
                });
                if unchanged {
                    return Ok(row);
                }
                let kind = if ids.is_empty() {
                    "prerequisite_wait_cleared"
                } else {
                    "prerequisite_wait_set"
                };
                (kind, DependencyEdit::Wait { ids: &ids, reason })
            }
        };
        let mut audit = event(kind);
        audit.detail = serde_json::json!({
            "actor": crate::planning::stamp(authority).actor,
            "previous": if reason.is_some() { prior.wait.as_ref().map(|wait| &wait.ids) } else { Some(&prior.before_dispatch) },
            "prerequisites": ids,
            "reason": reason,
        }).to_string();
        row.version = state.edit_board_dependency(task, |store, clock| {
            store.edit_dependencies(id, version, edit, &audit, clock)
        })?;
        self.desire_title(&state, task, row.number);
        self.wake_task(&mut state, id, row.version, Priority::Wake);
        Ok(row)
    }

    /// Release at most once. A release wakes normal handling and changes no run,
    /// question, approval or hold.
    pub(super) async fn reconcile_prerequisites(
        &self,
        row: &TaskRow,
    ) -> Result<bool, ServiceError> {
        if row.task.phase().is_terminal() {
            return Ok(false);
        }
        let id = &row.task.identity().id;
        let state = self.state.lock().await;
        let Some(wait) = state
            .store
            .dependencies(id)?
            .wait
            .filter(|wait| wait.released_at_ms.is_none())
        else {
            return Ok(false);
        };
        for id in &wait.ids {
            if state
                .store
                .row(id)?
                .is_none_or(|row| row.task.phase() != Phase::Done)
            {
                return Ok(false);
            }
        }
        let mut audit = event("prerequisite_wait_released");
        audit.detail =
            serde_json::json!({ "prerequisites": wait.ids, "reason": wait.reason }).to_string();
        drop(state);
        let _fence = self.effect(row).await?;
        let mut state = self.state.lock().await;
        let version = state.edit_board_dependency(&row.task, |store, clock| {
            store.edit_dependencies(id, row.version, DependencyEdit::ReleaseWait, &audit, clock)
        })?;
        self.desire_title(&state, &row.task, row.number);
        self.wake_task(&mut state, id, version, Priority::Wake);
        Ok(true)
    }

    /// Deliver the informational notice, returning whether it remains pending.
    pub(super) async fn notify_prerequisite_release(
        &self,
        row: &TaskRow,
    ) -> Result<bool, ServiceError> {
        let task = &row.task;
        let id = &task.identity().id;
        let pending = self
            .state
            .lock()
            .await
            .store
            .pending_prerequisite_notice(id)?;
        let Some((version, release)) = pending else {
            return Ok(false);
        };
        let _fence = self.effect(row).await?;
        let Some(thread) = self.planner_notice_target(task).await? else {
            return Ok(true);
        };
        let command = format!("task-{id}-prerequisite-release-{version}");
        let text = format!(
            "Nucleus prerequisite wait cleared for {}\nReason: {}\nCompleted prerequisites: {}",
            row.reference(),
            release.reason,
            release.prerequisites.len(),
        );
        let mut attempt = T3::prepare_notice(thread.clone(), command.clone(), &text)?;
        let Some((authorization, _permit)) = self.prepare_planner_notice(row, &attempt).await?
        else {
            return Ok(true);
        };
        let dispatch = authorization.record(&mut attempt)?;
        let mut audit = event("prerequisite_notice_intent");
        audit.detail = serde_json::json!({ "command": command, "recipient": thread }).to_string();
        let claimed = self
            .state
            .lock()
            .await
            .store
            .claim_prerequisite_notice(id, version, &audit)?;
        if claimed {
            self.publish(id, row.version);
            // The recorded attempt fences unknown delivery across retries and restarts.
            let send = self.host.deliver_notice(NoticeWrite::Queue(dispatch)).await;
            if matches!(send, Err(nucleus_hosts::HostError::Deferred { .. })) {
                let mut outcome = event("prerequisite_notice_not_sent");
                outcome.detail.clone_from(&audit.detail);
                self.state
                    .lock()
                    .await
                    .store
                    .defer_prerequisite_notice(id, version, &audit, &outcome)?;
            }
            send?;
        }
        Ok(self
            .state
            .lock()
            .await
            .store
            .pending_prerequisite_notice(id)?
            .is_some())
    }

    pub(super) async fn dependencies_blocked(&self, row: &TaskRow) -> Result<bool, ServiceError> {
        let state = self.state.lock().await;
        Ok(state.store.dependency_blocked(&row.task.identity().id)?)
    }

    pub(super) fn wake_dependents(&self, state: &mut State, id: &str) {
        let Ok(dependents) = state.store.dependents(id) else {
            // A parked dependency gets a periodic recheck if the wake query fails.
            return;
        };
        for (dependent, version) in dependents {
            self.wake_task(state, &dependent, version, Priority::Wake);
        }
    }
}
