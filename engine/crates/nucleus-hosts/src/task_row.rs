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
    pub settled_at_ms: Option<u64>,
    pub snoozed_until_ms: Option<u64>,
}

impl ThreadVisibility {
    pub(crate) fn read(&self) -> Result<RowVisibility, HostError> {
        Ok(RowVisibility {
            settled: self.settled_override.as_deref() == Some("settled")
                || self.settled_at.is_some(),
            settled_at_ms: self.settled_at.as_deref().map(timestamp_ms).transpose()?,
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

/// Commands supported by native task-row reconciliation and explicit wake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowChange {
    SnoozeUntil(u64),
    Unsnooze,
    Unsettle,
}

/// What the held shell knows about a task row's role children.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RowChildren {
    Quiet,
    Unknown,
    Active,
}

impl T3 {
    /// Read activity from the held shell for recorded and attached role children.
    #[must_use]
    pub fn row_children(&self, parent: &str, roles: &[&str]) -> RowChildren {
        self.rpc.row_children(parent, roles)
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
        shell: Option<&TitleTarget>,
        quiet_roles: &[&str],
        parent: Option<(RowObservation, &str)>,
    ) -> Result<SendOutcome, ParentSendError> {
        let thread = parent_thread(Path::new(&binding.worktree_path));
        let kind = match change {
            RowChange::SnoozeUntil(_) => "thread.snooze",
            RowChange::Unsnooze => "thread.unsnooze",
            RowChange::Unsettle => "thread.unsettle",
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
            RowChange::Unsnooze | RowChange::Unsettle => payload["reason"] = "user".into(),
        }
        let reply = self
            .rpc
            .write_guarded(
                "orchestration.dispatchCommand",
                payload,
                if shell.is_some() {
                    crate::rpc::Read::Background
                } else {
                    crate::rpc::Read::One
                },
                || {
                    self.rpc.with_shell(|view| {
                        if matches!(change, RowChange::SnoozeUntil(_))
                            && view.is_none_or(|view| {
                                view.row_children(&thread, quiet_roles) != RowChildren::Quiet
                            })
                        {
                            return Err(HostError::RowChildBusy);
                        }
                        if let Some(target) = shell {
                            let current = view
                                .and_then(|view| target.row_in(view))
                                .ok_or(HostError::Binding)?;
                            if target.thread() != thread
                                || !std::sync::Arc::ptr_eq(&current, target.marker())
                            {
                                return Err(HostError::Binding);
                            }
                        } else if let Some(row) = view.and_then(|view| view.marker(&thread)) {
                            if crate::rpc::closed_row(&row)
                                || parent.is_none_or(|(expected, provider)| {
                                    row["projectId"] != binding.project_id
                                        || row["worktreePath"] != binding.worktree_path
                                        || row["branch"] != binding.branch
                                        || row["providerInstanceId"] != provider
                                        || visibility(&row).ok() != Some(expected.visibility)
                                })
                            {
                                return Err(HostError::Binding);
                            }
                        } else if self.rpc.uses_held_shell() {
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

fn timestamp_ms(value: &str) -> Result<u64, HostError> {
    let time = OffsetDateTime::parse(value, &Rfc3339).map_err(|_| HostError::Protocol)?;
    u64::try_from(time.unix_timestamp_nanos() / 1_000_000).map_err(|_| HostError::Protocol)
}
