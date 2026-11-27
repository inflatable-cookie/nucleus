use std::{
    fs::{File, symlink_metadata},
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use crate::{ControllerScope, Service, ServiceError, State, pass::DispatchTarget};
use nucleus_core::{
    Authority, Phase, Task, WaitReason,
    acp::{Binding, InboxBinding, session_id},
};
use nucleus_hosts::{FrozenParentWrite, HostError, ParentSendError, ParentWrite, T3_RETRY_DELAY};
use nucleus_store::{AcpSession, DispatchMode, ParentDelivery, ParentResult, StoreError, TaskRow};
use rustix::fs::{Mode, OFlags, open};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const BINDINGS: &str = "acp-bindings";
const SESSION_SCRATCH: &str = "acp-scratch";
const GROUP_OR_OTHER_PERMISSIONS: u32 = 0o077;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MintedSession {
    pub session_id: String,
    pub binding_path: PathBuf,
}

#[derive(Clone)]
pub(super) struct WriteAccess {
    pub credential: [u8; 32],
    pub controller: [u8; 32],
}

pub(super) fn run_hold_deadline(row: &TaskRow) -> Option<u64> {
    let run = row
        .task
        .run()
        .filter(|run| run.report_reminder_for().is_none())?;
    Some(
        run.last_send_at_ms()
            .unwrap_or(run.launch().started_at)
            .saturating_add(nucleus_hosts::LATE_REPLY_MS),
    )
}

pub(super) fn parent_due(record: &ParentDelivery) -> Result<(), ServiceError> {
    if record.result == ParentResult::Pending && record.due_ms > ms(crate::now_ms()) {
        return Err(parent_delivery_retry(HostError::Uncertain, record.due_ms));
    }
    Ok(())
}

pub(super) fn parent_delivery_retry(source: HostError, due_ms: i64) -> ServiceError {
    let remaining = due_ms.saturating_sub(ms(crate::now_ms())).max(0);
    let until =
        tokio::time::Instant::now() + std::time::Duration::from_millis(remaining.unsigned_abs());
    let until = match source {
        HostError::Deferred { until: deferred } => until.max(deferred),
        _ => until,
    };
    ServiceError::ParentRetry { source, until }
}

pub(super) fn ms(timestamp: u64) -> i64 {
    i64::try_from(timestamp).unwrap_or(i64::MAX)
}

fn retry_ms() -> i64 {
    ms(crate::now_ms()
        .saturating_add(u64::try_from(T3_RETRY_DELAY.as_millis()).unwrap_or(u64::MAX)))
}

pub(super) const PARENT_START_TIMEOUT_MS: u64 = 30_000;

pub(super) fn frozen_parent(
    record: &ParentDelivery,
) -> Result<Option<FrozenParentWrite>, StoreError> {
    Ok(record
        .wire
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?)
}

pub(super) fn wants_parent_hold(
    row: &TaskRow,
    dispatch: DispatchMode,
    preparing_launch: bool,
    active_role: bool,
    now: u64,
) -> bool {
    let task = &row.task;
    !task.phase().is_terminal()
        && task.hold().is_none()
        && task.operator_decline().is_none()
        && dispatch != DispatchMode::Stopped
        && (active_role
            || preparing_launch
            || task.run().is_some_and(|run| {
                !run.revoked()
                    && run.report().is_none()
                    && run.report_reminder_for().is_none()
                    && (run.last_send_at_ms().is_none()
                        || run_hold_deadline(row).is_some_and(|deadline| now < deadline))
            }))
}

impl Service {
    pub(super) fn active_parent_role(&self, task: &Task, checkout: &Path) -> bool {
        crate::task_rows::visibility_roles(task)
            .into_iter()
            .any(|thread| self.host.parent_role_active(thread, checkout))
    }

    pub(super) fn acp_turn_view(
        &self,
        state: &State,
        row: &TaskRow,
    ) -> Result<(Option<String>, bool), ServiceError> {
        let task = &row.task;
        let id = &task.identity().id;
        let checkout = nucleus_work::checkout_path(
            self.storage.work().path(),
            &task.identity().repository,
            id,
        );
        let delivery = state.store.current_parent_hold(id)?;
        let frozen = delivery.as_ref().map(frozen_parent).transpose()?.flatten();
        // Delegation needs a live run and node before its role reservation can be frozen.
        let preparing = delivery.as_ref().is_some_and(|record| {
            record.version == row.version
                && task.run().is_none()
                && matches!(task.phase(), Phase::Working | Phase::Reviewing)
                && frozen
                    .as_ref()
                    .and_then(FrozenParentWrite::checkpoint)
                    .map_or_else(
                        || state.wait_reason(id) == Some(WaitReason::Starting),
                        |checkpoint| checkpoint.preparing_launch,
                    )
                && state.dispatch_mode().allows_launch(task.first_launch())
        });
        let active_role = self.active_parent_role(task, &checkout);
        // Keep an attached turn through shell startup. New writes still require
        // the synchronized shell, and a stored prompt keeps its exact identity.
        let restoring = state.registry_mode
            && !self.host.projects_synchronized()
            && !crate::task_rows::visibility_roles(task).is_empty();
        let wanted = wants_parent_hold(
            row,
            state.dispatch_mode(),
            preparing,
            active_role || restoring,
            crate::now_ms(),
        );
        if !wanted {
            return Ok((None, false));
        }
        let prompt = delivery.map(|record| {
            frozen
                .as_ref()
                .and_then(FrozenParentWrite::prompt)
                .map_or_else(
                    || {
                        record.legacy_prompt.unwrap_or_else(|| {
                            nucleus_core::acp::legacy_parent_hold_prompt(&record.command)
                        })
                    },
                    str::to_owned,
                )
        });
        // The compatibility carry applies to an attached turn without a stored
        // prompt. A pre-wire refusal alone cannot keep that turn open.
        let carry = prompt.is_none()
            && (active_role
                || !matches!(
                    state.wait_detail(id),
                    Some(crate::WaitDetail::BeforeSend(_))
                ));
        Ok((prompt, carry))
    }

    pub(super) async fn deliver_parent(
        &self,
        row: &TaskRow,
        mut write: ParentWrite,
        prior: Option<ParentDelivery>,
        refresh: bool,
    ) -> Result<bool, ServiceError> {
        let existing = prior
            .filter(|record| record.command == write.command_id().unwrap_or_default() || refresh);
        let preparing = write
            .freeze()
            .checkpoint()
            .is_some_and(|value| value.preparing_launch);
        if let Some(record) = &existing {
            if record.result == ParentResult::Accepted {
                return Ok(false);
            }
            parent_due(record)?;
            if let Some(wire) = &record.wire {
                write.use_frozen(serde_json::from_str(wire).map_err(StoreError::from)?)?;
            } else if write.starts_turn() {
                let prompt = record.legacy_prompt.clone().unwrap_or_else(|| {
                    if record.refresh {
                        nucleus_core::acp::REFRESH_TASK_ROW.to_owned()
                    } else {
                        nucleus_core::acp::legacy_parent_hold_prompt(&record.command)
                    }
                });
                write.use_legacy_intent(&record.command, &prompt)?;
            }
        }
        let command = write.command_id().ok_or(ServiceError::Input)?.to_owned();
        if existing
            .as_ref()
            .is_some_and(|record| record.command != command)
        {
            return Err(HostError::Binding.into());
        }
        // Record the wire and deadline before sending. A restart or transport
        // error can replay this exact command against T3's durable receipt.
        let attempt = if write.starts_turn() {
            Some(
                self.begin_parent_delivery(row, &write, refresh, existing)
                    .await?,
            )
        } else {
            None
        };
        let result = self.write_parent(row, write, refresh, preparing).await;
        match (result, attempt) {
            (Ok(()), record) => {
                if let Some((record, _)) = record {
                    let start_deadline = if refresh {
                        0
                    } else {
                        ms(crate::now_ms().saturating_add(PARENT_START_TIMEOUT_MS))
                    };
                    self.finish_parent_delivery(
                        row,
                        &record,
                        ParentResult::Accepted,
                        start_deadline,
                    )
                    .await?;
                }
                Ok(true)
            }
            (
                Err(error @ (ParentSendError::Rejected | ParentSendError::InitialMessageRejected)),
                Some((record, mut frozen)),
            ) => {
                self.retry_rejected_parent(
                    row,
                    &record,
                    &mut frozen,
                    matches!(error, ParentSendError::InitialMessageRejected),
                )
                .await
            }
            (
                Err(ParentSendError::Unknown(error) | ParentSendError::NotSent(error)),
                Some((record, _)),
            ) => Err(parent_delivery_retry(error, record.due_ms)),
            (Err(ParentSendError::Unknown(error)), None) => Err(error.into()),
            (Err(ParentSendError::NotSent(error)), None) => Err(self.parent_not_sent(error)),
            (Err(ParentSendError::Rejected | ParentSendError::InitialMessageRejected), None) => {
                Err(HostError::ParentHoldRejected.into())
            }
        }
    }

    async fn retry_rejected_parent(
        &self,
        row: &TaskRow,
        record: &ParentDelivery,
        frozen: &mut FrozenParentWrite,
        initial_message: bool,
    ) -> Result<bool, ServiceError> {
        let id = &row.task.identity().id;
        let command = frozen
            .replace_rejected_command(initial_message)
            .ok_or(ServiceError::Input)?;
        let wire = serde_json::to_string(frozen).map_err(StoreError::from)?;
        let due = retry_ms();
        let state = self.state.lock().await;
        state
            .store
            .retry_parent_delivery(id, row.version, record, &command, &wire, due)?;
        Err(parent_delivery_retry(HostError::ParentHoldRejected, due))
    }

    async fn write_parent(
        &self,
        row: &TaskRow,
        write: ParentWrite,
        refresh: bool,
        preparing: bool,
    ) -> Result<(), ParentSendError> {
        let id = &row.task.identity().id;
        let starts_turn = write.starts_turn();
        let checkout = PathBuf::from(&write.binding().worktree_path);
        let mut journal = self.delivery_snooze_journal(Some(id));
        let result = self
            .host
            .write_parent(write, |update| {
                if refresh && update.is_none() {
                    return Ok(());
                }
                journal.authorize(update, |state| {
                    let dispatch = state.dispatch_mode();
                    if !refresh
                        && (!self.lookup(state, id).is_ok_and(|fresh| fresh == *row)
                            || dispatch == DispatchMode::Stopped
                            || starts_turn
                                && !wants_parent_hold(
                                    row,
                                    dispatch,
                                    preparing && dispatch.allows_launch(row.task.first_launch()),
                                    self.active_parent_role(&row.task, &checkout),
                                    crate::now_ms(),
                                ))
                    {
                        return Err(HostError::Uncertain);
                    }
                    Ok(())
                })
            })
            .await;
        journal.settle().await;
        result
    }

    async fn begin_parent_delivery(
        &self,
        row: &TaskRow,
        write: &ParentWrite,
        refresh: bool,
        existing: Option<ParentDelivery>,
    ) -> Result<(ParentDelivery, FrozenParentWrite), ServiceError> {
        let id = &row.task.identity().id;
        let command = write.command_id().ok_or(ServiceError::Input)?.to_owned();
        let frozen = write.freeze().clone();
        let wire = serde_json::to_string(&frozen).map_err(StoreError::from)?;
        let due_ms = retry_ms();
        let mut state = self.state.lock().await;
        let mut record = if let Some(record) = existing {
            state
                .store
                .retry_parent_delivery(id, row.version, &record, &command, &wire, due_ms)?;
            record
        } else {
            let record = ParentDelivery {
                version: row.version,
                command,
                refresh,
                wire: Some(wire),
                legacy_prompt: None,
                due_ms,
                result: ParentResult::Pending,
            };
            if !state.store.freeze_parent_delivery(id, &record)? {
                return Err(StoreError::StaleTask.into());
            }
            if !refresh && row.task.run().is_none() {
                state.observe_wait(&row.task, Some(WaitReason::Starting))?;
                self.publish(id, row.version);
            } else {
                self.publish_detail(id, row.version);
            }
            record
        };
        record.due_ms = due_ms;
        Ok((record, frozen))
    }

    pub(super) async fn finish_parent_delivery(
        &self,
        row: &TaskRow,
        record: &ParentDelivery,
        result: ParentResult,
        due_ms: i64,
    ) -> Result<(), ServiceError> {
        self.state.lock().await.store.finish_parent_delivery(
            &row.task.identity().id,
            row.version,
            record,
            result,
            due_ms,
        )?;
        Ok(())
    }

    pub(super) fn parent_not_sent(&self, reason: impl std::fmt::Display) -> ServiceError {
        ServiceError::ParentNotSent {
            reason: reason.to_string(),
            retry_at: self.host.request_retry_at(),
        }
    }

    pub(super) async fn queue_acp_refresh(&self, id: &str) -> Result<bool, ServiceError> {
        let mut state = self.state.lock().await;
        let row = self.lookup(&state, id)?;
        if row.task.phase().is_terminal() || row.task.run().is_some() {
            return Ok(false);
        }
        state.acp_refresh_requests.insert(id.into(), row.version);
        self.wake_task(
            &mut state,
            id,
            row.version,
            crate::schedule::Priority::Effect,
        );
        Ok(true)
    }

    pub(super) async fn refresh_acp_if_requested(&self, row: &TaskRow) -> Result<(), ServiceError> {
        let id = &row.task.identity().id;
        let refresh = {
            let mut state = self.state.lock().await;
            state.planner_notice_waiters.remove(id);
            state.acp_refresh_requests.remove(id) == Some(row.version)
                || state
                    .store
                    .parent_deliveries(id, row.version)?
                    .iter()
                    .any(|value| value.refresh && value.result == ParentResult::Pending)
        };
        if refresh && let Err(error) = self.refresh_acp_parent(row).await {
            if matches!(error, ServiceError::ParentNotSent { .. }) {
                let mut state = self.state.lock().await;
                if self.lookup(&state, id)?.version == row.version {
                    state.acp_refresh_requests.insert(id.into(), row.version);
                }
            }
            return Err(error);
        }
        Ok(())
    }

    pub(super) async fn refresh_acp_parent(&self, row: &TaskRow) -> Result<bool, ServiceError> {
        let task = &row.task;
        if task.phase().is_terminal() || task.run().is_some() {
            return Ok(false);
        }
        let _fence = self.effect(row).await?;
        let provider = self.acp_provider().ok_or(ServiceError::AcpBinding)?;
        let identity = task.identity();
        let id = &identity.id;
        let prior = self
            .state
            .lock()
            .await
            .store
            .parent_deliveries(id, row.version)?
            .into_iter()
            .find(|value| value.refresh);
        if let Some(record) = &prior {
            if record.result == ParentResult::Accepted {
                return Ok(false);
            }
            parent_due(record)?;
        }
        let route = self.project_for(identity).await?;
        let work = self.worktrees();
        let checkout = work.registered(&route.checkout, &identity.repository, id)?;
        let binding = route.binding(&checkout)?;
        let Some(write) = self
            .host
            .prepare_parent_refresh(&binding, provider)
            .await
            .map_err(|error| self.parent_not_sent(error))?
        else {
            return Ok(false);
        };
        let Some(_permit) = self
            .dispatch_gate(
                task,
                DispatchTarget::Run {
                    frozen: write.binding(),
                    checkout: &checkout,
                    launch: false,
                },
            )
            .await?
        else {
            return Ok(false);
        };
        self.ensure_parent_reader(id, checkout.path()).await?;
        self.deliver_parent(row, write, prior, true).await
    }

    pub(super) async fn bind_acp(
        &self,
        task: &str,
        controller: [u8; 32],
        authority: &Authority,
        scope: &ControllerScope,
        read_only: bool,
    ) -> Result<MintedSession, ServiceError> {
        let mut state = self.state.lock().await;
        let row = self.lookup(&state, task)?;
        scope.task(&state, row.task.identity())?;
        if !read_only
            && row.task.phase() != Phase::Done
            && let Authority::Planner { actor } = authority
        {
            let check = state.check_planner_authority(&row.task, actor);
            if matches!(check, Err(ServiceError::PlannerAuthorityUnknown)) {
                self.request_planner_check(&mut state, &row.task);
            }
            check?;
        }
        self.resolve_project(&state, row.task.identity())?;
        let checkout = nucleus_work::checkout_path(
            self.storage.work().path(),
            &row.task.identity().repository,
            task,
        );
        let command_credential = if read_only || row.task.phase() == Phase::Done {
            None
        } else {
            Some(random_key()?)
        };
        let (session_id, binding_path, scratch_dir) = self.acp_paths(&checkout)?;
        let binding = Binding {
            session_id: session_id.clone(),
            task_id: task.into(),
            endpoint: self.callback,
            credential: random_key()?,
            command_credential,
            scratch_dir: Some(scratch_dir),
        };
        write_binding(&state, &binding_path, &binding, Some(controller))?;
        self.publish(task, row.version);
        Ok(MintedSession {
            session_id,
            binding_path,
        })
    }

    pub(super) async fn ensure_parent_reader(
        &self,
        task: &str,
        checkout: &Path,
    ) -> Result<(), ServiceError> {
        let state = self.state.lock().await;
        let _ = self.lookup(&state, task)?;
        let (session_id, binding_path, scratch_dir) = self.acp_paths(checkout)?;
        if let Some(verifier) = state.store.acp_session(task)?
            && let Some(mut binding) = existing_binding::<Binding>(&binding_path)?
        {
            if binding.task_id != task
                || binding.session_id != session_id
                || !bool::from(verifier.reader.ct_eq(&digest(&binding.credential)))
            {
                return Err(ServiceError::AcpBinding);
            }
            if binding.scratch_dir.as_ref() != Some(&scratch_dir)
                || binding.endpoint != self.callback
            {
                binding.scratch_dir = Some(scratch_dir);
                binding.endpoint = self.callback;
                write_binding(&state, &binding_path, &binding, None)?;
            }
            return Ok(());
        }
        write_binding(
            &state,
            &binding_path,
            &Binding {
                session_id,
                task_id: task.into(),
                endpoint: self.callback,
                credential: random_key()?,
                command_credential: None,
                scratch_dir: Some(scratch_dir),
            },
            Some([0; 32]),
        )
    }

    fn acp_paths(&self, checkout: &Path) -> Result<(String, PathBuf, PathBuf), ServiceError> {
        let session_id = session_id(checkout);
        let root = self.storage.database();
        let relative_scratch = Path::new(SESSION_SCRATCH).join(&session_id);
        let scratch = root.path().join(&relative_scratch);
        if scratch.starts_with(checkout) || scratch.starts_with(self.storage.scratch().path()) {
            return Err(ServiceError::AcpBinding);
        }
        root.ensure_child(&relative_scratch)?;
        let binding_path = self.acp_binding_path(&session_id)?;
        Ok((session_id, binding_path, scratch))
    }

    fn acp_binding_path(&self, session_id: &str) -> Result<PathBuf, ServiceError> {
        let root = self.storage.database();
        root.ensure_child(Path::new(BINDINGS))?;
        let directory = root.path().join(BINDINGS);
        if !symlink_metadata(&directory).is_ok_and(|metadata| {
            metadata.is_dir() && metadata.permissions().mode() & GROUP_OR_OTHER_PERMISSIONS == 0
        }) {
            return Err(ServiceError::AcpBinding);
        }
        Ok(directory.join(format!("{session_id}.json")))
    }

    pub(super) fn ensure_inbox_binding(&self, directory: &Path) -> Result<[u8; 32], ServiceError> {
        let session_id = session_id(directory);
        let path = self.acp_binding_path(&session_id)?;
        let key = match existing_binding::<InboxBinding>(&path)? {
            Some(binding) if binding.session_id == session_id => {
                if binding.endpoint == self.callback {
                    return Ok(binding.inbox_credential);
                }
                binding.inbox_credential
            }
            Some(_) => return Err(ServiceError::AcpBinding),
            None => random_key()?,
        };
        let binding = InboxBinding {
            session_id,
            endpoint: self.callback,
            inbox_credential: key,
        };
        let (file, directory) = prepare_binding(&path, &binding)?;
        publish_binding(file, &path, directory)?;
        Ok(key)
    }

    pub(super) async fn acp_reader(&self, task: &str, key: &[u8; 32]) -> Option<[u8; 32]> {
        self.storage.database().verify().ok()?;
        let state = self.state.lock().await;
        reader_controller(&state, task, key)
    }

    pub(super) async fn acp_credential(
        &self,
        selector: &str,
        key: &[u8; 32],
        access: SessionAccess,
    ) -> Option<(String, [u8; 32])> {
        self.storage.database().verify().ok()?;
        let state = self.state.lock().await;
        let controller = match access {
            SessionAccess::Read => reader_controller,
            SessionAccess::Write => writer_controller,
        };
        if !selector.contains('#') {
            return controller(&state, selector, key).map(|digest| (selector.into(), digest));
        }
        crate::numbers::TaskReference::parse(selector)
            .ok()?
            .candidates(&state)
            .ok()?
            .into_iter()
            .find_map(|id| controller(&state, &id, key).map(|digest| (id, digest)))
    }
}

#[derive(Clone, Copy)]
pub(super) enum SessionAccess {
    Read,
    Write,
}

fn existing_binding<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, ServiceError> {
    let file = match open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(file) => File::from(file),
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(_) => return Err(ServiceError::AcpBinding),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.permissions().mode() & GROUP_OR_OTHER_PERMISSIONS != 0
        || metadata.len() > 4096
    {
        return Err(ServiceError::AcpBinding);
    }
    serde_json::from_reader(file.take(4096))
        .map(Some)
        .map_err(|_| ServiceError::AcpBinding)
}

fn write_binding(
    state: &State,
    path: &Path,
    binding: &Binding,
    controller: Option<[u8; 32]>,
) -> Result<(), ServiceError> {
    let (temporary, directory) = prepare_binding(path, binding)?;
    if let Some(controller) = controller {
        // Rebinding revokes old credentials even if writing the pointer is interrupted.
        state.store.bind_acp(
            &binding.task_id,
            &AcpSession {
                reader: digest(&binding.credential),
                writer: binding.command_credential.as_ref().map(digest),
                controller,
            },
        )?;
    }
    publish_binding(temporary, path, directory)
}

fn prepare_binding<'a>(
    path: &'a Path,
    binding: &impl Serialize,
) -> Result<(tempfile::NamedTempFile, &'a Path), ServiceError> {
    let directory = path.parent().ok_or(ServiceError::AcpBinding)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(temporary.as_file_mut(), binding)
        .map_err(|_| ServiceError::AcpBinding)?;
    temporary.as_file().sync_all()?;
    Ok((temporary, directory))
}

fn publish_binding(
    temporary: tempfile::NamedTempFile,
    path: &Path,
    directory: &Path,
) -> Result<(), ServiceError> {
    temporary
        .persist(path)
        .map_err(|_| ServiceError::AcpBinding)?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

pub(super) fn writer_controller(state: &State, task: &str, key: &[u8; 32]) -> Option<[u8; 32]> {
    let session = state.store.acp_session(task).ok()??;
    bool::from(session.writer?.ct_eq(&digest(key))).then_some(session.controller)
}

fn reader_controller(state: &State, task: &str, key: &[u8; 32]) -> Option<[u8; 32]> {
    let session = state.store.acp_session(task).ok()??;
    bool::from(session.reader.ct_eq(&digest(key))).then_some(session.controller)
}

fn random_key() -> Result<[u8; 32], ServiceError> {
    let mut key = [0; 32];
    getrandom::fill(&mut key).map_err(|_| ServiceError::AcpBinding)?;
    Ok(key)
}

fn digest(key: &[u8; 32]) -> [u8; 32] {
    Sha256::digest(key).into()
}
