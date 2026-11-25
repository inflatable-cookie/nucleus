use std::{
    future::Future,
    hash::{BuildHasher, RandomState},
    path::Path,
    sync::{Arc, OnceLock},
};

use nucleus_core::{
    RetainedThread,
    acp::{REFRESH_TASK_ROW, session_id},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    Binding, HostError, ProfileCatalog, RowChildren, RowObservation, RowVisibility, T3, clock_ms,
    launch::Method,
    message_id,
    projection::Projection,
    rpc::{Read, Reply, ThreadFence, closed_row},
    task_row::ThreadVisibility,
    thread_snapshots::{ShellCustody, ThreadRead, row_activity},
};

/// Evidence for the exact active turn and root node that can parent a child.
#[derive(Clone)]
pub struct ParentRun {
    pub(crate) thread: String,
    pub(crate) run: String,
    pub(crate) node: String,
}

/// An exact active run created by the current role's native user message.
#[derive(Clone, Debug)]
pub struct ActiveChild {
    pub(crate) binding: Binding,
    pub(crate) thread: String,
    pub(crate) instance: String,
    pub(crate) native: Option<String>,
}

impl ActiveChild {
    #[must_use]
    pub const fn binding(&self) -> &Binding {
        &self.binding
    }

    /// Prefix of the owned parent commands for this exact child launch.
    #[must_use]
    pub fn parent_command_prefix(&self) -> String {
        let thread = parent_thread(Path::new(&self.binding.worktree_path));
        format!(
            "{thread}-hold-acp-child-{:x}",
            Sha256::digest(&self.instance)
        )
    }
}

pub struct PruneWrite {
    pub thread: String,
    pub archived_ms: i64,
    inventory: ThreadFence,
}

pub enum ParentStep {
    Live(ParentRun),
    Failed,
    Delivered,
    DeliveryUnknown,
    Write(ParentWrite),
    AfterDelivery(ParentWrite),
    Wait,
}

pub struct ParentAttempt<'a> {
    pub command: &'a str,
    pub released: bool,
    pub replay_launch: bool,
}

/// Whether T3 could have delivered the write.
#[derive(Debug)]
pub enum ParentSendError {
    NotSent(HostError),
    Unknown(HostError),
    Rejected,
}

impl From<ParentSendError> for HostError {
    fn from(error: ParentSendError) -> Self {
        match error {
            ParentSendError::NotSent(cause) | ParentSendError::Unknown(cause) => cause,
            ParentSendError::Rejected => Self::Uncertain,
        }
    }
}

/// Next housekeeping action for the known threads of a Done task.
pub enum DoneArchive {
    Finished,
    Write(ArchiveWrite),
    Wait(String),
}

/// A listed, idle thread at the revision that authorized its archival.
pub struct ArchiveWrite {
    thread: String,
    command: String,
    marker: Arc<Value>,
}

/// Native mutation bound to the same project and checkout as the evidence.
pub struct ParentWrite {
    wire: FrozenParentWrite,
    idle_at: Option<(String, u64)>,
    delivery: Option<Box<ParentDelivery>>,
    owned_snoozes: Vec<u64>,
    reentry: Option<Box<ActiveChild>>,
    runtime: Option<String>,
}

/// Immutable inputs to a parent mutation. Live authorization is prepared separately.
#[derive(Serialize, Deserialize)]
pub struct FrozenParentWrite {
    binding: Binding,
    method: Method,
    payload: Value,
    provider: String,
}

impl FrozenParentWrite {
    #[must_use]
    pub fn matches(&self, binding: &Binding, provider: &str) -> bool {
        self.binding == *binding && self.provider == provider
    }

    #[must_use]
    pub fn prompt(&self) -> Option<&str> {
        if self.method == Method::Create {
            self.payload["initialMessage"]["text"].as_str()
        } else {
            self.payload["text"].as_str()
        }
    }
}

struct ParentDelivery {
    row: RowObservation,
    shell: Arc<Value>,
}

impl ParentWrite {
    fn new(binding: &Binding, provider: &str, method: Method, payload: Value) -> Self {
        Self {
            wire: FrozenParentWrite {
                binding: binding.clone(),
                method,
                payload,
                provider: provider.into(),
            },
            idle_at: None,
            delivery: None,
            owned_snoozes: Vec::new(),
            reentry: None,
            runtime: None,
        }
    }

    #[must_use]
    pub const fn binding(&self) -> &Binding {
        &self.wire.binding
    }

    #[must_use]
    pub fn command_id(&self) -> Option<&str> {
        self.wire.payload["commandId"].as_str()
    }

    #[must_use]
    pub fn thread_id(&self) -> Option<&str> {
        self.wire.payload["threadId"].as_str()
    }

    /// Pass the exact horizons owned by the task's existing presentation record.
    pub fn allow_owned_snoozes(&mut self, horizons: Vec<u64>) {
        self.owned_snoozes = horizons;
    }

    #[must_use]
    pub const fn freeze(&self) -> &FrozenParentWrite {
        &self.wire
    }

    /// Substitute the frozen wire while keeping the current preparation's guards.
    ///
    /// # Errors
    /// Returns a binding error when the prepared write has another destination or method.
    pub fn use_frozen(&mut self, frozen: FrozenParentWrite) -> Result<(), HostError> {
        if !frozen.matches(&self.wire.binding, &self.wire.provider)
            || self.wire.method != frozen.method
            || self.wire.payload["threadId"] != frozen.payload["threadId"]
            || self.wire.payload["type"] != frozen.payload["type"]
            || self.wire.payload["modelSelection"] != frozen.payload["modelSelection"]
        {
            return Err(HostError::Binding);
        }
        self.wire = frozen;
        Ok(())
    }

    pub fn require_runtime(&mut self, runtime: Option<String>) {
        self.runtime = runtime;
    }

    /// The row and ACP provider bound to a prepared message.
    #[must_use]
    pub fn delivery_row(&self) -> Option<(RowObservation, &str)> {
        self.delivery
            .as_ref()
            .map(|delivery| (delivery.row, self.wire.provider.as_str()))
    }

    #[must_use]
    pub fn starts_turn(&self) -> bool {
        self.wire.method == Method::Create || self.wire.payload["type"] == "message.dispatch"
    }
}

/// Identify holds whose command identity fixes the ACP routing on every replay.
#[must_use]
pub fn is_pinned_parent_hold(command: &str) -> bool {
    parent_hold_provider(command).is_some()
}

fn parent_hold_provider(command: &str) -> Option<&str> {
    let (_, pin) = command
        .strip_prefix("thread:nucleus-")?
        .split_once("-hold-acp-")?;
    let (revision, provider) = pin.split_once(':')?;
    (revision.parse::<u64>().is_ok() || revision.starts_with("child-"))
        .then_some(provider)
        .filter(|provider| !provider.is_empty())
}

#[must_use]
pub fn is_parent_reentry(command: &str) -> bool {
    is_pinned_parent_hold(command) && command.contains("-hold-acp-child-")
}

fn parent_hold(
    binding: &Binding,
    thread: &str,
    provider: &str,
    command: &str,
    prompt: &str,
) -> ParentWrite {
    ParentWrite::new(
        binding,
        provider,
        Method::Continue,
        json!({
            "type":"message.dispatch", "commandId":command, "threadId":thread,
            "messageId":message_id(command), "text":prompt, "attachments":[],
            "createdBy":"user", "creationSource":"server",
            "modelSelection":{"instanceId":provider,"model":"nucleus"},
            "dispatchMode":{"type":"queue_after_active"},
        }),
    )
}

fn parent_row_matches(row: &Value, binding: &Binding, provider: &str) -> bool {
    row["projectId"] == binding.project_id
        && row["worktreePath"] == binding.worktree_path
        && row["branch"] == binding.branch
        && row["parentThreadId"].is_null()
        && row["lineage"]["parentThreadId"].is_null()
        && row["providerInstanceId"] == provider
        && row["modelSelection"]["instanceId"] == provider
        && row["modelSelection"]["model"] == "nucleus"
}

fn parent_launch(
    binding: &Binding,
    provider: &str,
    thread: &str,
    title: &str,
    start_line: &str,
) -> ParentWrite {
    let command = format!("{thread}-launch");
    ParentWrite::new(
        binding,
        provider,
        Method::Create,
        json!({
            "commandId":command, "threadId":thread, "projectId":binding.project_id,
            "title":title, "modelSelection":{"instanceId":provider,"model":"nucleus"},
            "runtimeMode":"full-access", "interactionMode":"default",
            "workspaceStrategy":{
                "type":"existing_worktree", "worktreePath":binding.worktree_path,"branch":binding.branch,
            },
            "initialMessage":{"messageId":message_id(&command),"text":start_line,"attachments":[]}
        }),
    )
}

async fn initial_parent<'a>(
    binding: &Binding,
    provider: &str,
    thread: &str,
    title: &str,
    prompt: &str,
    attempt: Option<ParentAttempt<'_>>,
    catalogue: impl Future<Output = Result<&'a ProfileCatalog, HostError>> + Send,
) -> Result<ParentStep, HostError> {
    if attempt
        .as_ref()
        .is_some_and(|attempt| !attempt.replay_launch)
    {
        return Ok(ParentStep::DeliveryUnknown);
    }
    if !catalogue.await?.supports_parent(provider) {
        return Err(HostError::Configuration);
    }
    let write = parent_launch(binding, provider, thread, title, prompt);
    if attempt.is_some_and(|attempt| Some(attempt.command) != write.command_id()) {
        return Err(HostError::Binding);
    }
    Ok(ParentStep::Write(write))
}

fn unarchive_parent(binding: &Binding, thread: String, sequence: u64) -> ParentWrite {
    let payload = json!({"type":"thread.unarchive", "threadId":thread, "commandId":format!("{thread}-unarchive-{sequence}")});
    let mut write = ParentWrite::new(binding, "", Method::Continue, payload);
    write.idle_at = Some((thread, sequence));
    write
}

/// The deterministic native identity of the task's one visible thread.
#[must_use]
pub fn parent_thread(checkout: &Path) -> String {
    format!("thread:{}", session_id(checkout))
}

impl T3 {
    /// Run checkout retirement while the synchronized shell lists no active or unknown writers.
    ///
    /// # Errors
    /// Returns an error if the shell lost synchronization or a listed thread is not quiet.
    pub fn retire_with_quiet_shell<T>(
        &self,
        parent: &str,
        roles: &[&str],
        retire: impl FnOnce() -> T,
    ) -> Result<T, HostError> {
        self.rpc.with_shell(|shell| {
            let shell = shell.ok_or(HostError::Uncertain)?;
            let quiet = roles
                .iter()
                .copied()
                .chain(shell.children(parent))
                .all(|id| {
                    shell.marker(id).is_none_or(|row| {
                        !row["deletedAt"].is_null() || row_activity(&row) == RowChildren::Quiet
                    })
                });
            if !quiet {
                return Err(HostError::RowChildBusy);
            }
            Ok(retire())
        })
    }

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
        let Some(row) = projection.row_observation()? else {
            return Ok(None);
        };
        let Some(shell) = fence.row.filter(|listed| {
            projection.matches_shell_revision(listed)
                && row_activity(listed) == RowChildren::Quiet
                && crate::task_row::visibility(listed).ok() == Some(row.visibility)
        }) else {
            return Ok(None);
        };
        projection
            .delivery_custody()
            .map_err(|predicate| HostError::ParentPreflight {
                predicate,
                prepared: row.sequence,
                observed: Some(row.sequence),
            })?;
        let command = format!("{thread}-refresh-{}", row.sequence);
        let mut write = ParentWrite::new(
            binding,
            provider,
            Method::Continue,
            json!({
                "type":"message.dispatch", "commandId":command, "threadId":thread,
                "messageId":message_id(&command), "text":REFRESH_TASK_ROW, "attachments":[],
                "createdBy":"user", "creationSource":"server",
                "dispatchMode":{"type":"queue_after_active"},
            }),
        );
        write.delivery = Some(Box::new(ParentDelivery { row, shell }));
        Ok(Some(write))
    }

    /// Choose an idle, unarchived thread from the synchronized shell.
    ///
    /// # Errors
    /// Returns an error if a listed destination belongs to another checkout.
    pub fn prepare_archive(
        &self,
        binding: &Binding,
        reviewer: Option<&str>,
        worker: Option<&str>,
    ) -> Result<DoneArchive, HostError> {
        let parent = parent_thread(Path::new(&binding.worktree_path));
        self.rpc.with_shell(|shell| {
            let Some(shell) = shell else {
                return Ok(DoneArchive::Wait("Waiting for T3 to synchronize.".into()));
            };
            let mut wait = None;
            for (role, thread) in [
                ("reviewer", reviewer),
                ("worker", worker),
                ("task", Some(parent.as_str())),
            ] {
                let Some(thread) = thread else { continue };
                let Some(marker) = shell.marker(thread).filter(|row| !closed_row(row)) else {
                    continue;
                };
                if marker["projectId"] != binding.project_id
                    || marker["worktreePath"] != binding.worktree_path
                    || marker["branch"] != binding.branch
                {
                    return Err(HostError::Binding);
                }
                let reason = match row_activity(&marker) {
                    RowChildren::Active => format!("The {role} thread is still active in T3."),
                    RowChildren::Quiet => {
                        let updated = marker["updatedAt"].as_str().ok_or(HostError::Uncertain)?;
                        return Ok(DoneArchive::Write(ArchiveWrite {
                            thread: thread.into(),
                            command: format!("{thread}-archive-{updated}"),
                            marker,
                        }));
                    }
                    RowChildren::Unknown => {
                        format!("Waiting for T3 to show the {role} thread is idle.")
                    }
                };
                wait.get_or_insert(reason);
            }
            Ok(wait.map_or(DoneArchive::Finished, DoneArchive::Wait))
        })
    }

    /// Whether background retention can use a synchronized shell now.
    #[must_use]
    pub fn can_prune(&self) -> bool {
        self.request_retry_at().is_none() && self.rpc.with_shell(|shell| shell.is_some())
    }

    /// Read one native archive inventory against the synchronized shell.
    ///
    /// # Errors
    /// Returns an error if either view is unavailable.
    pub async fn prune_candidates(
        &self,
        owns: impl Fn(&str, i64) -> bool + Send + Sync,
        cutoff: u64,
    ) -> Result<(Vec<PruneWrite>, bool), HostError> {
        let before = self
            .rpc
            .with_shell(|shell| shell.map(|s| self.rpc.fence_at("", Some(s))))
            .ok_or(HostError::Uncertain)?;
        let Reply::Value(value) = self
            .rpc
            .call(
                "orchestration.getArchivedShellSnapshot",
                json!({}),
                Read::Background,
            )
            .await?
        else {
            return Err(HostError::Uncertain);
        };
        let rows = value["threads"].as_array().ok_or(HostError::Protocol)?;
        let mut candidates = Vec::new();
        for row in rows {
            let id = row["id"].as_str().ok_or(HostError::Protocol)?;
            let Some(at) = row["archivedAt"].as_str() else {
                continue;
            };
            let ms = crate::task_row::timestamp_ms(at)?;
            let stamp = i64::try_from(ms).map_err(|_| HostError::Protocol)?;
            if ms < cutoff && row.get("deletedAt").is_some_and(Value::is_null) && owns(id, stamp) {
                candidates.push(PruneWrite {
                    thread: id.into(),
                    archived_ms: stamp,
                    inventory: before.clone(),
                });
            }
        }
        candidates.sort_by(|a, b| (a.archived_ms, &a.thread).cmp(&(b.archived_ms, &b.thread)));
        let more = candidates.len() > 32;
        candidates.truncate(32);
        Ok((candidates, more))
    }

    /// Check the archive at the socket before sending its occurrence-specific command.
    ///
    /// # Errors
    /// Returns an error when the native write or its receipt is uncertain.
    pub async fn prune_thread(
        &self,
        write: &PruneWrite,
        claim: impl FnOnce() -> Result<bool, HostError> + Send,
    ) -> Result<bool, HostError> {
        let id = &write.thread;
        let payload = json!({"type":"thread.delete","threadId":id,"commandId":format!("{id}-delete-{}",write.archived_ms)});
        let mut sent = false;
        let reply = self
            .rpc
            .call_guarded(
                "orchestration.dispatchCommand",
                payload,
                Read::Background,
                || {
                    let same = self.rpc.with_shell(|shell| {
                        let Some(shell) = shell else { return false };
                        if let Some(row) = shell.marker(id) {
                            row.get("deletedAt").is_some_and(Value::is_null)
                                && row["archivedAt"]
                                    .as_str()
                                    .and_then(|at| crate::task_row::timestamp_ms(at).ok())
                                    == u64::try_from(write.archived_ms).ok()
                        } else {
                            // An unlisted row relies on the archive walk. Discard it after a
                            // shell change or reconnect, including unarchive then rearchive.
                            self.rpc.fence_at("", Some(shell)).matches(&write.inventory)
                        }
                    });
                    sent = same && claim()?;
                    Ok(sent)
                },
            )
            .await?;
        match reply {
            Reply::Value(_) => Ok(sent),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }

    /// Archive the prepared thread if its held row still matches at the wire.
    ///
    /// # Errors
    /// Returns an error if T3 refuses the command or delivery is uncertain.
    pub async fn write_archive(&self, write: ArchiveWrite) -> Result<bool, HostError> {
        let same_row = || {
            self.rpc
                .thread_row(&write.thread)
                .is_some_and(|current| Arc::ptr_eq(&current, &write.marker))
        };
        if !same_row() {
            return Ok(false);
        }
        let mut sent = false;
        let reply = self
            .rpc
            .call_guarded(
                "orchestration.dispatchCommand",
                json!({
                    "type": "thread.archive",
                    "threadId": write.thread,
                    "commandId": write.command,
                }),
                Read::Background,
                || {
                    sent = same_row();
                    Ok(sent)
                },
            )
            .await?;
        match reply {
            Reply::Value(_) => Ok(sent),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }

    /// Read the exact command-linked native evidence in one bounded parent observation.
    ///
    /// # Errors
    /// Returns an error when the parent evidence cannot be verified.
    pub async fn parent_delivery_receipts(
        &self,
        binding: &Binding,
        provider: &str,
        commands: Vec<String>,
    ) -> Result<Vec<String>, HostError> {
        let before = self.parent_runtime_hint().ok_or(HostError::Unavailable)?;
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let mut attempted = false;
        let observed = self
            .observe_thread_with(binding, &thread, ThreadRead::Exact, || attempted = true)
            .await;
        let (projection, _) = observed.map_err(|error| {
            if attempted && !matches!(error, HostError::Binding) {
                HostError::ParentReceiptInconclusive
            } else {
                error
            }
        })?;
        if self.parent_runtime_hint().as_ref() != Some(&before) {
            return Err(HostError::ParentReceiptInconclusive);
        }
        let Some(projection) = projection else {
            return Ok(Vec::new());
        };
        projection.require_parent_provider(provider)?;
        Ok(commands
            .into_iter()
            .filter(|command| projection.has_delivery(&message_id(command)))
            .collect())
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
        start_line: &str,
        prior_turn: Option<ParentAttempt<'_>>,
        catalogue: impl Future<Output = Result<&'a ProfileCatalog, HostError>> + Send,
    ) -> Result<ParentStep, HostError> {
        let thread = parent_thread(Path::new(&binding.worktree_path));
        if prior_turn.is_none()
            && let Some(write) = self.prepare_held_parent(binding, provider, &thread, start_line)?
        {
            return Ok(ParentStep::Write(write));
        }
        let (projection, _) = self.observe_parent(binding, &thread).await?;
        if let Some(projection) = projection {
            projection.require_parent_provider(provider)?;
            let mut replay = None;
            let mut completed_prior = false;
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
                completed_prior = projection.turn_completed(&message);
                if projection.turn_failed(&message) {
                    return Ok(ParentStep::Failed);
                }
                if !completed_prior {
                    if projection.has_delivery(&message) {
                        return Ok(ParentStep::Delivered);
                    }
                    // The bounded window cannot prove absence. T3 deduplicates
                    // this exact message command, including a delayed receipt.
                    if !is_pinned_parent_hold(attempt.command) {
                        return initial_parent(
                            binding, provider, &thread, title, start_line, prior_turn, catalogue,
                        )
                        .await;
                    }
                    replay = Some(attempt.command);
                }
            }
            if projection.deleted() {
                return Ok(ParentStep::Wait);
            }
            let sequence = projection.sequence();
            if projection.archived() {
                if projection.retained()? != RetainedThread::Idle {
                    return Ok(ParentStep::Wait);
                }
                return Ok(ParentStep::Write(unarchive_parent(
                    binding, thread, sequence,
                )));
            }
            if replay
                .and_then(parent_hold_provider)
                .is_some_and(|frozen| frozen != provider)
            {
                return Err(HostError::Binding);
            }
            let command = replay.map_or_else(
                || format!("{thread}-hold-acp-{sequence}:{provider}"),
                str::to_owned,
            );
            let write = parent_hold(binding, &thread, provider, &command, start_line);
            return Ok(if completed_prior {
                ParentStep::AfterDelivery(write)
            } else {
                ParentStep::Write(write)
            });
        }

        initial_parent(
            binding, provider, &thread, title, start_line, prior_turn, catalogue,
        )
        .await
    }

    fn prepare_held_parent(
        &self,
        binding: &Binding,
        provider: &str,
        thread: &str,
        start_line: &str,
    ) -> Result<Option<ParentWrite>, HostError> {
        if !self.rpc.uses_held_shell() {
            return Ok(None);
        }
        let (Some(row), Some(revision)) = self.rpc.thread_row_with_revision(thread) else {
            return Ok(None);
        };
        if !row["archivedAt"].is_null() || !row["deletedAt"].is_null() {
            return Ok(None);
        }
        if !parent_row_matches(&row, binding, provider) {
            return Err(HostError::Binding);
        }
        let command = format!("{thread}-hold-acp-{revision}:{provider}");
        Ok(Some(parent_hold(
            binding, thread, provider, &command, start_line,
        )))
    }

    /// A bound child is active only on positive run or background evidence.
    #[must_use]
    pub fn bound_child_active(&self, thread: &str, checkout: &Path) -> bool {
        self.held_child_active(thread, checkout, None)
    }

    #[must_use]
    pub fn retained_reentry_due(&self, thread: &str, checkout: &Path) -> bool {
        self.bound_child_active(thread, checkout)
            && self
                .rpc
                .thread_row(&parent_thread(checkout))
                .is_some_and(|row| parent_accepts_reentry(&row))
    }

    /// Recover the exact active role from a retained binding and its launch journal.
    ///
    /// # Errors
    /// Returns an error when the retained binding cannot be read.
    pub async fn retained_active_child(
        &self,
        binding: Binding,
        thread: String,
        instance: String,
    ) -> Result<Option<ActiveChild>, HostError> {
        let Some(projection) = self
            .read_thread(&binding, &thread, ThreadRead::Observation)
            .await?
        else {
            return Ok(None);
        };
        let message = if crate::child_origin_instance(&thread) == Some(instance.as_str()) {
            format!("message:delegated-task:{instance}")
        } else {
            message_id(&instance)
        };
        let native = projection.owned_active_run(&message).map(str::to_owned);
        let child = ActiveChild {
            binding,
            thread,
            instance,
            native,
        };
        Ok(self.active_child_in_shell(&child).then_some(child))
    }

    /// Prepare the first hold for this child or one new hold after an exact ended turn.
    /// A bounded read can confirm a matching command, but cannot authorize a new ID
    /// solely from the absence of the prior command.
    ///
    /// # Errors
    /// Returns an error when the observed parent does not match the configured ACP binding.
    pub async fn prepare_parent_reentry(
        &self,
        child: &ActiveChild,
        provider: &str,
        prompt: &str,
        prior: Option<&str>,
    ) -> Result<Option<ParentWrite>, HostError> {
        let binding = &child.binding;
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let Some(row) = self.rpc.thread_row(&thread) else {
            return Ok(None);
        };
        if !parent_accepts_reentry(&row) {
            return Ok(None);
        }
        if !parent_row_matches(&row, binding, provider) {
            return Err(HostError::Binding);
        }
        let latest = row["latestRunId"].as_str();
        let prefix = child.parent_command_prefix();
        let prior = prior.filter(|command| child_reentry_command(command, &prefix));
        if prior
            .and_then(parent_hold_provider)
            .is_some_and(|frozen| frozen != provider)
        {
            return Err(HostError::Binding);
        }
        let (projection, _) = self.observe_parent(binding, &thread).await?;
        let Some(projection) = projection else {
            return Ok(None);
        };
        projection.require_parent_provider(provider)?;
        if projection.has_pending_turn() || latest.is_some_and(|run| !projection.terminal_run(run))
        {
            return Ok(None);
        }
        let ended_owned = prior
            .and_then(|command| projection.ended_run_for_message(&message_id(command)))
            .or_else(|| {
                latest.filter(|run| {
                    projection
                        .ended_parent_message(run)
                        .and_then(|message| message.strip_suffix("-message"))
                        .is_some_and(|command| child_reentry_command(command, &prefix))
                })
            });
        let command = match (prior, ended_owned) {
            (Some(prior), _) if !projection.has_delivery(&message_id(prior)) => prior.to_owned(),
            (_, Some(native)) => format!("{prefix}-after-{:x}:{provider}", Sha256::digest(native)),
            (None, None) => format!("{prefix}:{provider}"),
            (Some(_), None) => return Ok(None),
        };
        let mut write = parent_hold(binding, &thread, provider, &command, prompt);
        write.reentry = Some(Box::new(child.clone()));
        Ok(Some(write))
    }

    pub(crate) fn active_child_in_shell(&self, child: &ActiveChild) -> bool {
        self.held_child_active(
            &child.thread,
            Path::new(&child.binding.worktree_path),
            Some(child),
        )
    }

    fn held_child_active(
        &self,
        thread: &str,
        checkout: &Path,
        exact: Option<&ActiveChild>,
    ) -> bool {
        self.rpc.thread_row(thread).is_some_and(|row| match exact {
            Some(child) => {
                row["projectId"] == child.binding.project_id
                    && row["worktreePath"] == child.binding.worktree_path
                    && row["branch"] == child.binding.branch
                    && child_activity(&row, child.native.as_deref())
            }
            None => {
                row["worktreePath"].as_str().map(Path::new) == Some(checkout)
                    && child_activity(&row, row["activeRunId"].as_str())
            }
        })
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

    async fn check_unarchive(&self, write: &ParentWrite) -> Result<(), HostError> {
        if let Some((thread, sequence)) = &write.idle_at {
            let fresh = self.thread(&write.wire.binding, thread).await?;
            let observed = fresh.as_ref().map(Projection::sequence);
            if fresh.is_none_or(|fresh| fresh.retained().ok() != Some(RetainedThread::Idle))
                || observed != Some(*sequence)
            {
                return Err(HostError::ParentPreflight {
                    predicate: "idle custody or exact revision changed for unarchive",
                    prepared: *sequence,
                    observed,
                });
            }
        }
        Ok(())
    }

    /// Send a verified parent effect and require the native sequence for any turn.
    ///
    /// # Errors
    /// Returns an error when the write is vetoed or native acceptance is uncertain.
    pub async fn write_parent(&self, write: ParentWrite) -> Result<(), ParentSendError> {
        self.check_unarchive(&write)
            .await
            .map_err(ParentSendError::NotSent)?;
        let expects_receipt = write.starts_turn();
        let thread_id = write.thread_id().map(str::to_owned);
        let launch_provider =
            (write.wire.method == Method::Create).then_some(write.wire.provider.as_str());
        let hold = write
            .command_id()
            .filter(|id| is_pinned_parent_hold(id))
            .map(|id| {
                (
                    id.to_owned(),
                    write.wire.payload["threadId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    write.wire.payload["modelSelection"]["instanceId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                )
            });
        match self
            .rpc
            .write_guarded(
                write.wire.method.rpc(),
                write.wire.payload,
                Read::One,
                write.runtime.as_deref(),
                || {
                    if let Some(runtime) = &write.runtime
                        && self.parent_runtime_hint().as_ref() != Some(runtime)
                    {
                        return Err(HostError::Uncertain);
                    }
                    if let Some(provider) = &launch_provider
                        && let Some(row) = thread_id
                            .as_deref()
                            .and_then(|thread| self.rpc.thread_row(thread))
                        && (closed_row(&row)
                            || !parent_row_matches(&row, &write.wire.binding, provider))
                    {
                        return Err(HostError::Binding);
                    }
                    if let (Some(delivery), Some(thread)) = (&write.delivery, thread_id.as_deref())
                    {
                        self.check_delivery_shell(thread, delivery, &write.owned_snoozes)?;
                    }
                    if let Some((_, thread, provider)) = &hold
                        && self.rpc.uses_held_shell()
                    {
                        let row = self.rpc.thread_row(thread).ok_or(HostError::Uncertain)?;
                        if !row["archivedAt"].is_null()
                            || !row["deletedAt"].is_null()
                            || !parent_row_matches(&row, &write.wire.binding, provider)
                        {
                            return Err(HostError::Binding);
                        }
                        if let Some(child) = &write.reentry
                            && (!self.active_child_in_shell(child) || !parent_accepts_reentry(&row))
                        {
                            return Err(HostError::Uncertain);
                        }
                        crate::task_row::check_delivery_snooze(&row, &write.owned_snoozes)?;
                    }
                    Ok(())
                },
            )
            .await?
        {
            Reply::Value(value) => {
                if expects_receipt
                    && (value["sequence"].as_u64().is_none()
                        || value["threadId"]
                            .as_str()
                            .is_some_and(|thread| Some(thread) != thread_id.as_deref()))
                {
                    return Err(ParentSendError::Unknown(HostError::Uncertain));
                }
                Ok(())
            }
            Reply::Failure(cause)
                if hold
                    .as_ref()
                    .is_some_and(|(command, _, _)| crate::dispatch_rejected(&cause, command)) =>
            {
                Err(ParentSendError::Rejected)
            }
            Reply::Failure(_) => Err(ParentSendError::Unknown(HostError::Uncertain)),
        }
    }

    fn check_delivery_shell(
        &self,
        thread: &str,
        delivery: &ParentDelivery,
        owned: &[u64],
    ) -> Result<(), HostError> {
        let (row, observed) = self.rpc.thread_row_with_revision(thread);
        let refuse = |predicate| HostError::ParentPreflight {
            predicate,
            prepared: delivery.row.sequence,
            observed,
        };
        let prior = &delivery.shell;
        let row = row.ok_or_else(|| refuse("held shell lost the parent after verification"))?;
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
        verify_delivery_visibility(visibility, delivery.row.sequence, observed, owned)
    }
}

fn child_reentry_command(command: &str, prefix: &str) -> bool {
    command
        .strip_prefix(prefix)
        .is_some_and(|suffix| suffix.starts_with(':') || suffix.starts_with("-after-"))
}

fn child_activity(row: &Value, native: Option<&str>) -> bool {
    !closed_row(row)
        && (ShellCustody(row).background() == Some(true)
            || (native.is_some_and(|run| row["activeRunId"] == run)
                && matches!(row["status"].as_str(), Some("running" | "waiting"))))
}

fn parent_accepts_reentry(row: &Value) -> bool {
    if closed_row(row) || !row["activeRunId"].is_null() || !row["pendingRuntimeRequest"].is_null() {
        return false;
    }
    matches!(
        (row["status"].as_str(), row["latestRunId"].as_str()),
        (Some("idle"), None)
            | (
                Some(
                    "waiting"
                        | "completed"
                        | "failed"
                        | "interrupted"
                        | "cancelled"
                        | "rolled_back"
                ),
                Some(_)
            )
    )
}

fn verify_delivery_visibility(
    visibility: RowVisibility,
    prepared: u64,
    observed: Option<u64>,
    owned: &[u64],
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
        && !owned.contains(&until)
    {
        return Err(HostError::ParentSnoozed {
            until,
            revision: observed.unwrap_or(prepared),
        });
    }
    Ok(())
}

impl crate::T3Pass<'_> {
    /// Check native and local process activity before removing a checkout.
    ///
    /// # Errors
    /// Returns an error if the host or process evidence is incomplete.
    pub async fn retirement_idle(
        &self,
        binding: &Binding,
        thread: &str,
    ) -> Result<bool, HostError> {
        let projection = self
            .host
            .read_thread(binding, thread, ThreadRead::Listed)
            .await?;
        self.quiet(binding, thread, projection.as_ref()).await
    }
}
