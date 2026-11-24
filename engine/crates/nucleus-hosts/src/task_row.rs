//! Native visibility facts and guarded T3 presentation commands.

use std::path::Path;

use serde::Deserialize;
use serde_json::json;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    Binding, HostError, SendOutcome, T3, TitleTarget, command_failure, command_rejected,
    defect_named, parent_thread,
    rpc::{Read, Reply},
};

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadVisibility {
    settled_override: Option<String>,
    settled_at: Option<String>,
    snoozed_until: Option<String>,
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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowChildren {
    Quiet,
    Active,
    Unknown,
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
    ) -> Result<SendOutcome, HostError> {
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
                        .map_err(|_| HostError::Protocol)?
                        .format(&Rfc3339)
                        .map_err(|_| HostError::Protocol)?;
                payload["snoozedUntil"] = deadline.into();
            }
            RowChange::Unsnooze | RowChange::Unsettle => payload["reason"] = "user".into(),
        }
        let hint = self.row_visibility_hint(&thread);
        let reply = self
            .rpc
            .call_guarded("orchestration.dispatchCommand", payload, Read::One, || {
                if matches!(change, RowChange::SnoozeUntil(_))
                    && self.row_children(&thread, quiet_roles) != RowChildren::Quiet
                {
                    return Err(HostError::RowChildBusy);
                }
                if shell.is_some_and(|target| {
                    !target.matches_current_visibility(self) || target.thread() != thread
                }) || (hint.is_some() && self.row_visibility_hint(&thread) != hint)
                {
                    return Err(HostError::Binding);
                }
                Ok(true)
            })
            .await?;
        match reply {
            Reply::Value(_) => Ok(SendOutcome::Sent),
            Reply::Failure(cause) if refused(&cause, command, kind) => Ok(SendOutcome::Rejected),
            Reply::Failure(_) => Err(HostError::Uncertain),
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
