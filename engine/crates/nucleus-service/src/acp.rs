use std::{
    fs::{File, symlink_metadata},
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use crate::{ControllerScope, Service, ServiceError, State};
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

pub(super) fn frozen_parent(record: &ParentDelivery) -> Result<FrozenParentWrite, StoreError> {
    Ok(serde_json::from_str(&record.wire)?)
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
        let frozen = delivery.as_ref().map(frozen_parent).transpose()?;
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
        let restoring = delivery.is_some()
            && state.registry_mode
            && !self.host.projects_synchronized()
            && !crate::task_rows::visibility_roles(task).is_empty();
        let wanted = wants_parent_hold(
            row,
            state.dispatch_mode(),
            preparing,
            active_role || restoring,
            crate::now_ms(),
        );
        let active_child = wanted && delivery.is_none() && active_role;
        let prompt = frozen
            .as_ref()
            .filter(|_| wanted)
            .and_then(FrozenParentWrite::prompt)
            .map(str::to_owned);
        Ok((prompt, active_child))
    }

    pub(super) async fn deliver_parent(
        &self,
        row: &TaskRow,
        mut write: ParentWrite,
        prior: Option<ParentDelivery>,
    ) -> Result<bool, ServiceError> {
        let existing =
            prior.filter(|record| record.command == write.command_id().unwrap_or_default());
        let preparing = write
            .freeze()
            .checkpoint()
            .is_some_and(|value| value.preparing_launch);
        if let Some(record) = &existing {
            if record.result == ParentResult::Accepted {
                return Ok(false);
            }
            parent_due(record)?;
            write.use_frozen(frozen_parent(record)?)?;
        }
        let command = write.command_id().ok_or(ServiceError::Input)?.to_owned();
        if existing
            .as_ref()
            .is_some_and(|record| record.command != command)
        {
            return Err(HostError::Binding.into());
        }
        if write.starts_turn() {
            let thread = write.thread_id().ok_or(ServiceError::Input)?;
            write.allow_owned_snoozes(self.owned_delivery_snoozes(row, thread).await?);
        }
        // Record the wire and deadline before sending. A restart or transport
        // error can replay this exact command against T3's durable receipt.
        let attempt = if write.starts_turn() {
            Some(self.begin_parent_delivery(row, &write, existing).await?)
        } else {
            None
        };
        let result = self
            .write_parent_with_snooze(row, &command, write, preparing)
            .await?;
        match (result, attempt) {
            (Ok(()), record) => {
                if let Some((record, _)) = record {
                    let start_deadline =
                        ms(crate::now_ms().saturating_add(PARENT_START_TIMEOUT_MS));
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
            .finish_parent_snooze(id, &record.command, None)?;
        state
            .store
            .retry_parent_delivery(id, row.version, record, &command, &wire, due)?;
        Err(parent_delivery_retry(HostError::ParentHoldRejected, due))
    }

    async fn write_parent_with_snooze(
        &self,
        row: &TaskRow,
        command: &str,
        write: ParentWrite,
        preparing: bool,
    ) -> Result<Result<(), ParentSendError>, ServiceError> {
        let id = &row.task.identity().id;
        let starts_turn = write.starts_turn();
        let checkout = PathBuf::from(&write.binding().worktree_path);
        let mut store_error = None;
        let result = self
            .host
            .write_parent(write, |snooze| {
                let state = self.state.try_lock().map_err(|_| HostError::Uncertain)?;
                let dispatch = state.dispatch_mode();
                if !self.lookup(&state, id).is_ok_and(|fresh| fresh == *row)
                    || dispatch == DispatchMode::Stopped
                    || starts_turn
                        && !wants_parent_hold(
                            row,
                            dispatch,
                            preparing && dispatch.allows_launch(row.task.first_launch()),
                            self.active_parent_role(&row.task, &checkout),
                            crate::now_ms(),
                        )
                {
                    return Err(HostError::Uncertain);
                }
                let Some(intent) = snooze else {
                    return Ok(());
                };
                state
                    .store
                    .record_parent_snooze(
                        id,
                        command,
                        &intent.thread,
                        &intent,
                        intent.until_ms,
                        crate::now_ms(),
                    )
                    .map_err(|error| {
                        store_error = Some(error);
                        HostError::Uncertain
                    })?;
                self.title_wake.notify_one();
                Ok(())
            })
            .await;
        if let Some(error) = store_error {
            return Err(error.into());
        }
        Ok(result)
    }

    async fn begin_parent_delivery(
        &self,
        row: &TaskRow,
        write: &ParentWrite,
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
                wire,
                due_ms,
                result: ParentResult::Pending,
            };
            if !state.store.freeze_parent_delivery(id, &record)? {
                return Err(StoreError::StaleTask.into());
            }
            if row.task.run().is_none() {
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
        write_binding(
            &state,
            &binding_path,
            &binding,
            Some(controller),
            scope.actor(),
        )?;
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
                write_binding(&state, &binding_path, &binding, None, None)?;
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
            None,
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
        SessionAccess::Read
            .authenticate(&state, task, key)
            .map(|session| session.controller)
    }

    pub(super) async fn acp_credential(
        &self,
        selector: &str,
        key: &[u8; 32],
        access: SessionAccess,
    ) -> Option<(String, AcpSession)> {
        self.storage.database().verify().ok()?;
        let state = self.state.lock().await;
        if !selector.contains('#') {
            return access
                .authenticate(&state, selector, key)
                .map(|session| (selector.into(), session));
        }
        crate::numbers::TaskReference::parse(selector)
            .ok()?
            .candidates(&state)
            .ok()?
            .into_iter()
            .find_map(|id| {
                access
                    .authenticate(&state, &id, key)
                    .map(|session| (id, session))
            })
    }
}

#[derive(Clone, Copy)]
pub(super) enum SessionAccess {
    Read,
    Write,
}

impl SessionAccess {
    fn authenticate(self, state: &State, task: &str, key: &[u8; 32]) -> Option<AcpSession> {
        let session = state.store.acp_session(task).ok()??;
        let expected = match self {
            Self::Read => session.reader,
            Self::Write => session.writer?,
        };
        bool::from(expected.ct_eq(&digest(key))).then_some(session)
    }
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
    controller_thread: Option<&str>,
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
                controller_thread: controller_thread.map(str::to_owned),
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
    SessionAccess::Write
        .authenticate(state, task, key)
        .map(|session| session.controller)
}

fn random_key() -> Result<[u8; 32], ServiceError> {
    let mut key = [0; 32];
    getrandom::fill(&mut key).map_err(|_| ServiceError::AcpBinding)?;
    Ok(key)
}

fn digest(key: &[u8; 32]) -> [u8; 32] {
    Sha256::digest(key).into()
}
