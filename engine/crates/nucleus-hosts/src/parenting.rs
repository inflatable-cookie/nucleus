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
use serde_json::{Value, json};

use crate::{
    Binding, HostError, ProfileCatalog, RowObservation, RowVisibility, T3, clock_ms, message_id,
    projection::ParentCustody,
    rpc::{Read, Reply},
    task_row::ThreadVisibility,
    thread_snapshots::{ShellCustody, ThreadRead},
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
pub enum ParentSendError {
    NotSent(HostError),
    Unknown(HostError),
}

pub enum ArchiveStep {
    Finished,
    Write(ParentWrite),
    Wait,
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
        let Some(projection) = self.thread(binding, &thread).await? else {
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
            delivery: prepare_delivery(&projection, provider)?,
            payload: json!({
                "type":"message.dispatch", "commandId":command, "threadId":thread,
                "messageId":message_id(&command), "text":REFRESH_TASK_ROW, "attachments":[],
                "createdBy":"user", "creationSource":"server",
                "dispatchMode":{"type":"queue_after_active"},
            }),
        }))
    }

    /// Retire children before the parent, with a fresh complete read before
    /// each proposed mutation and readback on the next scheduler pass.
    /// # Errors
    /// Returns an error if identity or complete custody evidence is missing.
    pub async fn prepare_parent_archive(
        &self,
        binding: &Binding,
        provider: &str,
        retained: &[&str],
    ) -> Result<ArchiveStep, HostError> {
        let parent = parent_thread(Path::new(&binding.worktree_path));
        let snapshot = self
            .read_thread(binding, &parent, ThreadRead::Terminal)
            .await?;
        let mut children: BTreeMap<_, _> = retained.iter().map(|thread| (*thread, None)).collect();
        let mut sequence = None;
        if let Some(snapshot) = &snapshot
            && snapshot.retained()? != RetainedThread::Gone
        {
            snapshot.require_parent_provider(provider)?;
            sequence = Some(snapshot.sequence());
            if !snapshot.archived_in_shell() {
                for child in snapshot
                    .subagents()?
                    .iter()
                    .filter(|child| child.origin == "app_owned")
                {
                    if let Some(thread) = child.child_thread_id.as_deref() {
                        children.insert(thread, Some(child));
                    }
                }
            }
        }
        for (thread, child) in children {
            let Some(observed) = self
                .read_thread(binding, thread, ThreadRead::Terminal)
                .await?
            else {
                continue;
            };
            if !observed.belongs_to_parent(&parent, child.is_some()) {
                return Err(HostError::Binding);
            }
            match observed.retained()? {
                RetainedThread::Busy => return Ok(ArchiveStep::Wait),
                RetainedThread::Gone => continue,
                RetainedThread::Idle => {}
            }
            if let Some(child) = child
                && child
                    .completion_delivery
                    .as_ref()
                    .is_some_and(|state| matches!(state.state.as_str(), "pending" | "claimed"))
            {
                return Ok(ArchiveStep::Write(ParentWrite {
                    binding: binding.clone(),
                    rpc: "orchestration.dispatchCommand",
                    idle_at: None,
                    delivery: None,
                    payload: json!({
                        "type":"delegated_task.completion-delivery.dispose",
                        "commandId":format!("{}-dispose", child.id),
                        "parentThreadId":parent, "taskId":child.id,
                    }),
                }));
            }
            if !observed.archived() {
                return Ok(ArchiveStep::Write(archive(
                    binding,
                    thread,
                    observed.sequence(),
                )));
            }
        }

        let Some(fresh) = self
            .read_thread(binding, &parent, ThreadRead::Terminal)
            .await?
        else {
            return Ok(ArchiveStep::Finished);
        };
        match fresh.retained()? {
            RetainedThread::Gone => Ok(ArchiveStep::Finished),
            RetainedThread::Busy => Ok(ArchiveStep::Wait),
            RetainedThread::Idle => {
                fresh.require_parent_provider(provider)?;
                // A change since the child checks can be a new child or wake.
                if Some(fresh.sequence()) != sequence {
                    return Ok(ArchiveStep::Wait);
                }
                if fresh.archived() {
                    Ok(ArchiveStep::Finished)
                } else {
                    Ok(ArchiveStep::Write(archive(
                        binding,
                        &parent,
                        fresh.sequence(),
                    )))
                }
            }
        }
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
        if let Some(projection) = self.thread(binding, &thread).await? {
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
                delivery: prepare_delivery(&projection, provider)?,
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
    pub async fn write_verified_parent(&self, write: ParentWrite) -> Result<(), ParentSendError> {
        let mut reached_send = false;
        match self
            .rpc
            .call_guarded(write.rpc, write.payload, Read::One, || {
                if let (Some(delivery), Some((thread, _))) = (&write.delivery, &write.idle_at) {
                    self.check_delivery_shell(thread, delivery)?;
                }
                reached_send = true;
                Ok(true)
            })
            .await
        {
            Ok(Reply::Value(_)) => Ok(()),
            Ok(Reply::Failure(_)) => Err(ParentSendError::Unknown(HostError::Uncertain)),
            Err(cause) if reached_send => Err(ParentSendError::Unknown(cause)),
            Err(cause) => Err(ParentSendError::NotSent(cause)),
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
        shell: None,
    })))
}

fn archive(binding: &Binding, thread: &str, sequence: u64) -> ParentWrite {
    ParentWrite {
        binding: binding.clone(),
        rpc: "orchestration.dispatchCommand",
        idle_at: Some((thread.into(), sequence)),
        delivery: None,
        payload: json!({"type":"thread.archive", "threadId":thread, "commandId":format!("{thread}-archive-{sequence}")}),
    }
}
