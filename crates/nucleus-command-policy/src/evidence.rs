//! Sanitized command execution evidence types.

use crate::ids::{CommandEvidenceId, CommandRequestId};

/// Sanitized command evidence retained by Nucleus.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandEvidence {
    pub id: CommandEvidenceId,
    pub request_id: CommandRequestId,
    pub status: CommandExecutionStatus,
    pub exit_status: Option<i32>,
    pub retention: CommandOutputRetention,
    pub summary: Option<String>,
    pub stdout_artifact_ref: Option<String>,
    pub stderr_artifact_ref: Option<String>,
}

/// Command execution status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandExecutionStatus {
    Accepted,
    Rejected,
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    BlockedByPolicy,
}

/// How command output is retained.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandOutputRetention {
    Discard,
    SummaryOnly,
    ArtifactReference,
    FullArtifactWithApproval,
}
