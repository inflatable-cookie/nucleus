use std::{collections::BTreeMap, future::Future, path::Path};

use nucleus_core::{
    RetainedThread,
    acp::{REFRESH_TASK_ROW, parent_hold_prompt, session_id},
};
use serde_json::{Value, json};

use crate::{
    Binding, HostError, ProfileCatalog, RowObservation, T3, clock_ms, message_id,
    rpc::{Read, Reply},
    thread_snapshots::ThreadRead,
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
    Write(ParentWrite),
    Wait,
}

pub struct ParentAttempt<'a> {
    pub command: &'a str,
    pub released: bool,
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
    delivery: Option<RowObservation>,
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

    /// The current row state a prepared message would deliver over.
    #[must_use]
    pub const fn delivery_row(&self) -> Option<RowObservation> {
        self.delivery
    }

    /// Replace stale idle evidence after a visibility-only wake.
    pub fn after_row_wake(&mut self, row: RowObservation) {
        if let Some((_, sequence)) = &mut self.idle_at {
            *sequence = row.sequence;
            self.delivery = Some(row);
        }
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
        if projection.archived() || projection.retained()? != RetainedThread::Idle {
            return Ok(None);
        }
        let sequence = projection.sequence();
        let command = format!("{thread}-refresh-{sequence}");
        Ok(Some(ParentWrite {
            binding: binding.clone(),
            rpc: "orchestration.dispatchCommand",
            idle_at: Some((thread.clone(), sequence)),
            delivery: projection.row_observation()?,
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
            if let Some((run, node)) = prior_turn.as_ref().and_then(|attempt| {
                (!attempt.released)
                    .then(|| projection.live_parent_run(&message_id(attempt.command)))
                    .flatten()
            }) {
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
                if projection.turn_failed(&message) || (completed && !attempt.released) {
                    return Ok(ParentStep::Failed);
                }
                if !completed {
                    return Ok(ParentStep::Wait);
                }
            }
            if projection.retained()? != RetainedThread::Idle {
                return Ok(ParentStep::Wait);
            }
            let sequence = projection.sequence();
            if projection.archived() {
                return Ok(ParentStep::Write(ParentWrite {
                    binding: binding.clone(),
                    rpc: "orchestration.dispatchCommand",
                    idle_at: Some((thread.clone(), sequence)),
                    delivery: None,
                    payload: json!({"type":"thread.unarchive", "threadId":thread, "commandId":format!("{thread}-unarchive-{sequence}")}),
                }));
            }
            let command = format!("{thread}-hold-{sequence}");
            return Ok(ParentStep::Write(ParentWrite {
                binding: binding.clone(),
                rpc: "orchestration.dispatchCommand",
                idle_at: Some((thread.clone(), sequence)),
                delivery: projection.row_observation()?,
                payload: json!({
                    "type":"message.dispatch", "commandId":command, "threadId":thread,
                    "messageId":message_id(&command), "text":parent_hold_prompt(&command), "attachments":[],
                    "createdBy":"user", "creationSource":"server",
                    "dispatchMode":{"type":"queue_after_active"}
                }),
            }));
        }

        if prior_turn.is_some() {
            return Ok(ParentStep::Wait);
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
    pub async fn write_parent(&self, write: ParentWrite) -> Result<(), HostError> {
        if let Some((thread, sequence)) = &write.idle_at {
            let Some(fresh) = self.thread(&write.binding, thread).await? else {
                return Err(HostError::Uncertain);
            };
            if fresh.sequence() != *sequence || fresh.retained()? != RetainedThread::Idle {
                return Err(HostError::Uncertain);
            }
            let now = clock_ms()?;
            if write.delivery.is_some()
                && fresh.row_observation()?.is_none_or(|fresh| {
                    fresh.visibility.settled
                        || fresh
                            .visibility
                            .snoozed_until_ms
                            .is_some_and(|until| until > now)
                })
            {
                return Err(HostError::Uncertain);
            }
        }
        match self.rpc.call(write.rpc, write.payload, Read::One).await? {
            Reply::Value(_) => Ok(()),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }
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
