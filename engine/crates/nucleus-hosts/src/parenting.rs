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
use serde_json::{Value, json};

use crate::{
    Binding, HostError, ProfileCatalog, RowChildren, RowObservation, RowVisibility, T3, clock_ms,
    message_id,
    projection::{ParentCustody, Projection},
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
    binding: Binding,
    rpc: &'static str,
    payload: Value,
    idle_at: Option<(String, u64)>,
    delivery: Option<Box<ParentDelivery>>,
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

    #[must_use]
    pub fn prompt(&self) -> Option<&str> {
        if self.rpc == "orchestration.launchThread" {
            self.payload["initialMessage"]["text"].as_str()
        } else {
            self.payload["text"].as_str()
        }
    }

    /// Restore the original text for an already recorded native command.
    pub fn set_prompt(&mut self, prompt: String) {
        if self.rpc == "orchestration.launchThread" {
            self.payload["initialMessage"]["text"] = prompt.into();
        } else {
            self.payload["text"] = prompt.into();
        }
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
        let sequence = projection.sequence();
        let command = format!("{thread}-refresh-{sequence}");
        Ok(Some(ParentWrite {
            binding: binding.clone(),
            rpc: "orchestration.dispatchCommand",
            idle_at: Some((thread.clone(), sequence)),
            delivery: prepare_delivery(&projection, provider, fence.row)?,
            payload: json!({
                "type":"message.dispatch", "commandId":command, "threadId":thread,
                "messageId":message_id(&command), "text":REFRESH_TASK_ROW, "attachments":[],
                "createdBy":"user", "creationSource":"server",
                "dispatchMode":{"type":"queue_after_active"},
            }),
        }))
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
        start_line: &str,
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
                    payload: json!({"type":"thread.unarchive", "threadId":thread, "commandId":format!("{thread}-unarchive-{sequence}")}),
                }));
            }
            let command = replay.map_or_else(|| format!("{thread}-hold-{sequence}"), str::to_owned);
            return Ok(ParentStep::Write(ParentWrite {
                binding: binding.clone(),
                rpc: "orchestration.dispatchCommand",
                idle_at: Some((thread.clone(), sequence)),
                delivery: prepare_delivery(&projection, provider, fence.row)?,
                payload: json!({
                    "type":"message.dispatch", "commandId":command, "threadId":thread,
                    "messageId":message_id(&command), "text":start_line, "attachments":[],
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
            payload: json!({
                "commandId":command, "threadId":thread, "projectId":binding.project_id,
                "title":title, "modelSelection":{"instanceId":provider,"model":"nucleus"},
                "runtimeMode":"full-access", "interactionMode":"default",
                "workspaceStrategy":{
                    "type":"existing_worktree", "worktreePath":binding.worktree_path,"branch":binding.branch,
                },
                "initialMessage":{"messageId":message_id(&command),"text":start_line,"attachments":[]}
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
    pub async fn write_parent(&self, mut write: ParentWrite) -> Result<(), HostError> {
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
                    "idle custody or exact revision changed for unarchive",
                    observed,
                ));
            }
        }
        Ok(())
    }

    /// Send the verified effect, checking any newer shell evidence at the wire.
    /// # Errors
    /// Returns an error if T3 cannot confirm the command.
    pub async fn write_verified_parent(&self, write: ParentWrite) -> Result<(), ParentSendError> {
        match self
            .rpc
            .write_guarded(write.rpc, write.payload, Read::One, || {
                if let (Some(delivery), Some((thread, _))) = (&write.delivery, &write.idle_at) {
                    self.check_delivery_shell(thread, delivery)?;
                }
                Ok(())
            })
            .await?
        {
            Reply::Value(_) => Ok(()),
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
