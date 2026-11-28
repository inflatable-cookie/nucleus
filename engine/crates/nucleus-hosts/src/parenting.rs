use std::{path::Path, sync::Arc};

use nucleus_core::acp::session_id;
use nucleus_core::{Role, Task};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    Binding, HostError, RowChildren, T3, clock_ms,
    launch::Method,
    message_id,
    rpc::{Read, Reply, Rpc, ShellRevision, ThreadFence, closed_row},
    task_row::timestamp_ms,
    thread_snapshots::{ShellCustody, ThreadRead, ThreadSnapshots, belongs_to, row_activity},
};

/// Evidence for the exact active turn and root node that can parent a child.
#[derive(Clone)]
pub struct ParentRun {
    pub(crate) thread: String,
    pub(crate) run: String,
    pub(crate) node: String,
}

pub struct PruneWrite {
    pub thread: String,
    pub archived_ms: i64,
    inventory: ThreadFence,
}

/// Parent turn evidence from the synchronized shell.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParentTurn {
    pub latest_run: Option<String>,
    pub finished_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub queued: bool,
    pub busy: bool,
}

impl ParentTurn {
    fn read(row: &Value) -> Self {
        let time = |field: &str| row[field].as_str().and_then(|at| timestamp_ms(at).ok());
        let status = row["status"].as_str();
        let finished_ms = matches!(
            status,
            Some("completed" | "failed" | "interrupted" | "cancelled" | "rolled_back")
        )
        .then(|| time("latestRunCompletedAt"))
        .flatten();
        Self {
            latest_run: row["latestRunId"].as_str().map(str::to_owned),
            finished_ms,
            duration_ms: time("latestRunStartedAt")
                .zip(finished_ms)
                .and_then(|(start, end)| end.checked_sub(start)),
            queued: status == Some("queued"),
            busy: status.is_none() || has_provider_turn(row),
        }
    }
}

fn has_provider_turn(row: &Value) -> bool {
    !row["activeRunId"].is_null()
        || !row["pendingRuntimeRequest"].is_null()
        || matches!(
            row["activityRunStatus"].as_str().or(row["status"].as_str()),
            Some("preparing" | "starting" | "pending" | "running" | "waiting")
        )
}

/// The shell baseline carried by a frozen parent hold.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HoldCheckpoint {
    pub after_run: Option<String>,
    pub recorded_at_ms: u64,
    pub short_turns: u8,
    pub preparing_launch: bool,
}

/// Shell choice for the task parent. Only the quiet case can start a turn.
#[derive(Debug)]
pub enum ParentShell {
    Missing,
    Archived,
    Deleted,
    Listed(ParentTurn),
}

/// Whether T3 could have delivered the write.
#[derive(Debug)]
pub enum ParentSendError {
    NotSent(HostError),
    Unknown(HostError),
    Rejected,
    InitialMessageRejected,
}

impl From<ParentSendError> for HostError {
    fn from(error: ParentSendError) -> Self {
        match error {
            ParentSendError::NotSent(cause) | ParentSendError::Unknown(cause) => cause,
            ParentSendError::Rejected | ParentSendError::InitialMessageRejected => Self::Uncertain,
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
    unarchive_fence: Option<ThreadFence>,
    owned_snoozes: Vec<u64>,
    turn: Option<ParentTurn>,
}

/// Operator visibility intent captured before a parent message can clear it.
#[derive(Serialize, Deserialize)]
pub struct ParentSnooze {
    binding: Binding,
    provider: String,
    pub thread: String,
    message: String,
    pub until: String,
    pub until_ms: u64,
    snoozed_at_ms: Option<u64>,
}

/// Reconciliation of one recorded operator horizon.
pub enum SnoozeRestoration {
    Complete,
    Pending,
    Rejected,
}

/// Immutable inputs to a parent mutation. Live authorization is prepared separately.
#[derive(Clone, Serialize, Deserialize)]
pub struct FrozenParentWrite {
    binding: Binding,
    method: Method,
    payload: Value,
    provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checkpoint: Option<HoldCheckpoint>,
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

    /// Advance to a fresh ID after T3 proves it rejected a turn command.
    pub fn replace_rejected_command(&mut self, initial_message: bool) -> Option<String> {
        let previous = self.payload["commandId"].as_str()?;
        let base = previous.split_once('~').map_or(previous, |(base, _)| base);
        let command = successor_command(base, previous);
        let prompt = self.prompt()?;
        let old_marker = hold_marker(previous);
        let prompt = prompt.strip_suffix(&old_marker).unwrap_or(prompt);
        if initial_message {
            let thread = self.payload["threadId"].as_str()?;
            let base = format!("{thread}-hold-acp-0:{}", self.provider);
            let command = successor_command(&base, previous);
            let mut replacement =
                parent_hold(&self.binding, thread, &self.provider, &command, prompt);
            replacement.wire.checkpoint = self.checkpoint.take();
            *self = replacement.wire;
            return Some(command);
        }
        let prompt = if self.checkpoint.is_some() || previous.contains("-hold-") {
            format!("{prompt}{}", hold_marker(&command))
        } else {
            prompt.to_owned()
        };
        self.payload["commandId"] = json!(command);
        let message = if self.method == Method::Create {
            &mut self.payload["initialMessage"]
        } else {
            &mut self.payload
        };
        message["messageId"] = json!(message_id(&command));
        message["text"] = json!(prompt);
        Some(command)
    }

    #[must_use]
    pub const fn checkpoint(&self) -> Option<&HoldCheckpoint> {
        self.checkpoint.as_ref()
    }
}

impl ParentWrite {
    fn new(binding: &Binding, provider: &str, method: Method, payload: Value) -> Self {
        Self {
            wire: FrozenParentWrite {
                binding: binding.clone(),
                method,
                payload,
                provider: provider.into(),
                checkpoint: None,
            },
            unarchive_fence: None,
            owned_snoozes: Vec::new(),
            turn: None,
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

    /// Reconstruct a pre-wire hold while keeping its original provider and message ID.
    ///
    /// # Errors
    /// Returns a binding error if a pinned command names another provider.
    pub fn use_legacy_intent(&mut self, command: &str, prompt: &str) -> Result<(), HostError> {
        if parent_hold_provider(command).is_some_and(|provider| provider != self.wire.provider) {
            return Err(HostError::Binding);
        }
        self.wire.payload["commandId"] = json!(command);
        if self.wire.method == Method::Create {
            self.wire.payload["initialMessage"]["text"] = json!(prompt);
            self.wire.payload["initialMessage"]["messageId"] = json!(message_id(command));
        } else {
            self.wire.payload["text"] = json!(prompt);
            self.wire.payload["messageId"] = json!(message_id(command));
        }
        Ok(())
    }

    /// Whether this write creates the task's visible T3 thread.
    #[must_use]
    pub fn creates_thread(&self) -> bool {
        self.wire.method == Method::Create
    }

    #[must_use]
    pub fn starts_turn(&self) -> bool {
        self.creates_thread() || self.wire.payload["type"] == "message.dispatch"
    }
}

/// Identify holds whose command identity fixes the ACP routing on every replay.
#[must_use]
pub fn is_pinned_parent_hold(command: &str) -> bool {
    parent_hold_provider(command).is_some()
}

fn parent_hold_provider(command: &str) -> Option<&str> {
    let command = command.split_once('~').map_or(command, |(base, _)| base);
    let (_, pin) = command
        .strip_prefix("thread:nucleus-")?
        .split_once("-hold-acp-")?;
    let (revision, provider) = pin.split_once(':')?;
    (revision.parse::<u64>().is_ok() || revision.starts_with("child-"))
        .then_some(provider)
        .filter(|provider| !provider.is_empty())
}

fn successor_command(base: &str, previous: &str) -> String {
    let fingerprint = format!("{:x}", Sha256::digest(previous));
    format!("{base}~{}", &fingerprint[..16])
}

fn hold_marker(command: &str) -> String {
    let fingerprint = format!("{:x}", Sha256::digest(command));
    format!(" [{}]", &fingerprint[..16])
}

fn parent_hold(
    binding: &Binding,
    thread: &str,
    provider: &str,
    command: &str,
    prompt: &str,
) -> ParentWrite {
    // ACP receives only text, so give holds with the same role label distinct prompts.
    let prompt = format!("{prompt}{}", hold_marker(command));
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
    binding.matches_shell_row(row)
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
    command: &str,
    title: &str,
    start_line: &str,
) -> ParentWrite {
    let prompt = format!("{start_line}{}", hold_marker(command));
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
            "initialMessage":{"messageId":message_id(command),"text":prompt,"attachments":[]}
        }),
    )
}

fn unarchive_parent(
    binding: &Binding,
    provider: &str,
    thread: &str,
    sequence: u64,
    fence: ThreadFence,
) -> ParentWrite {
    let payload = json!({"type":"thread.unarchive", "threadId":thread, "commandId":format!("{thread}-unarchive-{sequence}")});
    let mut write = ParentWrite::new(binding, provider, Method::Continue, payload);
    write.unarchive_fence = Some(fence);
    write
}

/// The deterministic native identity of the task's one visible thread.
#[must_use]
pub fn parent_thread(checkout: &Path) -> String {
    format!("thread:{}", session_id(checkout))
}

/// Closeout evidence that can be checked while a blocking checkout call mutates the disk.
pub struct QuietCheckout {
    rpc: Arc<Rpc>,
    binding: Binding,
    parent: String,
    threads: Vec<String>,
    missing: Vec<String>,
    revision: ShellRevision,
}

impl QuietCheckout {
    /// Run a mutation while the held shell still proves all task threads quiet.
    ///
    /// # Errors
    /// Returns an error if the shell or its evidence changed or a task thread is active.
    pub fn with_quiet_shell<T>(&self, mutate: impl FnOnce() -> T) -> Result<T, HostError> {
        self.rpc.with_shell(|shell| {
            let shell = shell.ok_or(HostError::Uncertain)?;
            check_live_threads(shell, &self.binding, &self.parent, &self.threads)?;
            if self.rpc.shell_revision(Some(shell)) != self.revision
                || self
                    .threads
                    .iter()
                    .any(|id| shell.marker(id).is_none() && !self.missing.contains(id))
            {
                return Err(HostError::Uncertain);
            }
            Ok(mutate())
        })
    }
}

fn check_quiet_thread(binding: &Binding, row: &Value) -> Result<(), HostError> {
    if !row["deletedAt"].is_string() && row_activity(row) != RowChildren::Quiet {
        return Err(HostError::RowChildBusy);
    }
    if !binding.matches_shell_row(row) {
        return Err(HostError::Binding);
    }
    Ok(())
}

fn check_live_threads(
    shell: &ThreadSnapshots,
    binding: &Binding,
    parent: &str,
    threads: &[impl AsRef<str>],
) -> Result<(), HostError> {
    for id in threads
        .iter()
        .map(AsRef::as_ref)
        .chain(shell.children(parent))
    {
        if let Some(row) = shell.marker(id) {
            check_quiet_thread(binding, &row)?;
        }
    }
    Ok(())
}

impl T3 {
    /// Check both shell inventories and resolve omitted bound threads before checkout closeout.
    ///
    /// # Errors
    /// Returns an error if any task thread is active, its binding differs, or the evidence is incomplete.
    pub async fn prepare_quiet_checkout(
        &self,
        binding: &Binding,
        task: &Task,
    ) -> Result<QuietCheckout, HostError> {
        let parent = parent_thread(Path::new(&binding.worktree_path));
        let threads: Vec<_> = [Role::Reviewer, Role::Worker]
            .into_iter()
            .filter_map(|role| task.threads().get(role))
            .chain(std::iter::once(parent.as_str()))
            .map(str::to_owned)
            .collect();
        let (revision, missing) = self.rpc.with_shell(|shell| {
            let shell = shell.ok_or(HostError::Uncertain)?;
            check_live_threads(shell, binding, &parent, &threads)?;
            let missing = threads
                .iter()
                .filter(|id| shell.marker(id).is_none())
                .cloned()
                .collect::<Vec<_>>();
            Ok::<_, HostError>((self.rpc.shell_revision(Some(shell)), missing))
        })?;
        // The live subscription omits archived descendants even when every bound role is visible.
        let archive = self.archived_shell().await?;
        let seq = archive["snapshotSequence"]
            .as_u64()
            .ok_or(HostError::Protocol)?;
        let rows = archive["threads"].as_array().ok_or(HostError::Protocol)?;
        if revision.1.is_none_or(|live| seq < live) {
            return Err(HostError::Uncertain);
        }
        for row in rows.iter().filter(|row| {
            belongs_to(row, &parent) || threads.iter().any(|id| row["id"] == id.as_str())
        }) {
            if row["archivedAt"].is_null() && row["deletedAt"].is_null() {
                return Err(HostError::Protocol);
            }
            check_quiet_thread(binding, row)?;
        }
        for id in &missing {
            if !rows.iter().any(|row| row["id"] == id.as_str()) {
                let (thread, _) = self.observe_thread(binding, id, ThreadRead::Exact).await?;
                if thread.is_some_and(|thread| !thread.deleted()) {
                    return Err(HostError::Uncertain);
                }
            }
        }
        let guard = QuietCheckout {
            rpc: self.rpc.clone(),
            binding: binding.clone(),
            parent,
            threads,
            missing,
            revision,
        };
        guard.with_quiet_shell(|| ())?;
        Ok(guard)
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
        let value = self.archived_shell().await?;
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
    pub async fn write_archive(
        &self,
        write: ArchiveWrite,
        dispatch_running: impl FnOnce() -> bool + Send,
    ) -> Result<bool, HostError> {
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
                    sent = same_row() && dispatch_running();
                    Ok(sent)
                },
            )
            .await?;
        match reply {
            Reply::Value(_) => Ok(sent),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }

    /// Read the task parent's turn from the held shell.
    ///
    /// # Errors
    /// Returns an error if the shell is unavailable or the parent belongs to another binding.
    pub fn parent_shell(
        &self,
        binding: &Binding,
        provider: &str,
    ) -> Result<ParentShell, HostError> {
        let thread = parent_thread(Path::new(&binding.worktree_path));
        self.rpc.with_shell(|shell| {
            let Some(row) = shell.ok_or(HostError::Uncertain)?.marker(&thread) else {
                return Ok(ParentShell::Missing);
            };
            if !parent_row_matches(&row, binding, provider) {
                return Err(HostError::Binding);
            }
            Ok(if !row["deletedAt"].is_null() {
                ParentShell::Deleted
            } else if !row["archivedAt"].is_null() {
                ParentShell::Archived
            } else {
                ParentShell::Listed(ParentTurn::read(&row))
            })
        })
    }

    /// A fresh parent needs the installed Nucleus ACP model.
    ///
    /// # Errors
    /// Returns an error if the provider is unavailable or cannot run that model.
    pub async fn check_parent_provider(&self, provider: &str) -> Result<(), HostError> {
        if !self.rpc.profile_catalog().await?.supports_parent(provider) {
            return Err(HostError::Configuration);
        }
        Ok(())
    }

    /// Construct the immutable parent message. The caller decides whether an ID may advance.
    #[must_use]
    pub fn prepare_parent_hold(
        binding: &Binding,
        provider: &str,
        title: &str,
        prompt: &str,
        shell: ParentShell,
        previous: Option<(&str, bool)>,
        checkpoint: HoldCheckpoint,
    ) -> Option<ParentWrite> {
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let launch = format!("{thread}-launch");
        let replay_launch = previous.is_some_and(|(prior, replace)| {
            !replace && prior.split_once('~').map_or(prior, |(base, _)| base) == launch
        });
        let mut write = match shell {
            ParentShell::Missing => {
                let base = launch;
                let command = hold_command(base, previous);
                parent_launch(binding, provider, &thread, &command, title, prompt)
            }
            ParentShell::Listed(turn) if !turn.busy => {
                let base = format!("{thread}-hold-acp-0:{provider}");
                let command = hold_command(base, previous);
                let mut write = if replay_launch {
                    parent_launch(binding, provider, &thread, &command, title, prompt)
                } else {
                    parent_hold(binding, &thread, provider, &command, prompt)
                };
                write.turn = Some(turn);
                write
            }
            _ => return None,
        };
        write.wire.checkpoint = Some(checkpoint);
        Some(write)
    }

    /// Find the exact live parent run and node needed by a delegated launch.
    ///
    /// # Errors
    /// Returns an error if a listed parent cannot be read with the configured binding.
    pub async fn live_parent(
        &self,
        binding: &Binding,
        provider: &str,
        command: &str,
    ) -> Result<Option<ParentRun>, HostError> {
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let Some(projection) = self
            .read_thread(binding, &thread, ThreadRead::Observation)
            .await?
        else {
            return Ok(None);
        };
        projection.require_parent_provider(provider)?;
        Ok(projection
            .live_parent_run(&message_id(command))
            .map(|(run, node)| ParentRun {
                thread,
                run: run.into(),
                node: node.into(),
            }))
    }

    /// Recover an archived task parent from the held or archived shell.
    ///
    /// # Errors
    /// Returns an error when the archived inventory cannot be read.
    pub async fn prepare_parent_unarchive(
        &self,
        binding: &Binding,
        provider: &str,
    ) -> Result<Option<ParentWrite>, HostError> {
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let revision = self
            .rpc
            .with_shell(|shell| shell.and_then(ThreadSnapshots::revision));
        let Some(sequence) = revision else {
            return Ok(None);
        };
        Ok(self
            .quiet_archive_at(&thread, sequence, |row| {
                parent_row_matches(row, binding, provider)
            })
            .await?
            .map(|fence| unarchive_parent(binding, provider, &thread, sequence, fence)))
    }

    /// A role with positive activity can still own its checkout during project removal.
    #[must_use]
    pub fn bound_child_active(&self, thread: &str, checkout: &Path) -> bool {
        self.rpc.thread_row(thread).is_some_and(|row| {
            !closed_row(&row)
                && row["worktreePath"].as_str().map(Path::new) == Some(checkout)
                && (ShellCustody(&row).background() == Some(true)
                    || (row["activeRunId"].is_string()
                        && matches!(row["status"].as_str(), Some("running" | "waiting"))))
        })
    }

    /// Whether a bound role in this task's checkout has a live turn or background work.
    #[must_use]
    pub fn parent_role_active(&self, thread: &str, checkout: &Path) -> bool {
        self.rpc.with_shell(|shell| {
            let Some(shell) = shell else { return false };
            let Some(child) = shell.marker(thread) else {
                return false;
            };
            !closed_row(&child)
                && child["worktreePath"].as_str().map(Path::new) == Some(checkout)
                && shell.marker(&parent_thread(checkout)).is_none_or(|parent| {
                    child["projectId"] == parent["projectId"] && child["branch"] == parent["branch"]
                })
                && (has_provider_turn(&child) || ShellCustody(&child).background() == Some(true))
        })
    }

    /// Send a verified parent effect and require the native sequence for any turn.
    ///
    /// # Errors
    /// Returns an error when the write is vetoed or native acceptance is uncertain.
    pub async fn write_parent(
        &self,
        write: ParentWrite,
        authorize: impl FnOnce(Option<ParentSnooze>) -> Result<(), HostError> + Send,
    ) -> Result<(), ParentSendError> {
        let expects_receipt = write.starts_turn();
        let thread_id = write.thread_id().map(str::to_owned);
        let launch_provider =
            (write.wire.method == Method::Create).then_some(write.wire.provider.as_str());
        let command = expects_receipt
            .then(|| {
                write.command_id().map(|id| {
                    let kind = if write.wire.method == Method::Create {
                        "thread.create"
                    } else {
                        "message.dispatch"
                    };
                    (id.to_owned(), kind)
                })
            })
            .flatten();
        let delivered_message = write.wire.payload["messageId"]
            .as_str()
            .or_else(|| write.wire.payload["initialMessage"]["messageId"].as_str())
            .map(str::to_owned);
        let reply = self
            .rpc
            .write_guarded(
                write.wire.method.rpc(),
                write.wire.payload,
                Read::One,
                || {
                    if let Some(fence) = &write.unarchive_fence
                        && thread_id
                            .as_deref()
                            .is_none_or(|thread| !self.rpc.same_thread(thread, fence))
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
                    if let Some(before) = &write.turn {
                        let thread = thread_id.as_deref().ok_or(HostError::Binding)?;
                        let row = self.rpc.thread_row(thread).ok_or(HostError::Uncertain)?;
                        if !row["archivedAt"].is_null()
                            || !row["deletedAt"].is_null()
                            || !parent_row_matches(&row, &write.wire.binding, &write.wire.provider)
                        {
                            return Err(HostError::Binding);
                        }
                        if ParentTurn::read(&row) != *before {
                            return Err(HostError::Uncertain);
                        }
                    }
                    let snooze = if let (Some(thread), Some(message)) =
                        (thread_id.as_deref(), delivered_message.as_deref())
                        && let Some(row) = self.rpc.thread_row(thread)
                        && let Some(until) = row["snoozedUntil"].as_str()
                        && let Ok(until_ms) = timestamp_ms(until)
                        && until_ms > clock_ms()?
                        && !write.owned_snoozes.contains(&until_ms)
                    {
                        Some(ParentSnooze {
                            binding: write.wire.binding.clone(),
                            provider: write.wire.provider.clone(),
                            thread: thread.into(),
                            message: message.into(),
                            until: until.into(),
                            until_ms,
                            snoozed_at_ms: row["snoozedAt"]
                                .as_str()
                                .and_then(|at| timestamp_ms(at).ok()),
                        })
                    } else {
                        None
                    };
                    authorize(snooze)
                },
            )
            .await;
        parent_send_result(
            reply?,
            expects_receipt,
            thread_id.as_deref(),
            command.as_ref().map(|(id, kind)| (id.as_str(), *kind)),
            &write.wire.binding.project_id,
        )
    }

    /// Reconcile a previously recorded horizon using the exact native message.
    ///
    /// # Errors
    /// Returns an error when the native observation or write is uncertain.
    pub async fn restore_parent_snooze(
        &self,
        intent: &ParentSnooze,
        attempt: i64,
        still_due: impl FnOnce() -> bool + Send,
    ) -> Result<SnoozeRestoration, HostError> {
        let thread = &intent.thread;
        let (projection, fence) = self
            .observe_thread(&intent.binding, thread, ThreadRead::Visibility)
            .await?;
        let Some(projection) = projection else {
            return Ok(SnoozeRestoration::Pending);
        };
        if projection.archived() || projection.deleted() || intent.until_ms <= clock_ms()? {
            return Ok(SnoozeRestoration::Complete);
        }
        projection.require_parent_provider(&intent.provider)?;
        let newer_wake = intent
            .snoozed_at_ms
            .zip(projection.last_snooze_wake_ms())
            .is_some_and(|(snoozed, woke)| woke > snoozed);
        let shown = projection
            .row_observation()?
            .and_then(|row| row.visibility.snoozed_until_ms);
        if newer_wake {
            return Ok(SnoozeRestoration::Complete);
        }
        if let Some(until) = shown {
            let shell_agrees = self
                .row_visibility_hint(thread)
                .is_some_and(|row| row.snoozed_until_ms == Some(until));
            return Ok(
                if shell_agrees
                    && (until != intent.until_ms || projection.has_delivery(&intent.message))
                {
                    SnoozeRestoration::Complete
                } else {
                    SnoozeRestoration::Pending
                },
            );
        }
        if !projection.has_delivery(&intent.message) {
            return Ok(SnoozeRestoration::Pending);
        }
        let command = format!(
            "{}-restore-snooze-{}-{}-{attempt}",
            intent.message,
            intent.until_ms,
            intent.snoozed_at_ms.unwrap_or_default()
        );
        let reply = self.rpc.call_guarded(
            "orchestration.dispatchCommand",
            json!({"type":"thread.snooze","commandId":command,"threadId":thread,"snoozedUntil":intent.until}),
            Read::Background,
            || Ok(self.rpc.same_thread(thread, &fence) && intent.until_ms > clock_ms()? && still_due()),
        ).await?;
        match reply {
            Reply::Failure(cause) if crate::command_rejected(&cause, &command, "thread.snooze") => {
                Ok(SnoozeRestoration::Rejected)
            }
            _ => Ok(SnoozeRestoration::Pending),
        }
    }
}

fn hold_command(base: String, previous: Option<(&str, bool)>) -> String {
    match previous {
        Some((prior, false)) => prior.into(),
        Some((prior, true)) => successor_command(&base, prior),
        None => base,
    }
}

fn parent_send_result(
    reply: Reply,
    expects_receipt: bool,
    thread: Option<&str>,
    command: Option<(&str, &str)>,
    project: &str,
) -> Result<(), ParentSendError> {
    match reply {
        Reply::Value(value) => {
            if expects_receipt
                && (value["sequence"].as_u64().is_none()
                    || value["threadId"]
                        .as_str()
                        .is_some_and(|actual| Some(actual) != thread))
            {
                return Err(ParentSendError::Unknown(HostError::Uncertain));
            }
            Ok(())
        }
        Reply::Failure(cause) => Err(command
            .and_then(|(id, kind)| parent_rejection(&cause, id, kind, project))
            .unwrap_or(ParentSendError::Unknown(HostError::Uncertain))),
    }
}

fn parent_rejection(cause: &Value, id: &str, kind: &str, project: &str) -> Option<ParentSendError> {
    if kind != "thread.create" {
        return crate::command_rejected(cause, id, kind).then_some(ParentSendError::Rejected);
    }
    crate::launch_rejection(cause, id, project).map(|rejected| match rejected {
        crate::LaunchRejection::Create => ParentSendError::Rejected,
        crate::LaunchRejection::InitialMessage => ParentSendError::InitialMessageRejected,
    })
}
