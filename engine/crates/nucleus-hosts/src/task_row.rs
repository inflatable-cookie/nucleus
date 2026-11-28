//! Native visibility facts and guarded T3 presentation commands.

use std::path::Path;

use serde::Deserialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    Binding, HostError, ParentSendError, SendOutcome, T3, TitleTarget, command_failure,
    command_rejected, defect_named, parent_thread, rpc::Reply,
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

pub(crate) fn check_delivery_snooze(row: &Value, owned: &[u64]) -> Result<(), HostError> {
    if let Some(until) = visibility(row)?.snoozed_until_ms
        && until > crate::clock_ms()?
        && !owned.contains(&until)
    {
        return Err(HostError::OperatorSnoozed { until });
    }
    Ok(())
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

impl T3 {
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
            .rpc
            .write_guarded(
                "orchestration.dispatchCommand",
                payload,
                crate::rpc::Read::Background,
                || {
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
                },
            )
            .await?;
        match reply {
            Reply::Value(_) => Ok(SendOutcome::Sent),
            Reply::Failure(cause) if refused(&cause, command, kind) => Ok(SendOutcome::Rejected),
            Reply::Failure(_) => Err(ParentSendError::Unknown(HostError::Uncertain)),
        }
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
