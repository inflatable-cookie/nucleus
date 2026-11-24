use std::{
    collections::BTreeMap,
    future::Future,
    hash::{BuildHasher, RandomState},
    path::Path,
    sync::{Arc, OnceLock},
};

use nucleus_core::{
    RetainedThread,
    acp::{REFRESH_TASK_ROW, parent_hold_prompt, session_id},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    Binding, HostError, ProfileCatalog, RowChildren, RowObservation, RowVisibility, T3, clock_ms,
    message_id,
    projection::{ParentCustody, Projection, Subagent},
    rpc::{Read, Reply, ThreadFence},
    task_row::ThreadVisibility,
    thread_snapshots::{ShellCustody, ThreadRead, ThreadSnapshots, row_activity},
};

/// Evidence for the exact active turn and root node that can parent a child.
#[derive(Clone)]
pub struct ParentRun {
    pub(crate) thread: String,
    pub(crate) run: String,
    pub(crate) node: String,
}

pub enum ParentStep {
    Live(ParentRun),
    Failed,
    DeliveryUnknown,
    Write(ParentWrite),
    Wait,
}

pub struct ParentAttempt<'a> {
    pub command: &'a str,
    pub released: bool,
}

/// Whether failure happened before the command could enter the transport.
#[derive(Debug)]
pub enum ParentSendError {
    NotSent(HostError),
    Unknown(HostError),
}

/// Closeout evidence journaled for one completed task binding.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveCustody {
    binding: Option<Binding>,
    provider: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    roster_run: Option<String>,
    members: BTreeMap<String, ArchiveMember>,
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct ArchiveMember {
    owned: bool,
    closed: Option<Closure>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    closure_lost: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
enum Closure {
    Gone,
    Archived(String, Option<String>),
    Accepted(ArchiveAcceptance),
}

/// An acceptance matched by the transport to its exact guarded archive command.
pub struct ArchiveReceipt {
    binding: Binding,
    scope: Option<String>,
    thread: String,
    acceptance: ArchiveAcceptance,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ArchiveAcceptance {
    command: String,
    predecessor: u64,
    updated_at: Option<String>,
    latest_run: Option<String>,
    sequence: u64,
}

#[derive(PartialEq, Eq)]
enum ClosureState {
    Confirmed,
    Pending,
    Changed,
}

impl ArchiveCustody {
    fn qualify(&mut self, scope: &str) {
        if self.scope.as_deref() != Some(scope) {
            self.scope = Some(scope.into());
            self.roster_run = None;
            for member in self.members.values_mut() {
                member.closure_lost |= member.closed.take().is_some();
                member.owned = false;
            }
        }
    }

    fn lost_closure(&self, shell: &ThreadSnapshots, parent: &str) -> Option<ArchiveWait> {
        self.members
            .iter()
            .filter(|(id, member)| member.closure_lost && shell.marker(id).is_none())
            .min_by_key(|(id, _)| id.as_str() == parent)
            .map(|(id, _)| ArchiveWait::LostClosure {
                thread: id.clone(),
                parent: id == parent,
            })
    }

    fn refresh(&mut self, shell: Option<&ThreadSnapshots>) -> Option<String> {
        let mut pending = None;
        for (id, member) in &mut self.members {
            match member
                .closed
                .as_ref()
                .map(|proof| proof.state(shell, id, self.binding.as_ref()))
            {
                Some(ClosureState::Changed) => member.closed = None,
                Some(ClosureState::Pending) => {
                    pending.get_or_insert_with(|| id.clone());
                }
                Some(ClosureState::Confirmed) | None => {}
            }
        }
        pending
    }

    /// Record the exact accepted archive while the caller holds the task fence.
    /// # Errors
    /// Returns an error for a receipt from another checkout binding.
    pub fn record_archive(&mut self, receipt: ArchiveReceipt) -> Result<(), HostError> {
        if self.binding.as_ref() != Some(&receipt.binding) || self.scope != receipt.scope {
            return Err(HostError::Binding);
        }
        self.close(&receipt.thread, Closure::Accepted(receipt.acceptance));
        Ok(())
    }

    /// Finish the local closeout while the qualified shell and roster are current.
    pub fn finish<T>(&self, host: &T3, closeout: impl FnOnce() -> T) -> Option<T> {
        host.rpc.with_shell(|shell| {
            (self.members.values().all(|member| member.closed.is_some())
                && self.holds(shell, host.rpc.uses_held_shell()))
            .then(closeout)
        })
    }

    fn holds(&self, shell: Option<&ThreadSnapshots>, managed: bool) -> bool {
        let Some(binding) = &self.binding else {
            return true;
        };
        let parent = parent_thread(Path::new(&binding.worktree_path));
        (shell.is_some() || !managed)
            && shell.is_none_or(|shell| {
                self.scope.is_some()
                    && self.scope == shell.archive_scope
                    && shell
                        .children(&parent)
                        .all(|id| self.members.contains_key(id))
            })
            && self.members.iter().all(|(id, member)| {
                member.closed.as_ref().is_none_or(|proof| {
                    proof.state(shell, id, Some(binding)) == ClosureState::Confirmed
                })
            })
    }

    fn closed(&self, id: &str) -> bool {
        self.members
            .get(id)
            .is_some_and(|member| member.closed.is_some())
    }

    fn close(&mut self, id: &str, proof: Closure) {
        self.members.entry(id.into()).or_default().close(proof);
    }
}

impl ArchiveMember {
    fn close(&mut self, proof: Closure) {
        self.closed = Some(proof);
        self.closure_lost = false;
    }
}

impl Closure {
    fn observed(view: &Projection) -> Self {
        view.archive_marker()
            .map_or(Self::Gone, |(archived, updated)| {
                Self::Archived(archived, updated)
            })
    }

    fn state(
        &self,
        shell: Option<&ThreadSnapshots>,
        id: &str,
        binding: Option<&Binding>,
    ) -> ClosureState {
        let row = shell.and_then(|view| view.marker(id));
        let holds = match self {
            Self::Gone => row.is_none_or(|row| !row["deletedAt"].is_null()),
            Self::Archived(archived, updated) => row.is_none_or(|row| {
                row["deletedAt"].is_null()
                    && row["archivedAt"] == archived.as_str()
                    && row["updatedAt"].as_str() == updated.as_deref()
                    && row_activity(&row) != RowChildren::Active
            }),
            Self::Accepted(acceptance) => {
                return acceptance.state(shell, row.as_deref(), id, binding);
            }
        };
        if holds {
            ClosureState::Confirmed
        } else {
            ClosureState::Changed
        }
    }
}

impl ArchiveAcceptance {
    fn state(
        &self,
        shell: Option<&ThreadSnapshots>,
        row: Option<&Value>,
        id: &str,
        binding: Option<&Binding>,
    ) -> ClosureState {
        let Some(shell) = shell else {
            return ClosureState::Pending;
        };
        let Some(row) = row else {
            return if shell
                .revision()
                .is_some_and(|sequence| sequence >= self.sequence)
            {
                ClosureState::Confirmed
            } else {
                ClosureState::Pending
            };
        };
        if !row["deletedAt"].is_null() {
            return ClosureState::Confirmed;
        }
        if row_activity(row) == RowChildren::Active
            || binding.is_none_or(|binding| {
                row["projectId"] != binding.project_id
                    || row["worktreePath"] != binding.worktree_path
                    || row["branch"] != binding.branch
            })
        {
            return ClosureState::Changed;
        }
        if !row["archivedAt"].is_null() {
            return if row_activity(row) == RowChildren::Quiet {
                ClosureState::Confirmed
            } else {
                ClosureState::Pending
            };
        }
        if row["updatedAt"].as_str() == self.updated_at.as_deref()
            && roster_run(row) == self.latest_run.as_deref()
            && shell
                .row_revision(id)
                .is_none_or(|(sequence, _)| sequence < self.sequence)
        {
            ClosureState::Pending
        } else {
            ClosureState::Changed
        }
    }
}

fn roster_run(row: &Value) -> Option<&str> {
    match row.get("latestRunId")? {
        Value::Null => Some(""),
        run => run.as_str().filter(|run| !run.is_empty()),
    }
}

struct ParentFence {
    custody: ArchiveCustody,
    thread: String,
    target: ThreadFence,
    archive_from: Option<u64>,
}

impl ParentFence {
    fn holds(&self, host: &T3) -> bool {
        host.rpc.with_shell(|shell| {
            self.custody.holds(shell, host.rpc.uses_held_shell())
                && self.target.matches(&host.rpc.fence_at(&self.thread, shell))
        })
    }
}

pub enum ArchiveStep {
    Finished,
    Write(Box<ParentWrite>),
    Wait(ArchiveWait),
}

/// Native evidence still needed before closing this family.
pub enum ArchiveWait {
    Runtime,
    ParentInventory,
    ParentCustody,
    ParentRoster,
    Child(String),
    LostClosure { thread: String, parent: bool },
}

impl ArchiveWait {
    #[must_use]
    pub fn note(&self, worker: Option<&str>, reviewer: Option<&str>) -> String {
        match self {
            Self::Runtime => "Waiting for T3 to confirm its runtime before continuing archive.",
            Self::ParentInventory => {
                "Waiting for T3 to list the task thread so its closure can be confirmed."
            }
            Self::ParentCustody => "Waiting to confirm the task thread is quiet before archiving.",
            Self::ParentRoster => {
                "Waiting to confirm which child threads belong to the task thread."
            }
            Self::Child(thread) if worker == Some(thread) => {
                "Waiting to confirm the worker thread is closed."
            }
            Self::Child(thread) if reviewer == Some(thread) => {
                "Waiting to confirm the reviewer thread is closed."
            }
            Self::Child(_) => "Waiting to confirm a delegated child thread is closed.",
            Self::LostClosure { thread, parent } => {
                let role = if *parent {
                    "task"
                } else if worker == Some(thread) {
                    "worker"
                } else if reviewer == Some(thread) {
                    "reviewer"
                } else {
                    "delegated child"
                };
                return format!(
                    "T3 reconnected during archive and can no longer confirm closure. Unarchive the {role} thread ({thread}) in T3 to resume closeout."
                );
            }
        }
        .into()
    }
}

/// Native mutation bound to the same project and checkout as the evidence.
pub struct ParentWrite {
    binding: Binding,
    rpc: &'static str,
    payload: Value,
    idle_at: Option<(String, u64)>,
    delivery: Option<Box<ParentDelivery>>,
    fence: Option<Box<ParentFence>>,
}

struct ParentDelivery {
    row: RowObservation,
    provider: String,
    custody: ParentCustody,
    shell: Option<Arc<Value>>,
}

impl ParentWrite {
    #[must_use]
    pub const fn binding(&self) -> &Binding {
        &self.binding
    }

    #[must_use]
    pub fn command_id(&self) -> Option<&str> {
        self.payload["commandId"].as_str()
    }

    /// The row and ACP provider bound to a prepared message.
    #[must_use]
    pub fn delivery_row(&self) -> Option<(RowObservation, &str)> {
        self.delivery
            .as_ref()
            .map(|delivery| (delivery.row, delivery.provider.as_str()))
    }

    #[must_use]
    pub fn starts_turn(&self) -> bool {
        self.rpc == "orchestration.launchThread" || self.payload["type"] == "message.dispatch"
    }
}

/// The deterministic native identity of the task's one visible thread.
#[must_use]
pub fn parent_thread(checkout: &Path) -> String {
    format!("thread:{}", session_id(checkout))
}

impl T3 {
    /// Prepare a refresh of an existing, idle, unarchived task row.
    ///
    /// # Errors
    /// Returns an error when the row's identity or idle evidence is invalid.
    pub async fn prepare_parent_refresh(
        &self,
        binding: &Binding,
        provider: &str,
    ) -> Result<Option<ParentWrite>, HostError> {
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let (projection, fence) = self.observe_parent(binding, &thread).await?;
        let Some(projection) = projection else {
            return Ok(None);
        };
        projection.require_parent_provider(provider)?;
        if projection.archived()
            || matches!(
                projection.retained(),
                Ok(RetainedThread::Busy | RetainedThread::Gone)
            )
        {
            return Ok(None);
        }
        let sequence = projection.sequence();
        let command = format!("{thread}-refresh-{sequence}");
        Ok(Some(ParentWrite {
            binding: binding.clone(),
            rpc: "orchestration.dispatchCommand",
            idle_at: Some((thread.clone(), sequence)),
            fence: None,
            delivery: prepare_delivery(&projection, provider, fence.row)?,
            payload: json!({
                "type":"message.dispatch", "commandId":command, "threadId":thread,
                "messageId":message_id(&command), "text":REFRESH_TASK_ROW, "attachments":[],
                "createdBy":"user", "creationSource":"server",
                "dispatchMode":{"type":"queue_after_active"},
            }),
        }))
    }

    /// Retire children before the parent and retain proven terminal evidence.
    /// The final write checks the destination sequence under the caller's fence.
    /// # Errors
    /// Returns an error if identity or custody evidence is missing.
    #[expect(
        clippy::too_many_lines,
        reason = "keep roster validation and its ordered custody checks together"
    )]
    pub async fn prepare_parent_archive(
        &self,
        binding: &Binding,
        provider: &str,
        retained: &[&str],
        custody: &mut ArchiveCustody,
    ) -> Result<ArchiveStep, HostError> {
        if custody.binding.as_ref() != Some(binding)
            || custody.provider.as_deref() != Some(provider)
        {
            *custody = ArchiveCustody {
                binding: Some(binding.clone()),
                provider: Some(provider.into()),
                ..ArchiveCustody::default()
            };
        }
        let parent = parent_thread(Path::new(&binding.worktree_path));
        let marker = self.rpc.with_shell(|shell| {
            let managed = self.rpc.uses_held_shell();
            let scope = shell.and_then(|shell| shell.archive_scope.as_deref());
            if managed && scope.is_none() {
                return None;
            }
            if let Some(scope) = scope {
                custody.qualify(scope);
            }
            if let Some(shell) = shell {
                for id in shell.children(&parent).filter(|id| *id != parent) {
                    custody.members.entry(id.into()).or_default();
                }
            }
            Some((
                managed && shell.and_then(|shell| shell.marker(&parent)).is_none(),
                custody.refresh(shell),
                shell.and_then(|shell| custody.lost_closure(shell, &parent)),
            ))
        });
        let Some((dormant, pending, lost)) = marker else {
            return Ok(ArchiveStep::Wait(ArchiveWait::Runtime));
        };
        if let Some(wait) = lost {
            return Ok(ArchiveStep::Wait(wait));
        }
        if let Some(thread) = pending {
            return Ok(ArchiveStep::Wait(if thread == parent {
                ArchiveWait::ParentInventory
            } else {
                ArchiveWait::Child(thread)
            }));
        }
        for &id in retained {
            if id == parent {
                return Err(HostError::Binding);
            }
            custody.members.entry(id.into()).or_default();
        }
        let mut roster = BTreeMap::new();
        let parent_observation = if custody.closed(&parent) || dormant {
            None
        } else {
            Some(
                self.observe_thread(binding, &parent, ThreadRead::Terminal)
                    .await?,
            )
        };
        let mut parent_archive = None;
        if let Some((view, fence)) = &parent_observation {
            let state = match view
                .as_ref()
                .map_or(Ok(RetainedThread::Gone), Projection::retained)
            {
                Ok(state) => state,
                Err(HostError::Uncertain) => {
                    return Ok(ArchiveStep::Wait(ArchiveWait::ParentCustody));
                }
                Err(error) => return Err(error),
            };
            match state {
                RetainedThread::Busy => return Ok(ArchiveStep::Wait(ArchiveWait::ParentCustody)),
                RetainedThread::Gone => custody.close(&parent, Closure::Gone),
                RetainedThread::Idle => {
                    let view = view.as_ref().ok_or(HostError::Uncertain)?;
                    view.require_parent_provider(provider)?;
                    let listed = fence.row.as_deref();
                    let run = listed.and_then(roster_run);
                    if view.archived() {
                        if listed.is_some_and(|row| row_activity(row) == RowChildren::Quiet)
                            && run.is_some()
                            && run == custody.roster_run.as_deref()
                        {
                            custody.close(&parent, Closure::observed(view));
                        }
                    } else {
                        custody.roster_run = None;
                        let children = match view.subagents() {
                            Ok(children) => children,
                            Err(HostError::Uncertain) => {
                                return Ok(ArchiveStep::Wait(ArchiveWait::ParentRoster));
                            }
                            Err(error) => return Err(error),
                        };
                        for child in children.iter().filter(|child| child.origin == "app_owned") {
                            if let Some(id) = child.child_thread_id.as_deref() {
                                if id == parent || roster.insert(id, child).is_some() {
                                    return Err(HostError::Binding);
                                }
                                custody.members.entry(id.into()).or_default().owned = true;
                            }
                        }
                        if let Some(row) = listed
                            && let Some(run) = run.filter(|run| view.matches_roster_run(run, row))
                        {
                            parent_archive = Some((view.sequence(), run));
                        }
                    }
                }
            }
        }
        let mut unresolved = None;
        for (id, member) in custody.members.iter_mut().filter(|(id, _)| **id != parent) {
            let observation = if member.closed.is_some() {
                None
            } else if self.rpc.uses_held_shell() && self.rpc.thread_row(id).is_none() {
                unresolved.get_or_insert_with(|| ArchiveWait::Child(id.clone()));
                continue;
            } else {
                let (view, fence) = self
                    .observe_thread(binding, id, ThreadRead::Terminal)
                    .await?;
                if let Some(view) = &view {
                    if !view.belongs_to_parent(&parent, member.owned) {
                        return Err(HostError::Binding);
                    }
                    member.owned |= retained.contains(&id.as_str());
                }
                let state = match view
                    .as_ref()
                    .map_or(Ok(RetainedThread::Gone), Projection::retained)
                {
                    Ok(RetainedThread::Busy) | Err(HostError::Uncertain) => {
                        return Ok(ArchiveStep::Wait(ArchiveWait::Child(id.clone())));
                    }
                    Ok(state) => state,
                    Err(error) => return Err(error),
                };
                Some((view, fence, state))
            };
            if let Some(mut write) = roster
                .get(id.as_str())
                .and_then(|child| dispose_completion(binding, &parent, child))
            {
                let target = &parent_observation.as_ref().ok_or(HostError::Uncertain)?.1;
                write.fence = Some(archive_fence(&parent, target.clone(), custody, None));
                return Ok(ArchiveStep::Write(write));
            }
            if let Some((view, fence, state)) = observation {
                if state == RetainedThread::Gone {
                    member.close(Closure::Gone);
                    continue;
                }
                let view = view.ok_or(HostError::Uncertain)?;
                if view.archived() {
                    if fence
                        .row
                        .as_deref()
                        .is_some_and(|row| row_activity(row) == RowChildren::Quiet)
                    {
                        member.close(Closure::observed(&view));
                    } else {
                        unresolved.get_or_insert_with(|| ArchiveWait::Child(id.clone()));
                    }
                } else if member.owned {
                    let thread = id.clone();
                    return Ok(archive(binding, &thread, view.sequence(), fence, custody));
                } else {
                    unresolved.get_or_insert_with(|| ArchiveWait::Child(id.clone()));
                }
            }
        }
        if let Some(cause) = unresolved {
            return Ok(ArchiveStep::Wait(cause));
        }
        if let Some((sequence, run)) = parent_archive {
            let target = parent_observation
                .as_ref()
                .ok_or(HostError::Uncertain)?
                .1
                .clone();
            custody.roster_run = Some(run.into());
            return Ok(archive(binding, &parent, sequence, target, custody));
        }
        Ok(if custody.closed(&parent) {
            ArchiveStep::Finished
        } else if dormant {
            ArchiveStep::Wait(ArchiveWait::ParentInventory)
        } else {
            ArchiveStep::Wait(ArchiveWait::ParentRoster)
        })
    }

    /// Read positive delivery evidence for the exact frozen parent messages.
    ///
    /// # Errors
    /// Returns an error when the native projection or binding cannot be read.
    pub async fn parent_deliveries_observed(
        &self,
        binding: &Binding,
        provider: &str,
        commands: &[String],
    ) -> Result<bool, HostError> {
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let Some(projection) = self.thread(binding, &thread).await? else {
            return Ok(false);
        };
        projection.require_parent_provider(provider)?;
        Ok(commands
            .iter()
            .all(|command| projection.has_delivery(&message_id(command))))
    }

    /// Read the parent, or prepare one guarded write to establish its held turn.
    /// A missing root or uncertain projection waits for another pass.
    /// # Errors
    /// Returns an error for a failed native read or a mismatched parent.
    pub async fn prepare_parent<'a>(
        &self,
        binding: &Binding,
        provider: &str,
        title: &str,
        prior_turn: Option<ParentAttempt<'_>>,
        catalogue: impl Future<Output = Result<&'a ProfileCatalog, HostError>> + Send,
    ) -> Result<ParentStep, HostError> {
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let (projection, fence) = self.observe_parent(binding, &thread).await?;
        if let Some(projection) = projection {
            projection.require_parent_provider(provider)?;
            let mut replay = None;
            if let Some((run, node)) = prior_turn
                .as_ref()
                .and_then(|attempt| projection.live_parent_run(&message_id(attempt.command)))
            {
                return Ok(ParentStep::Live(ParentRun {
                    thread,
                    run: run.into(),
                    node: node.into(),
                }));
            }
            if let Some(attempt) = prior_turn.as_ref()
                && !(attempt.released && projection.archived_in_shell())
            {
                let message = message_id(attempt.command);
                let completed = projection.turn_completed(&message);
                if projection.turn_failed(&message) {
                    return Ok(ParentStep::Failed);
                }
                if !completed {
                    if projection.has_delivery(&message) {
                        return Ok(ParentStep::Wait);
                    }
                    // The bounded window cannot prove absence. T3 deduplicates
                    // this exact message command, including a delayed receipt.
                    if !attempt.command.starts_with(&format!("{thread}-hold-")) {
                        return Ok(ParentStep::DeliveryUnknown);
                    }
                    replay = Some(attempt.command);
                }
            }
            if matches!(
                projection.retained(),
                Ok(RetainedThread::Busy | RetainedThread::Gone)
            ) {
                return Ok(ParentStep::Wait);
            }
            let sequence = projection.sequence();
            if projection.archived() {
                if projection.retained()? != RetainedThread::Idle {
                    return Ok(ParentStep::Wait);
                }
                return Ok(ParentStep::Write(ParentWrite {
                    binding: binding.clone(),
                    rpc: "orchestration.dispatchCommand",
                    idle_at: Some((thread.clone(), sequence)),
                    delivery: None,
                    fence: None,
                    payload: json!({"type":"thread.unarchive", "threadId":thread, "commandId":format!("{thread}-unarchive-{sequence}")}),
                }));
            }
            let command = replay.map_or_else(|| format!("{thread}-hold-{sequence}"), str::to_owned);
            return Ok(ParentStep::Write(ParentWrite {
                binding: binding.clone(),
                rpc: "orchestration.dispatchCommand",
                idle_at: Some((thread.clone(), sequence)),
                fence: None,
                delivery: prepare_delivery(&projection, provider, fence.row)?,
                payload: json!({
                    "type":"message.dispatch", "commandId":command, "threadId":thread,
                    "messageId":message_id(&command), "text":parent_hold_prompt(&command), "attachments":[],
                    "createdBy":"user", "creationSource":"server",
                    "dispatchMode":{"type":"queue_after_active"}
                }),
            }));
        }

        if prior_turn.is_some() {
            return Ok(ParentStep::DeliveryUnknown);
        }
        if !catalogue.await?.supports_parent(provider) {
            return Err(HostError::Configuration);
        }
        let command = format!("{thread}-launch");
        Ok(ParentStep::Write(ParentWrite {
            binding: binding.clone(),
            rpc: "orchestration.launchThread",
            idle_at: None,
            delivery: None,
            fence: None,
            payload: json!({
                "commandId":command, "threadId":thread, "projectId":binding.project_id,
                "title":title, "modelSelection":{"instanceId":provider,"model":"nucleus"},
                "runtimeMode":"full-access", "interactionMode":"default",
                "workspaceStrategy":{
                    "type":"existing_worktree", "worktreePath":binding.worktree_path,"branch":binding.branch,
                },
                "initialMessage":{"messageId":message_id(&command),"text":parent_hold_prompt(&command),"attachments":[]}
            }),
        }))
    }

    async fn observe_parent(
        &self,
        binding: &Binding,
        thread: &str,
    ) -> Result<(Option<Projection>, ThreadFence), HostError> {
        let policy = if self.rpc.uses_held_shell() {
            ThreadRead::Observation
        } else {
            ThreadRead::Exact
        };
        self.observe_thread(binding, thread, policy).await
    }

    /// Execute the prepared parent write after the service's destination gate.
    /// # Errors
    /// Returns an error if the native receipt cannot be confirmed.
    pub async fn write_parent(&self, write: ParentWrite) -> Result<(), HostError> {
        self.write_parent_receipt(write).await.map(|_| ())
    }

    /// Execute a guarded closeout effect and return only a proven archive receipt.
    /// # Errors
    /// Returns an error when the preflight fails or T3 does not confirm acceptance.
    pub async fn write_parent_receipt(
        &self,
        mut write: ParentWrite,
    ) -> Result<Option<ArchiveReceipt>, HostError> {
        self.verify_parent_write(&mut write).await?;
        self.write_verified_parent(write)
            .await
            .map_err(|error| match error {
                ParentSendError::NotSent(cause) | ParentSendError::Unknown(cause) => cause,
            })
    }

    /// Verify the destination before the owner records the send intent.
    /// # Errors
    /// Returns an error if the current binding, custody or visibility changed.
    pub async fn verify_parent_write(&self, write: &mut ParentWrite) -> Result<(), HostError> {
        if let Some(fence) = &write.fence {
            return if fence.holds(self) {
                Ok(())
            } else {
                Err(HostError::Uncertain)
            };
        }
        if let Some((thread, sequence)) = &write.idle_at {
            if self.rpc.uses_held_shell()
                && let Some(delivery) = &write.delivery
                && delivery.shell.is_some()
            {
                self.check_delivery_shell(thread, delivery)?;
                return verify_delivery_visibility(
                    delivery.row.visibility,
                    *sequence,
                    Some(delivery.row.sequence),
                );
            }

            let refuse = |predicate, observed| HostError::ParentPreflight {
                predicate,
                prepared: *sequence,
                observed,
            };
            let shell = write
                .delivery
                .as_ref()
                .and_then(|_| self.rpc.thread_row(thread));
            let Some(fresh) =
                self.thread(&write.binding, thread)
                    .await
                    .map_err(|error| match error {
                        HostError::Binding => {
                            refuse("thread/project/checkout binding no longer matches", None)
                        }
                        _ => error,
                    })?
            else {
                return Err(refuse("parent thread is absent", None));
            };
            let observed = Some(fresh.sequence());
            if let Some(delivery) = &mut write.delivery {
                let matches = fresh.parent_binding(&delivery.provider);
                if matches != [true; 3] {
                    return Err(HostError::ParentBindingMismatch {
                        prepared: *sequence,
                        observed: fresh.sequence(),
                        matches,
                    });
                }
                let custody = fresh
                    .delivery_custody()
                    .map_err(|predicate| refuse(predicate, observed))?;
                if custody != delivery.custody {
                    return Err(refuse(
                        "latest run or active provider thread changed",
                        observed,
                    ));
                }
                let Some(row) = fresh.row_observation()? else {
                    return Err(refuse("parent row is unavailable", observed));
                };
                verify_delivery_visibility(row.visibility, *sequence, observed)?;
                delivery.row = row;
                delivery.shell = shell;
            } else if fresh.retained()? != RetainedThread::Idle || fresh.sequence() != *sequence {
                return Err(refuse(
                    "idle custody or exact revision changed for archive/unarchive",
                    observed,
                ));
            }
        }
        Ok(())
    }

    /// Send the verified effect, checking any newer shell evidence at the wire.
    /// # Errors
    /// Returns an error if T3 cannot confirm the command.
    pub async fn write_verified_parent(
        &self,
        write: ParentWrite,
    ) -> Result<Option<ArchiveReceipt>, ParentSendError> {
        let archive = write
            .fence
            .as_ref()
            .and_then(|fence| Some((fence, fence.archive_from?, write.command_id()?.to_owned())));
        match self
            .rpc
            .write_guarded(write.rpc, write.payload, Read::One, || {
                if write.fence.as_ref().is_some_and(|fence| !fence.holds(self)) {
                    return Err(HostError::Deferred {
                        until: tokio::time::Instant::now(),
                    });
                }
                if let (Some(delivery), Some((thread, _))) = (&write.delivery, &write.idle_at) {
                    self.check_delivery_shell(thread, delivery)?;
                }
                Ok(())
            })
            .await?
        {
            Reply::Value(reply) => {
                let Some((fence, predecessor, command)) = archive else {
                    return Ok(None);
                };
                let sequence = reply["sequence"]
                    .as_u64()
                    .filter(|&sequence| sequence > predecessor)
                    .ok_or(ParentSendError::Unknown(HostError::Uncertain))?;
                let row = fence.target.row.as_deref();
                Ok(Some(ArchiveReceipt {
                    binding: write.binding,
                    scope: fence.custody.scope.clone(),
                    thread: fence.thread.clone(),
                    acceptance: ArchiveAcceptance {
                        command,
                        predecessor,
                        updated_at: row
                            .and_then(|row| row["updatedAt"].as_str())
                            .map(str::to_owned),
                        latest_run: row.and_then(roster_run).map(str::to_owned),
                        sequence,
                    },
                }))
            }
            Reply::Failure(_) => Err(ParentSendError::Unknown(HostError::Uncertain)),
        }
    }

    fn check_delivery_shell(
        &self,
        thread: &str,
        delivery: &ParentDelivery,
    ) -> Result<(), HostError> {
        let (row, observed) = self.rpc.thread_row_with_revision(thread);
        if delivery.shell == row {
            return Ok(());
        }
        let refuse = |predicate| HostError::ParentPreflight {
            predicate,
            prepared: delivery.row.sequence,
            observed,
        };
        let (Some(prior), Some(row)) = (&delivery.shell, row) else {
            return Err(refuse(
                "held shell added or lost the parent after verification",
            ));
        };
        let (before, after) = (ShellCustody(prior), ShellCustody(&row));
        if let Some(field) = before.changed_field(&after) {
            static DIAGNOSTIC_HASH: OnceLock<RandomState> = OnceLock::new();
            let digest = DIAGNOSTIC_HASH.get_or_init(RandomState::new);
            return Err(HostError::ParentShellChanged {
                field,
                prepared: delivery.row.sequence,
                observed,
                before: digest.hash_one(prior.get(field).map(Value::to_string)),
                after: digest.hash_one(row.get(field).map(Value::to_string)),
                activity_before: before.activity(),
                activity_now: after.activity(),
            });
        }
        let visibility: ThreadVisibility = serde_json::from_value((*row).clone())
            .map_err(|_| refuse("held shell visibility is invalid"))?;
        let visibility = visibility
            .read()
            .map_err(|_| refuse("held shell visibility is invalid"))?;
        verify_delivery_visibility(visibility, delivery.row.sequence, observed)
    }
}

fn verify_delivery_visibility(
    visibility: RowVisibility,
    prepared: u64,
    observed: Option<u64>,
) -> Result<(), HostError> {
    if visibility.settled {
        return Err(HostError::ParentPreflight {
            predicate: "parent row is still settled",
            prepared,
            observed,
        });
    }
    if let Some(until) = visibility.snoozed_until_ms
        && until > clock_ms()?
    {
        return Err(HostError::ParentSnoozed {
            until,
            revision: observed.unwrap_or(prepared),
        });
    }
    Ok(())
}

fn prepare_delivery(
    projection: &crate::Projection,
    provider: &str,
    shell: Option<Arc<Value>>,
) -> Result<Option<Box<ParentDelivery>>, HostError> {
    let Some(row) = projection.row_observation()? else {
        return Ok(None);
    };
    let custody =
        projection
            .delivery_custody()
            .map_err(|predicate| HostError::ParentPreflight {
                predicate,
                prepared: row.sequence,
                observed: Some(row.sequence),
            })?;
    Ok(Some(Box::new(ParentDelivery {
        row,
        provider: provider.into(),
        custody,
        shell: shell.filter(|listed| {
            projection.matches_shell_revision(listed)
                && row_activity(listed) == RowChildren::Quiet
                && crate::task_row::visibility(listed).ok() == Some(row.visibility)
        }),
    })))
}

fn archive_fence(
    thread: &str,
    target: ThreadFence,
    custody: &ArchiveCustody,
    archive_from: Option<u64>,
) -> Box<ParentFence> {
    Box::new(ParentFence {
        custody: custody.clone(),
        thread: thread.into(),
        target,
        archive_from,
    })
}

fn archive(
    binding: &Binding,
    thread: &str,
    sequence: u64,
    target: ThreadFence,
    custody: &ArchiveCustody,
) -> ArchiveStep {
    ArchiveStep::Write(Box::new(ParentWrite {
        binding: binding.clone(),
        rpc: "orchestration.dispatchCommand",
        idle_at: None,
        delivery: None,
        fence: Some(archive_fence(thread, target, custody, Some(sequence))),
        payload: json!({"type":"thread.archive", "threadId":thread, "commandId":format!("{thread}-archive-{sequence}")}),
    }))
}

fn dispose_completion(
    binding: &Binding,
    parent: &str,
    child: &Subagent,
) -> Option<Box<ParentWrite>> {
    let delivery = child.completion_delivery.as_ref()?;
    matches!(delivery.state.as_str(), "pending" | "claimed").then(|| {
        Box::new(ParentWrite {
            binding: binding.clone(),
            rpc: "orchestration.dispatchCommand",
            idle_at: None,
            delivery: None,
            fence: None,
            payload: json!({
                "type":"delegated_task.completion-delivery.dispose",
                "commandId":format!("{}-dispose", child.id),
                "parentThreadId":parent, "taskId":child.id,
            }),
        })
    })
}
