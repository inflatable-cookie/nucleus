use nucleus_command_policy::{CommandExecutionStatus, CommandOutputRetention};

pub(crate) fn command_status_label(status: &CommandExecutionStatus) -> &'static str {
    match status {
        CommandExecutionStatus::Accepted => "accepted",
        CommandExecutionStatus::Rejected => "rejected",
        CommandExecutionStatus::Queued => "queued",
        CommandExecutionStatus::Running => "running",
        CommandExecutionStatus::Succeeded => "succeeded",
        CommandExecutionStatus::Failed => "failed",
        CommandExecutionStatus::Cancelled => "cancelled",
        CommandExecutionStatus::TimedOut => "timed_out",
        CommandExecutionStatus::BlockedByPolicy => "blocked_by_policy",
    }
}

pub(crate) fn retention_label(retention: &CommandOutputRetention) -> &'static str {
    match retention {
        CommandOutputRetention::Discard => "discard",
        CommandOutputRetention::SummaryOnly => "summary_only",
        CommandOutputRetention::ArtifactReference => "artifact_reference",
        CommandOutputRetention::FullArtifactWithApproval => "full_artifact_with_approval",
    }
}
