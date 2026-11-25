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
use nucleus_hosts::{FrozenParentWrite, HostError, ParentSendError, ParentWrite, T3_RETRY_DELAY};
use nucleus_store::{AcpSession, ParentDelivery, ParentResult, StoreError, TaskRow};
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

fn parent_delivery_retry(source: HostError, due_ms: i64) -> ServiceError {
    let remaining = due_ms.saturating_sub(ms(crate::now_ms())).max(0);
    let until =
        tokio::time::Instant::now() + std::time::Duration::from_millis(remaining.unsigned_abs());
    let until = match source {
        HostError::Deferred { until: deferred } => until.max(deferred),
        _ => until,
    };
    ServiceError::ParentDeliveryUnknown { source, until }
}

pub(super) fn can_replay(record: &ParentDelivery, runtime: Option<&str>) -> bool {
    record.wire.is_some() && runtime.is_some() && record.runtime.as_deref() == runtime
}

fn ms(timestamp: u64) -> i64 {
    i64::try_from(timestamp).unwrap_or(i64::MAX)
}

fn retry_ms() -> i64 {
    ms(crate::now_ms()
        .saturating_add(u64::try_from(T3_RETRY_DELAY.as_millis()).unwrap_or(u64::MAX)))
}

fn delivery_prompt(record: &ParentDelivery) -> Result<Option<String>, StoreError> {
    if let Some(wire) = &record.wire {
        let frozen: FrozenParentWrite = serde_json::from_str(wire)?;
        Ok(frozen.prompt().map(str::to_owned))
    } else {
        Ok(Some(record.legacy_prompt.clone().unwrap_or_else(|| {
            nucleus_core::acp::legacy_parent_hold_prompt(&record.command)
        })))
    }
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
            || task.run().is_some_and(|run| run.report().is_some())
            || matches!(
                state.role_observation(task),
                Some(RunState::Ended | RunState::UsageLimited)
            )
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
        // A remembered child can acquire a new re-entry hold after settlement.
        // Carrying the prior prompt requires a current role.
        let delivery = state
            .store
            .parent_deliveries(id, row.version, None)?
            .into_iter()
            .find(|delivery| !delivery.refresh && !delivery.command.is_empty());
        if delivery.as_ref().is_some_and(|delivery| {
            delivery.result == ParentResult::Failed
                || (nucleus_hosts::is_parent_reentry(&delivery.command) && !active_in_shell)
        }) {
            return Ok((None, false));
        }
        let prompt = delivery
            .filter(|delivery| {
                matches!(
                    delivery.result,
                    ParentResult::Pending | ParentResult::Accepted
                )
            })
            .map(|delivery| delivery_prompt(&delivery))
            .transpose()?
            .flatten();
        let carry = active_child && task.run().is_some() && prompt.is_none();
        Ok((prompt, carry))
    }

    pub(super) async fn parent_delivery_fenced(&self, row: &TaskRow) -> Result<(), ServiceError> {
        let id = &row.task.identity().id;
        let state = self.state.lock().await;
        let records = state.store.parent_deliveries(id, row.version, None)?;
        if records
            .iter()
            .any(|value| value.result == ParentResult::Held)
        {
            return Err(ServiceError::ParentDeliveryHeld);
        }
        if !records
            .iter()
            .any(|value| value.result == ParentResult::Pending)
        {
            return Ok(());
        }
        let runtime = self.host.verified_runtime_identity();
        let uncertain: Vec<_> = records
            .into_iter()
            .filter(|value| {
                value.result == ParentResult::Pending && !can_replay(value, runtime.as_deref())
            })
            .collect();
        if uncertain.is_empty()
            || (row.task.phase() == Phase::Working
                && row.task.first_launch()
                && !state.forge_requested.contains(id)
                && !self.initial_dispatch_allowed(&state, row.task.identity())?)
        {
            return Ok(());
        }
        drop(state);
        let _fence = self.effect(row).await?;
        let identity = row.task.identity();
        let route = self.project_for(identity).await?;
        let work = self.worktrees()?;
        let checkout = work.checkout(&route.checkout, &identity.repository, id)?;
        self.resolve_parent_deliveries(row, &route.binding(&checkout)?, &uncertain)
            .await
    }

    pub(super) async fn resolve_parent_deliveries(
        &self,
        row: &TaskRow,
        binding: &nucleus_hosts::Binding,
        records: &[ParentDelivery],
    ) -> Result<(), ServiceError> {
        // A frozen send's deadline paces replay. Capacity release can still
        // trigger its first receipt read on a replacement runtime.
        for record in records.iter().filter(|record| record.wire.is_none()) {
            parent_due(record)?;
        }
        let before = self.host.verified_runtime_identity();
        let mut accepted = Vec::new();
        if let Some(provider) = self.acp_provider() {
            let thread = nucleus_hosts::parent_thread(Path::new(&binding.worktree_path));
            let commands: Vec<_> = records
                .iter()
                .filter(|record| {
                    record
                        .command
                        .strip_prefix(&thread)
                        .is_some_and(|suffix| suffix.starts_with('-'))
                        && record.wire.as_deref().is_none_or(|wire| {
                            serde_json::from_str::<FrozenParentWrite>(wire)
                                .is_ok_and(|frozen| frozen.matches(binding, provider))
                        })
                })
                .map(|record| record.command.clone())
                .collect();
            if !commands.is_empty() {
                let receipts = self
                    .host
                    .parent_delivery_receipts(binding, provider, commands)
                    .await;
                let unavailable = match receipts {
                    Ok(found)
                        if before.is_some() && self.host.verified_runtime_identity() == before =>
                    {
                        accepted = found;
                        None
                    }
                    Err(HostError::Binding) => None,
                    Err(error @ HostError::Deferred { .. }) => {
                        return Err(parent_delivery_retry(error, 0));
                    }
                    Err(error) => Some(error),
                    Ok(_) => Some(HostError::Uncertain),
                };
                if let Some(error) = unavailable {
                    let state = self.state.lock().await;
                    let due = retry_ms();
                    for record in records {
                        state.store.finish_parent_delivery(
                            &row.task.identity().id,
                            row.version,
                            record,
                            ParentResult::Pending,
                            due,
                        )?;
                    }
                    return Err(parent_delivery_retry(error, due));
                }
            }
        }
        let state = self.state.lock().await;
        for record in records {
            let result = if accepted.contains(&record.command) {
                ParentResult::Accepted
            } else {
                ParentResult::Held
            };
            state.store.finish_parent_delivery(
                &row.task.identity().id,
                row.version,
                record,
                result,
                0,
            )?;
        }
        if accepted.len() != records.len() {
            return Err(ServiceError::ParentDeliveryHeld);
        }
        Ok(())
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
            self.publish(id, row.version);
        }
        Ok(recorded)
    }

    pub(super) async fn deliver_parent(
        &self,
        row: &TaskRow,
        mut write: ParentWrite,
        prior: Option<ParentDelivery>,
        refresh: bool,
    ) -> Result<bool, ServiceError> {
        let runtime = self.host.verified_runtime_identity();
        let existing = prior
            .filter(|record| record.command == write.command_id().unwrap_or_default() || refresh);
        if let Some(record) = &existing {
            match record.result {
                ParentResult::Accepted | ParentResult::Failed => return Ok(false),
                ParentResult::Held => return Err(ServiceError::ParentDeliveryHeld),
                ParentResult::Pending if !can_replay(record, runtime.as_deref()) => {
                    self.resolve_parent_deliveries(
                        row,
                        write.binding(),
                        std::slice::from_ref(record),
                    )
                    .await?;
                    return Ok(false);
                }
                ParentResult::Pending => parent_due(record)?,
                ParentResult::Refused => {}
            }
            if let Some(wire) = &record.wire {
                write.use_frozen(serde_json::from_str(wire).map_err(StoreError::from)?)?;
                if write.command_id() != Some(record.command.as_str()) {
                    return Err(ServiceError::ParentDeliveryHeld);
                }
            }
        }
        let command = write.command_id().ok_or(ServiceError::Input)?.to_owned();
        let thread = write.thread_id().ok_or(ServiceError::Input)?.to_owned();
        if nucleus_hosts::is_pinned_parent_hold(&command) {
            write.allow_owned_snoozes(self.owned_delivery_snoozes(row, &thread).await?);
        }
        self.wake_parent_delivery(row, &write).await?;
        write.require_runtime(runtime.clone());
        let attempt = if write.starts_turn() {
            Some(
                self.begin_parent_delivery(row, &write, refresh, runtime, existing)
                    .await?,
            )
        } else {
            None
        };
        let result = self.host.write_parent(write).await;
        let retry = retry_ms();
        if let Some((record, replay)) = &attempt {
            let (outcome, due) = match &result {
                Ok(()) => (ParentResult::Accepted, 0),
                Err(ParentSendError::Rejected) => (ParentResult::Failed, 0),
                Err(ParentSendError::NotSent(HostError::OperatorSnoozed { .. })) => {
                    (ParentResult::Pending, 0)
                }
                Err(ParentSendError::NotSent(_)) if !replay => (ParentResult::Refused, 0),
                Err(_) => (ParentResult::Pending, retry),
            };
            self.finish_parent_delivery(row, record, outcome, due)
                .await?;
        }
        match result {
            Ok(()) => Ok(true),
            Err(ParentSendError::Rejected) => Err(HostError::ParentHoldRejected.into()),
            Err(ParentSendError::Unknown(error)) if attempt.is_some() => {
                Err(parent_delivery_retry(error, retry))
            }
            Err(ParentSendError::Unknown(error)) => Err(error.into()),
            Err(ParentSendError::NotSent(HostError::OperatorSnoozed { until })) => {
                Err(ServiceError::OperatorSnoozed { thread, until })
            }
            Err(ParentSendError::NotSent(error)) => Err(self.parent_not_sent(error)),
        }
    }

    async fn begin_parent_delivery(
        &self,
        row: &TaskRow,
        write: &ParentWrite,
        refresh: bool,
        runtime: Option<String>,
        existing: Option<ParentDelivery>,
    ) -> Result<(ParentDelivery, bool), ServiceError> {
        let id = &row.task.identity().id;
        let mut state = self.state.lock().await;
        if let Some(record) = existing.filter(|record| record.result == ParentResult::Pending) {
            state.store.finish_parent_delivery(
                id,
                row.version,
                &record,
                ParentResult::Pending,
                retry_ms(),
            )?;
            return Ok((record, true));
        }
        let record = ParentDelivery {
            version: row.version,
            command: write.command_id().ok_or(ServiceError::Input)?.into(),
            refresh,
            runtime,
            wire: Some(serde_json::to_string(write.freeze()).map_err(StoreError::from)?),
            legacy_prompt: None,
            due_ms: retry_ms(),
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
        Ok((record, false))
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
                    .parent_deliveries(id, row.version, None)?
                    .iter()
                    .any(|value| value.refresh && value.result == ParentResult::Pending)
        };
        if refresh && let Err(error) = self.refresh_acp_parent(row).await {
            if matches!(
                error,
                ServiceError::ParentNotSent { .. } | ServiceError::RowVisibilityDeferred { .. }
            ) {
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
            .parent_deliveries(id, row.version, None)?
            .into_iter()
            .find(|value| value.refresh);
        if let Some(record) = &prior {
            match record.result {
                ParentResult::Pending => parent_due(record)?,
                ParentResult::Refused => {}
                _ => return Ok(false),
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
