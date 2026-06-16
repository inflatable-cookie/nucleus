//! Command-policy fixture profile names.

use nucleus_command_policy::{
    CommandApprovalPolicy, CommandAuthorityArea, CommandEvidence, CommandEvidenceId,
    CommandExecutionRequest, CommandExecutionStatus, CommandOutputRetention, CommandRequestId,
    CommandRisk, CommandSandboxProfile, CommandScope,
};

/// Provider-neutral command-policy fixture scenario.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandPolicyFixtureProfile {
    ReadOnlyInspectionAllowed,
    ManagementStateWriteApprovalOnce,
    SourceCodeWriteApprovalEveryTime,
    NetworkAccessExplicit,
    DestructiveBlockedOrApproval,
    SecretAccessBlocked,
    SummaryOnlySuccess,
    ArtifactRefFailure,
    BlockedByPolicy,
    TimedOut,
}

/// Read-only inspection request that may be auto-allowed.
pub fn read_only_inspection_request() -> CommandExecutionRequest {
    CommandExecutionRequest {
        id: CommandRequestId("cmd-fixture-read".to_owned()),
        policy_id: None,
        authority_area: CommandAuthorityArea::ScmAdapter,
        scope: CommandScope::ReadOnlyInspection,
        risk: CommandRisk::Low,
        sandbox: CommandSandboxProfile::NoFilesystemWrite,
        approval: CommandApprovalPolicy::AutoAllowed,
        command_display: Some("status".to_owned()),
        working_directory_hint: Some("project-root".to_owned()),
    }
}

/// Management-state write request that requires one approval.
pub fn management_state_write_request() -> CommandExecutionRequest {
    CommandExecutionRequest {
        id: CommandRequestId("cmd-fixture-management-write".to_owned()),
        policy_id: None,
        authority_area: CommandAuthorityArea::Steward,
        scope: CommandScope::ManagementStateWrite,
        risk: CommandRisk::Medium,
        sandbox: CommandSandboxProfile::ProjectRestricted,
        approval: CommandApprovalPolicy::ApprovalRequiredOnce,
        command_display: Some("write management projection".to_owned()),
        working_directory_hint: Some("project-root".to_owned()),
    }
}

/// Source-code write request that requires approval every time.
pub fn source_code_write_request() -> CommandExecutionRequest {
    CommandExecutionRequest {
        id: CommandRequestId("cmd-fixture-source-write".to_owned()),
        policy_id: None,
        authority_area: CommandAuthorityArea::HarnessAdapter,
        scope: CommandScope::SourceCodeWrite,
        risk: CommandRisk::High,
        sandbox: CommandSandboxProfile::WorktreeRestricted,
        approval: CommandApprovalPolicy::ApprovalRequiredEveryTime,
        command_display: Some("modify source files".to_owned()),
        working_directory_hint: Some("worktree".to_owned()),
    }
}

/// Network-capable request with explicit network sandbox.
pub fn network_access_request() -> CommandExecutionRequest {
    CommandExecutionRequest {
        id: CommandRequestId("cmd-fixture-network".to_owned()),
        policy_id: None,
        authority_area: CommandAuthorityArea::ForgeAdapter,
        scope: CommandScope::NetworkAccess,
        risk: CommandRisk::Medium,
        sandbox: CommandSandboxProfile::NetworkAllowed,
        approval: CommandApprovalPolicy::ApprovalRequiredOnce,
        command_display: Some("fetch forge state".to_owned()),
        working_directory_hint: None,
    }
}

/// Destructive request that is blocked unless a later policy grants approval.
pub fn destructive_blocked_request() -> CommandExecutionRequest {
    CommandExecutionRequest {
        id: CommandRequestId("cmd-fixture-destructive".to_owned()),
        policy_id: None,
        authority_area: CommandAuthorityArea::UserTerminal,
        scope: CommandScope::Destructive,
        risk: CommandRisk::Critical,
        sandbox: CommandSandboxProfile::ProjectRestricted,
        approval: CommandApprovalPolicy::Denied,
        command_display: Some("delete local state".to_owned()),
        working_directory_hint: Some("project-root".to_owned()),
    }
}

/// Secret-access request that is blocked without explicit credential policy.
pub fn secret_access_blocked_request() -> CommandExecutionRequest {
    CommandExecutionRequest {
        id: CommandRequestId("cmd-fixture-secret".to_owned()),
        policy_id: None,
        authority_area: CommandAuthorityArea::Validation,
        scope: CommandScope::SecretAccess,
        risk: CommandRisk::Critical,
        sandbox: CommandSandboxProfile::NetworkDenied,
        approval: CommandApprovalPolicy::Denied,
        command_display: Some("read credential material".to_owned()),
        working_directory_hint: None,
    }
}

/// Succeeded evidence retaining summary only.
pub fn summary_only_success_evidence() -> CommandEvidence {
    CommandEvidence {
        id: CommandEvidenceId("cmd-evidence-success".to_owned()),
        request_id: CommandRequestId("cmd-fixture-read".to_owned()),
        status: CommandExecutionStatus::Succeeded,
        exit_status: Some(0),
        retention: CommandOutputRetention::SummaryOnly,
        summary: Some("command succeeded".to_owned()),
        stdout_artifact_ref: None,
        stderr_artifact_ref: None,
    }
}

/// Failed evidence retaining artifact references instead of raw output.
pub fn artifact_ref_failure_evidence() -> CommandEvidence {
    CommandEvidence {
        id: CommandEvidenceId("cmd-evidence-failure".to_owned()),
        request_id: CommandRequestId("cmd-fixture-failed".to_owned()),
        status: CommandExecutionStatus::Failed,
        exit_status: Some(1),
        retention: CommandOutputRetention::ArtifactReference,
        summary: Some("command failed with retained artifact references".to_owned()),
        stdout_artifact_ref: Some("artifact://stdout".to_owned()),
        stderr_artifact_ref: Some("artifact://stderr".to_owned()),
    }
}

/// Evidence for a command blocked by policy.
pub fn blocked_by_policy_evidence() -> CommandEvidence {
    CommandEvidence {
        id: CommandEvidenceId("cmd-evidence-blocked".to_owned()),
        request_id: CommandRequestId("cmd-fixture-destructive".to_owned()),
        status: CommandExecutionStatus::BlockedByPolicy,
        exit_status: None,
        retention: CommandOutputRetention::Discard,
        summary: Some("command blocked by policy".to_owned()),
        stdout_artifact_ref: None,
        stderr_artifact_ref: None,
    }
}

/// Evidence for a timed-out command.
pub fn timed_out_evidence() -> CommandEvidence {
    CommandEvidence {
        id: CommandEvidenceId("cmd-evidence-timeout".to_owned()),
        request_id: CommandRequestId("cmd-fixture-network".to_owned()),
        status: CommandExecutionStatus::TimedOut,
        exit_status: None,
        retention: CommandOutputRetention::SummaryOnly,
        summary: Some("command timed out".to_owned()),
        stdout_artifact_ref: None,
        stderr_artifact_ref: None,
    }
}
