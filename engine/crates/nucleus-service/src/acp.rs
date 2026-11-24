use std::{
    fs::{File, symlink_metadata},
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use crate::{ControllerScope, Service, ServiceError, State, event, pass::DispatchTarget};
use nucleus_core::{
    Authority, Phase, RunState, WaitReason,
    acp::{Binding, InboxBinding, session_id},
};
use nucleus_store::{AcpSession, TaskRow};
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

enum ParentClaim {
    Fresh(i64),
    Replay,
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

fn run_keeps_turn(state: &State, row: &TaskRow) -> bool {
    let task = &row.task;
    let Some(run) = task.run() else {
        return false;
    };
    match state.role_observation(task) {
        Some(RunState::Running) => true,
        None
        | Some(RunState::ReadyToSend | RunState::Starting | RunState::IdleWithoutTerminalRun) => {
            !run.revoked() && run_hold_deadline(row).is_some_and(|until| until > crate::now_ms())
        }
        _ => false,
    }
}

impl Service {
    pub(super) fn turn_failure_scope(&self, session: &str) -> String {
        format!("{session}/{}", self.turn_epoch)
    }

    pub(super) fn acp_turn_view(
        &self,
        state: &State,
        row: &TaskRow,
    ) -> Result<(Option<String>, bool), ServiceError> {
        let task = &row.task;
        let id = &task.identity().id;
        let wait = state.wait_reason(id);
        let checkout = nucleus_work::checkout_path(
            self.storage.work().path(),
            &task.identity().repository,
            id,
        );
        let active_in_shell = [nucleus_core::Role::Worker, nucleus_core::Role::Reviewer]
            .into_iter()
            .filter_map(|role| task.threads().get(role))
            .filter(|thread| {
                task.run()
                    .is_none_or(|run| !run.revoked() || run.launch().thread != *thread)
            })
            .chain(
                task.run()
                    .filter(|run| !run.revoked())
                    .map(|run| run.launch().thread.as_str()),
            )
            .any(|thread| self.host.bound_child_active(thread, &checkout));
        let active_child = active_in_shell || run_keeps_turn(state, row);
        if task.phase().is_terminal()
            || matches!(
                state.wait_detail(id),
                Some(crate::WaitDetail::OperatorSnoozed { .. })
            )
            || (!active_child
                && matches!(
                    state.wait_detail(id),
                    Some(
                        crate::WaitDetail::BeforeSend(_) | crate::WaitDetail::ShowingForDelivery(_)
                    )
                ))
            || (!active_in_shell && crate::attention::waiting_for_person(task, wait))
            || task.hold().is_some()
            || task.operator_decline().is_some()
            || state
                .settings
                .dispatch
                .as_ref()
                .is_some_and(|dispatch| dispatch.mode == nucleus_store::DispatchMode::Stopped)
            || (!active_in_shell && wait == Some(WaitReason::HostObservationBlocked))
        {
            return Ok((None, false));
        }
        if !active_child
            && (task.run().is_some()
                || !matches!(wait, Some(WaitReason::Starting | WaitReason::HostUnknown)))
        {
            return Ok((None, false));
        }
        let Some(session) = self.host.runtime_identity() else {
            return Ok((None, active_child));
        };
        let command =
            state
                .store
                .task_turn_command(id, "native_turn_intent", row.version, &session)?;
        if let Some(command) = &command
            && state.store.task_turn_failed(id, command)?
        {
            return Ok((None, false));
        }
        let prompt = match command {
            Some(command) => state.store.task_turn_prompt(id, &command)?,
            None => None,
        };
        Ok((prompt, active_child))
    }

    pub(super) async fn parent_delivery_fenced(&self, row: &TaskRow) -> Result<bool, ServiceError> {
        let Some(runtime) = self.host.runtime_identity() else {
            return Ok(false);
        };
        let identity = row.task.identity();
        let id = &identity.id;
        let pending = {
            let state = self.state.lock().await;
            let pending = state.store.task_delivery_fence(id, row.version, &runtime)?;
            if let Some([command]) = pending.as_deref()
                && nucleus_hosts::is_pinned_parent_hold(command)
                && state
                    .store
                    .task_turn_command(id, "native_turn_intent", row.version, &runtime)?
                    .as_ref()
                    == Some(command)
            {
                // The launch owner can reconcile its current frozen hold directly.
                return Ok(false);
            }
            pending
        };
        let Some(commands) = pending else {
            return Ok(false);
        };
        let Some(provider) = self.acp_provider().filter(|_| !commands.is_empty()) else {
            return Ok(true);
        };
        let _fence = self.effect(row).await?;
        let route = self.project_for(identity).await?;
        let work = self.worktrees()?;
        let checkout = work.checkout(&route.checkout, &identity.repository, id)?;
        let binding = route.binding(&checkout)?;
        if !matches!(
            self.host
                .parent_deliveries_observed(&binding, provider, &commands)
                .await,
            Ok(true)
        ) || self.host.runtime_identity().as_deref() != Some(runtime.as_str())
        {
            return Ok(true);
        }
        let mut state = self.state.lock().await;
        for command in commands {
            let mut audit = event("native_turn_observed");
            audit.detail =
                serde_json::json!({"version":row.version,"session":runtime,"command":command})
                    .to_string();
            state.store.claim_task_effect(id, &audit, false)?;
        }
        Ok(false)
    }

    pub(super) async fn record_native_turn(
        &self,
        row: &TaskRow,
        kind: &str,
        session: &str,
        command: &str,
    ) -> Result<bool, ServiceError> {
        let mut intent = event(kind);
        intent.detail = serde_json::json!({
            "command":command, "version":row.version, "session":session,
        })
        .to_string();
        let id = &row.task.identity().id;
        let mut state = self.state.lock().await;
        let recorded = state.store.claim_task_effect(id, &intent, false)?.is_some();
        if recorded {
            if kind == "native_turn_failed" {
                state.wake_capacity(tokio::time::Instant::now());
                self.wake.notify_one();
            }
            self.publish(id, row.version);
        }
        Ok(recorded)
    }

    async fn claim_parent_intent(
        &self,
        row: &TaskRow,
        kind: &str,
        session: &str,
        command: &str,
        prompt: &str,
    ) -> Result<Option<ParentClaim>, ServiceError> {
        let id = &row.task.identity().id;
        let mut state = self.state.lock().await;
        let retry_of =
            match state
                .store
                .task_turn_attempt(id, kind, row.version, session, command)?
            {
                Some((sequence, true)) => Some(sequence),
                Some((_, false)) if nucleus_hosts::is_pinned_parent_hold(command) => {
                    return Ok(Some(ParentClaim::Replay));
                }
                Some((_, false)) => return Ok(None),
                None => None,
            };
        let mut intent = event(kind);
        intent.detail = serde_json::json!({
            "command": command, "version": row.version, "session": session, "retryOf": retry_of,
            "prompt": prompt,
        })
        .to_string();
        let starting =
            row.task.run().is_none() && matches!(kind, "native_turn_intent" | "native_turn_replay");
        let wait = Some(WaitReason::Starting);
        let entered = starting && state.wait_label_changed(&row.task, wait, None);
        let attempt = state.store.claim_task_effect(id, &intent, entered)?;
        if attempt.is_some() && starting {
            state.apply_observed_wait(&row.task, wait, entered);
            self.publish(id, row.version);
        }
        Ok(attempt.map(ParentClaim::Fresh))
    }

    pub(super) async fn deliver_parent(
        &self,
        row: &TaskRow,
        mut write: nucleus_hosts::ParentWrite,
        session: &str,
        intent_kind: Option<&str>,
    ) -> Result<bool, ServiceError> {
        let command = write.command_id().ok_or(ServiceError::Input)?.to_owned();
        let message = write.starts_turn();
        let pinned_thread = if nucleus_hosts::is_pinned_parent_hold(&command) {
            let thread = write.thread_id().ok_or(ServiceError::Input)?.to_owned();
            write.allow_owned_snoozes(self.owned_delivery_snoozes(row, &thread).await?);
            Some(thread)
        } else {
            None
        };
        self.wake_parent_delivery(row, &write).await?;
        if let Err(cause) = self.host.verify_parent_write(&mut write).await {
            return Err(if message {
                self.parent_not_sent(cause)
            } else {
                cause.into()
            });
        }
        let attempt = if let Some(kind) = intent_kind {
            let frozen = self
                .state
                .lock()
                .await
                .store
                .task_turn_prompt(&row.task.identity().id, &command)?;
            if let Some(prompt) = frozen {
                write.set_prompt(prompt);
            }
            let prompt = write.prompt().ok_or(ServiceError::Input)?;
            match self
                .claim_parent_intent(row, kind, session, &command, prompt)
                .await?
            {
                Some(ParentClaim::Fresh(sequence)) => Some(sequence),
                Some(ParentClaim::Replay) => None,
                None => return Ok(false),
            }
        } else {
            None
        };
        match self.host.write_verified_parent(write).await {
            Ok(()) => Ok(true),
            Err(nucleus_hosts::ParentSendError::Rejected) => {
                Err(nucleus_hosts::HostError::ParentHoldRejected.into())
            }
            Err(nucleus_hosts::ParentSendError::Unknown(error)) if message => {
                Err(ServiceError::ParentDeliveryUnknown(error))
            }
            Err(nucleus_hosts::ParentSendError::Unknown(error)) => Err(error.into()),
            Err(nucleus_hosts::ParentSendError::NotSent(
                nucleus_hosts::HostError::OperatorSnoozed { until },
            )) => {
                let thread = pinned_thread.ok_or(ServiceError::Input)?;
                // Keep the current intent so an operator wake resumes this exact ID.
                Err(ServiceError::OperatorSnoozed { thread, until })
            }
            Err(nucleus_hosts::ParentSendError::NotSent(error)) => {
                if let Some(sequence) = attempt {
                    self.record_parent_refusal(
                        row,
                        &command,
                        session,
                        Some(sequence),
                        &error.to_string(),
                    )
                    .await?;
                }
                Err(if message {
                    self.parent_not_sent(error)
                } else {
                    error.into()
                })
            }
        }
    }

    pub(super) async fn record_parent_refusal(
        &self,
        row: &TaskRow,
        command: &str,
        session: &str,
        attempt: Option<i64>,
        reason: &str,
    ) -> Result<(), ServiceError> {
        let id = &row.task.identity().id;
        let mut audit = event("native_turn_not_sent");
        audit.detail = serde_json::json!({
            "command": command, "version": row.version, "session": session,
            "attempt": attempt, "reason": reason,
        })
        .to_string();
        self.state
            .lock()
            .await
            .store
            .claim_task_effect(id, &audit, false)?;
        Ok(())
    }

    pub(super) fn parent_not_sent(&self, reason: impl std::fmt::Display) -> ServiceError {
        ServiceError::ParentNotSent {
            reason: reason.to_string(),
            retry_at: self.host.request_retry_at(),
        }
    }

    pub(super) async fn record_failed_parent_turn(
        &self,
        row: &TaskRow,
        session: &str,
        command: &str,
    ) -> Result<(), ServiceError> {
        if self
            .record_native_turn(
                row,
                "native_turn_failed",
                &self.turn_failure_scope(session),
                command,
            )
            .await?
        {
            let id = &row.task.identity().id;
            eprintln!(
                "{id}: T3 parent turn failed ({command}); waiting for a task, session, or engine change"
            );
        }
        Ok(())
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
        let session = self
            .host
            .runtime_identity()
            .ok_or(nucleus_hosts::HostError::Uncertain)?;
        let kind = "acp_row_refresh_intent";
        {
            let state = self.state.lock().await;
            if let Some(prior) = state
                .store
                .task_turn_command(id, kind, row.version, &session)?
                && !state
                    .store
                    .task_turn_attempt(id, kind, row.version, &session, &prior)?
                    .is_some_and(|(_, refused)| refused)
            {
                return Ok(false);
            }
        }
        let route = self.project_for(identity).await?;
        let work = self.worktrees()?;
        let checkout = work.checkout(&route.checkout, &identity.repository, id)?;
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
        self.deliver_parent(row, write, &session, Some(kind)).await
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
