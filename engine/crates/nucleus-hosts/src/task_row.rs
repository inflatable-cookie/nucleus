//! Native visibility facts and guarded T3 presentation commands.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    Binding, HostError, ParentSendError, SendOutcome, T3, TitleTarget, clock_ms, command_failure,
    command_rejected, defect_named, parent_thread,
    rpc::{Read, Reply, closed_row},
};

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadVisibility {
    settled_override: Option<String>,
    pub(crate) settled_at: Option<String>,
    snoozed_until: Option<String>,
}

pub(crate) fn visibility(row: &Value) -> Result<RowVisibility, HostError> {
    ThreadVisibility::deserialize(row)
        .map_err(|_| HostError::Protocol)?
        .read()
}

/// Show a native snooze deadline with its time zone.
#[must_use]
pub fn snooze_deadline(until: u64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(until) * 1_000_000).map_or_else(
        |_| format!("{until} ms UTC"),
        |time| {
            format!(
                "{} {:02}:{:02} UTC",
                time.date(),
                time.hour(),
                time.minute()
            )
        },
    )
}

/// The host's current settle and snooze state for an available task row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowVisibility {
    pub settled: bool,
    pub snoozed_until_ms: Option<u64>,
}

impl ThreadVisibility {
    pub(crate) fn read(&self) -> Result<RowVisibility, HostError> {
        let settled_at = self.settled_at.as_deref().map(timestamp_ms).transpose()?;
        Ok(RowVisibility {
            settled: self.settled_override.as_deref() == Some("settled") || settled_at.is_some(),
            snoozed_until_ms: self
                .snoozed_until
                .as_deref()
                .map(timestamp_ms)
                .transpose()?,
        })
    }
}

/// Exact thread observation for presentation work, including its native revision.
#[derive(Debug, Clone, Copy)]
pub struct RowObservation {
    pub sequence: u64,
    pub visibility: RowVisibility,
}

/// Commands supported by native task-row reconciliation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowChange {
    SnoozeUntil(u64),
    Unsnooze,
}

/// What the held shell knows about a task row's role children.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RowChildren {
    Quiet,
    Unknown,
    Active,
}

/// Operator visibility captured before a native message can clear it.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeliverySnooze {
    // Older parent-only records carry their identity in binding and provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    binding: Option<Binding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(default)]
    destination: Value,
    pub thread: String,
    message: String,
    until: String,
    pub until_ms: u64,
    snoozed_at_ms: Option<u64>,
    #[serde(default)]
    observed_sequence: Option<u64>,
    #[serde(default)]
    accepted_sequence: Option<u64>,
    #[serde(default)]
    restored_sequence: Option<u64>,
}

/// Changes to the restoration journal at the native send boundary.
pub enum SnoozeUpdate {
    Record(String, Box<DeliverySnooze>),
    Accepted(String, u64),
    Discard(String),
}

/// Reconciliation of a recorded operator horizon.
#[derive(Debug)]
pub enum SnoozeRestoration {
    Complete,
    Pending,
    Rejected,
    Written(u64),
}

impl DeliverySnooze {
    pub(crate) fn sequence(reply: &Reply) -> Option<u64> {
        match reply {
            Reply::Value(value) => value["sequence"].as_u64(),
            Reply::Failure(_) => None,
        }
    }

    pub(crate) fn after_send(
        command: Option<String>,
        sequence: Option<u64>,
        refused: bool,
        mut record: impl FnMut(SnoozeUpdate) -> Result<(), HostError>,
    ) {
        let Some(command) = command else { return };
        let update = if refused {
            SnoozeUpdate::Discard(command)
        } else {
            let Some(sequence) = sequence else { return };
            SnoozeUpdate::Accepted(command, sequence)
        };
        if let Err(error) = record(update) {
            host_log!("operator snooze receipt: {error}");
        }
    }

    fn matches_row(&self, row: &Value) -> bool {
        if let Some(binding) = &self.binding {
            return binding.matches_shell_row(row)
                && row["providerInstanceId"].as_str() == self.provider.as_deref();
        }
        self.destination == snooze_destination(row)
    }
}

fn snooze_destination(row: &Value) -> Value {
    json!([
        row["projectId"],
        row["worktreePath"],
        row["branch"],
        row["pinnedAt"]
    ])
}

pub(crate) fn same_except_snooze(before: &Value, after: &Value) -> bool {
    let visibility = ["snoozedUntil", "snoozedAt", "lastSnoozeWakeAt"];
    if !visibility.iter().any(|&key| before[key] != after[key]) {
        return false;
    }
    let same_fields = |left: &Value, right: &Value| {
        left.as_object().is_some_and(|fields| {
            fields.iter().all(|(key, value)| {
                key == "updatedAt"
                    || visibility.contains(&key.as_str())
                    || right.get(key) == Some(value)
            })
        })
    };
    same_fields(before, after) && same_fields(after, before)
}

fn native_time(row: &Value, key: &str) -> Option<u64> {
    timestamp_ms(row[key].as_str()?).ok()
}

impl T3 {
    pub(crate) fn capture_snooze(
        &self,
        thread: &str,
        command: &str,
        message: &str,
        record: &mut impl FnMut(SnoozeUpdate) -> Result<(), HostError>,
    ) -> Result<(), HostError> {
        let (row, observed_sequence) = self.rpc.thread_row_with_revision(thread);
        let Some(row) = row.filter(|row| !closed_row(row)) else {
            return Ok(());
        };
        let Some(until) = row["snoozedUntil"].as_str() else {
            return Ok(());
        };
        let Ok(until_ms) = timestamp_ms(until) else {
            return Ok(());
        };
        if until_ms <= clock_ms()? {
            return Ok(());
        }
        record(SnoozeUpdate::Record(
            command.into(),
            Box::new(DeliverySnooze {
                binding: None,
                provider: None,
                destination: snooze_destination(&row),
                thread: thread.into(),
                message: message.into(),
                until: until.into(),
                until_ms,
                snoozed_at_ms: native_time(&row, "snoozedAt"),
                observed_sequence,
                accepted_sequence: None,
                restored_sequence: None,
            }),
        ))
    }

    /// Restore a cleared horizon from the held shell and the native send receipt.
    ///
    /// # Errors
    /// Returns an error on an invalid shell horizon or uncertain write outcome.
    pub async fn restore_delivery_snooze(
        &self,
        intent: &DeliverySnooze,
        attempt: i64,
        still_due: impl FnOnce() -> bool + Send,
    ) -> Result<SnoozeRestoration, HostError> {
        let thread = &intent.thread;
        let (fence, synchronized) = self
            .rpc
            .with_shell(|shell| (self.rpc.fence_at(thread, shell), shell.is_some()));
        let Some(row) = &fence.row else {
            return Ok(if synchronized {
                SnoozeRestoration::Complete
            } else {
                SnoozeRestoration::Pending
            });
        };
        // T3 can replay a receipt for a send that preceded this snooze.
        let predates_snooze = intent
            .accepted_sequence
            .zip(intent.observed_sequence)
            .is_some_and(|(accepted, observed)| accepted <= observed);
        if closed_row(row)
            || !intent.matches_row(row)
            || predates_snooze
            || intent.until_ms <= clock_ms()?
        {
            return Ok(SnoozeRestoration::Complete);
        }
        if let Some(sequence) = intent.restored_sequence {
            return Ok(if fence.at_or_after(sequence) {
                SnoozeRestoration::Complete
            } else {
                SnoozeRestoration::Pending
            });
        }
        let shown = visibility(row)?.snoozed_until_ms;
        if shown.is_some() {
            return Ok(
                if shown != Some(intent.until_ms)
                    || native_time(row, "snoozedAt") != intent.snoozed_at_ms
                {
                    SnoozeRestoration::Complete
                } else {
                    SnoozeRestoration::Pending
                },
            );
        }
        if !self.snooze_delivery_seen(intent, &fence) {
            return Ok(SnoozeRestoration::Pending);
        }
        let command = format!(
            "{}-restore-snooze-{}-{}-{attempt}",
            intent.message,
            intent.until_ms,
            intent.snoozed_at_ms.unwrap_or_default()
        );
        let reply = self.write_visibility(
            json!({"type":"thread.snooze","commandId":command,"threadId":thread,"snoozedUntil":intent.until}),
            || {
                if self.rpc.same_thread(thread, &fence) && intent.until_ms > clock_ms()? && still_due() {
                    Ok(())
                } else {
                    Err(HostError::Uncertain)
                }
            },
        ).await;
        match reply {
            Ok(Reply::Value(value)) => Ok(value["sequence"]
                .as_u64()
                .map_or(SnoozeRestoration::Pending, SnoozeRestoration::Written)),
            Ok(Reply::Failure(cause)) if refused(&cause, &command, "thread.snooze") => {
                Ok(SnoozeRestoration::Rejected)
            }
            Ok(Reply::Failure(_)) => Ok(SnoozeRestoration::Pending),
            Err(error) => Err(error.into()),
        }
    }

    fn snooze_delivery_seen(
        &self,
        intent: &DeliverySnooze,
        fence: &crate::rpc::ThreadFence,
    ) -> bool {
        if let Some(sequence) = intent.accepted_sequence {
            return fence.at_or_after(sequence);
        }
        // When a reply is lost, reuse exact message evidence from ordinary observation.
        self.rpc.with_shell(|shell| {
            shell.is_some_and(|shell| {
                shell.delivery_cleared_snooze(&intent.thread, &intent.message, intent.snoozed_at_ms)
            })
        })
    }

    /// Read attached and retained child activity from the synchronized shell.
    #[must_use]
    pub fn row_children(&self, parent: &str, roles: &[&str]) -> (RowChildren, u64) {
        self.rpc.with_shell(|view| {
            view.map_or((RowChildren::Unknown, 0), |view| {
                view.row_children(parent, roles)
            })
        })
    }

    /// Last delivered user message from the synchronized shell, without a native read.
    #[must_use]
    pub fn row_message_at(&self, thread: &str) -> Option<u64> {
        let row = self.rpc.thread_row(thread)?;
        timestamp_ms(row["latestUserMessageAt"].as_str()?).ok()
    }

    #[cfg(feature = "loopback-fixture")]
    #[doc(hidden)]
    pub fn fixture_held_shell(&self, item: &serde_json::Value) {
        self.rpc.fixture_shell(item);
    }

    /// Read the exact root, provider and visibility of a task's parent.
    ///
    /// # Errors
    /// Returns an error for a mismatched binding or unknown host read.
    pub async fn observe_task_row(
        &self,
        binding: &Binding,
        provider: &str,
    ) -> Result<Option<RowObservation>, HostError> {
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let Some(projection) = self
            .read_thread(binding, &thread, crate::thread_snapshots::ThreadRead::Exact)
            .await?
        else {
            return Ok(None);
        };
        let Some(observed) = projection.row_observation()? else {
            return Ok(None);
        };
        projection.require_parent_provider(provider)?;
        Ok(Some(observed))
    }

    /// Send a single recorded visibility command, rechecking any supplied shell proof.
    ///
    /// # Errors
    /// Returns an error for a changed shell binding or unknown native outcome.
    pub async fn write_row_visibility(
        &self,
        binding: &Binding,
        command: &str,
        change: RowChange,
        target: &TitleTarget,
        children: (&[&str], u64),
    ) -> Result<SendOutcome, ParentSendError> {
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let kind = match change {
            RowChange::SnoozeUntil(_) => "thread.snooze",
            RowChange::Unsnooze => "thread.unsnooze",
        };
        let mut payload = json!({"type":kind, "commandId":command, "threadId":thread});
        match change {
            RowChange::SnoozeUntil(until) => {
                let deadline =
                    OffsetDateTime::from_unix_timestamp_nanos(i128::from(until) * 1_000_000)
                        .map_err(|_| ParentSendError::NotSent(HostError::Protocol))?
                        .format(&Rfc3339)
                        .map_err(|_| ParentSendError::NotSent(HostError::Protocol))?;
                payload["snoozedUntil"] = deadline.into();
            }
            RowChange::Unsnooze => payload["reason"] = "user".into(),
        }
        let reply = self
            .write_visibility(payload, || {
                self.rpc.with_shell(|view| {
                    if matches!(change, RowChange::SnoozeUntil(_))
                        && view.is_none_or(|view| {
                            view.row_children(&thread, children.0)
                                != (RowChildren::Quiet, children.1)
                        })
                    {
                        return Err(HostError::RowChildBusy);
                    }
                    let current = view
                        .and_then(|view| target.row_in(view))
                        .ok_or(HostError::Binding)?;
                    if target.thread() != thread
                        || !std::sync::Arc::ptr_eq(&current, target.marker())
                    {
                        return Err(HostError::Binding);
                    }
                    Ok(())
                })
            })
            .await?;
        match reply {
            Reply::Value(_) => Ok(SendOutcome::Sent),
            Reply::Failure(cause) if refused(&cause, command, kind) => Ok(SendOutcome::Rejected),
            Reply::Failure(_) => Err(ParentSendError::Unknown(HostError::Uncertain)),
        }
    }
    async fn write_visibility(
        &self,
        payload: Value,
        check: impl FnOnce() -> Result<(), HostError> + Send,
    ) -> Result<Reply, ParentSendError> {
        self.rpc
            .write_guarded(
                "orchestration.dispatchCommand",
                payload,
                Read::Background,
                check,
            )
            .await
    }
}

fn refused(cause: &serde_json::Value, command: &str, kind: &str) -> bool {
    command_rejected(cause, command, kind)
        || command_failure(cause, command).is_some_and(|error| {
            error["_tag"] == "OrchestrationV2DispatchCommandError"
                && error["commandType"] == kind
                && defect_named(&error["cause"], "OrchestratorCommandRejectedError")
                && error["cause"]["commandId"] == command
                && error["cause"]["commandType"] == kind
        })
}

pub(crate) fn timestamp_ms(value: &str) -> Result<u64, HostError> {
    let time = OffsetDateTime::parse(value, &Rfc3339).map_err(|_| HostError::Protocol)?;
    u64::try_from(time.unix_timestamp_nanos() / 1_000_000).map_err(|_| HostError::Protocol)
}
