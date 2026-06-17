use crate::{
    CommandApprovalPolicy, CommandAuthorityArea, CommandEvidence, CommandExecutionRequest,
    CommandExecutionStatus, CommandOutputRetention, CommandRisk, CommandSandboxProfile,
    CommandScope,
};

use super::records::{
    CommandEvidenceStorageRecord, CommandExecutionRequestStorageRecord,
    CommandStorageApprovalPolicy, CommandStorageAuthorityArea, CommandStorageExecutionStatus,
    CommandStorageOutputRetention, CommandStorageRisk, CommandStorageSandboxProfile,
    CommandStorageScope,
};

impl From<&CommandExecutionRequest> for CommandExecutionRequestStorageRecord {
    fn from(request: &CommandExecutionRequest) -> Self {
        Self {
            request_id: request.id.0.clone(),
            policy_id: request.policy_id.as_ref().map(|id| id.0.clone()),
            authority_area: CommandStorageAuthorityArea::from(&request.authority_area),
            scope: CommandStorageScope::from(&request.scope),
            risk: CommandStorageRisk::from(&request.risk),
            sandbox: CommandStorageSandboxProfile::from(&request.sandbox),
            approval: CommandStorageApprovalPolicy::from(&request.approval),
            command_display: request.command_display.clone(),
            working_directory_hint: request.working_directory_hint.clone(),
        }
    }
}

impl From<&CommandEvidence> for CommandEvidenceStorageRecord {
    fn from(evidence: &CommandEvidence) -> Self {
        Self {
            evidence_id: evidence.id.0.clone(),
            request_id: evidence.request_id.0.clone(),
            status: CommandStorageExecutionStatus::from(&evidence.status),
            exit_status: evidence.exit_status,
            retention: CommandStorageOutputRetention::from(&evidence.retention),
            summary: evidence.summary.clone(),
            stdout_artifact_ref: evidence.stdout_artifact_ref.clone(),
            stderr_artifact_ref: evidence.stderr_artifact_ref.clone(),
        }
    }
}

impl From<&CommandAuthorityArea> for CommandStorageAuthorityArea {
    fn from(authority_area: &CommandAuthorityArea) -> Self {
        match authority_area {
            CommandAuthorityArea::ScmAdapter => Self::ScmAdapter,
            CommandAuthorityArea::ForgeAdapter => Self::ForgeAdapter,
            CommandAuthorityArea::HarnessAdapter => Self::HarnessAdapter,
            CommandAuthorityArea::NativePersona => Self::NativePersona,
            CommandAuthorityArea::Validation => Self::Validation,
            CommandAuthorityArea::Steward => Self::Steward,
            CommandAuthorityArea::UserTerminal => Self::UserTerminal,
            CommandAuthorityArea::Custom(value) => Self::Custom(value.clone()),
        }
    }
}

impl From<&CommandScope> for CommandStorageScope {
    fn from(scope: &CommandScope) -> Self {
        match scope {
            CommandScope::ReadOnlyInspection => Self::ReadOnlyInspection,
            CommandScope::ManagementStateWrite => Self::ManagementStateWrite,
            CommandScope::SourceCodeWrite => Self::SourceCodeWrite,
            CommandScope::NetworkAccess => Self::NetworkAccess,
            CommandScope::Destructive => Self::Destructive,
            CommandScope::ProcessLifecycle => Self::ProcessLifecycle,
            CommandScope::SecretAccess => Self::SecretAccess,
            CommandScope::Custom(value) => Self::Custom(value.clone()),
        }
    }
}

impl From<&CommandRisk> for CommandStorageRisk {
    fn from(risk: &CommandRisk) -> Self {
        match risk {
            CommandRisk::Low => Self::Low,
            CommandRisk::Medium => Self::Medium,
            CommandRisk::High => Self::High,
            CommandRisk::Critical => Self::Critical,
            CommandRisk::Unknown => Self::Unknown,
        }
    }
}

impl From<&CommandSandboxProfile> for CommandStorageSandboxProfile {
    fn from(sandbox: &CommandSandboxProfile) -> Self {
        match sandbox {
            CommandSandboxProfile::HostDefault => Self::HostDefault,
            CommandSandboxProfile::ProjectRestricted => Self::ProjectRestricted,
            CommandSandboxProfile::WorktreeRestricted => Self::WorktreeRestricted,
            CommandSandboxProfile::NetworkDenied => Self::NetworkDenied,
            CommandSandboxProfile::NetworkAllowed => Self::NetworkAllowed,
            CommandSandboxProfile::NoFilesystemWrite => Self::NoFilesystemWrite,
            CommandSandboxProfile::Custom(value) => Self::Custom(value.clone()),
        }
    }
}

impl From<&CommandApprovalPolicy> for CommandStorageApprovalPolicy {
    fn from(approval: &CommandApprovalPolicy) -> Self {
        match approval {
            CommandApprovalPolicy::AutoAllowed => Self::AutoAllowed,
            CommandApprovalPolicy::ApprovalRequiredOnce => Self::ApprovalRequiredOnce,
            CommandApprovalPolicy::ApprovalRequiredEveryTime => Self::ApprovalRequiredEveryTime,
            CommandApprovalPolicy::Denied => Self::Denied,
            CommandApprovalPolicy::Inherit => Self::Inherit,
        }
    }
}

impl From<&CommandExecutionStatus> for CommandStorageExecutionStatus {
    fn from(status: &CommandExecutionStatus) -> Self {
        match status {
            CommandExecutionStatus::Accepted => Self::Accepted,
            CommandExecutionStatus::Rejected => Self::Rejected,
            CommandExecutionStatus::Queued => Self::Queued,
            CommandExecutionStatus::Running => Self::Running,
            CommandExecutionStatus::Succeeded => Self::Succeeded,
            CommandExecutionStatus::Failed => Self::Failed,
            CommandExecutionStatus::Cancelled => Self::Cancelled,
            CommandExecutionStatus::TimedOut => Self::TimedOut,
            CommandExecutionStatus::BlockedByPolicy => Self::BlockedByPolicy,
        }
    }
}

impl From<&CommandOutputRetention> for CommandStorageOutputRetention {
    fn from(retention: &CommandOutputRetention) -> Self {
        match retention {
            CommandOutputRetention::Discard => Self::Discard,
            CommandOutputRetention::SummaryOnly => Self::SummaryOnly,
            CommandOutputRetention::ArtifactReference => Self::ArtifactReference,
            CommandOutputRetention::FullArtifactWithApproval => Self::FullArtifactWithApproval,
        }
    }
}

impl From<&CommandStorageAuthorityArea> for CommandAuthorityArea {
    fn from(authority_area: &CommandStorageAuthorityArea) -> Self {
        match authority_area {
            CommandStorageAuthorityArea::ScmAdapter => Self::ScmAdapter,
            CommandStorageAuthorityArea::ForgeAdapter => Self::ForgeAdapter,
            CommandStorageAuthorityArea::HarnessAdapter => Self::HarnessAdapter,
            CommandStorageAuthorityArea::NativePersona => Self::NativePersona,
            CommandStorageAuthorityArea::Validation => Self::Validation,
            CommandStorageAuthorityArea::Steward => Self::Steward,
            CommandStorageAuthorityArea::UserTerminal => Self::UserTerminal,
            CommandStorageAuthorityArea::Custom(value) => Self::Custom(value.clone()),
        }
    }
}

impl From<&CommandStorageScope> for CommandScope {
    fn from(scope: &CommandStorageScope) -> Self {
        match scope {
            CommandStorageScope::ReadOnlyInspection => Self::ReadOnlyInspection,
            CommandStorageScope::ManagementStateWrite => Self::ManagementStateWrite,
            CommandStorageScope::SourceCodeWrite => Self::SourceCodeWrite,
            CommandStorageScope::NetworkAccess => Self::NetworkAccess,
            CommandStorageScope::Destructive => Self::Destructive,
            CommandStorageScope::ProcessLifecycle => Self::ProcessLifecycle,
            CommandStorageScope::SecretAccess => Self::SecretAccess,
            CommandStorageScope::Custom(value) => Self::Custom(value.clone()),
        }
    }
}

impl From<&CommandStorageRisk> for CommandRisk {
    fn from(risk: &CommandStorageRisk) -> Self {
        match risk {
            CommandStorageRisk::Low => Self::Low,
            CommandStorageRisk::Medium => Self::Medium,
            CommandStorageRisk::High => Self::High,
            CommandStorageRisk::Critical => Self::Critical,
            CommandStorageRisk::Unknown => Self::Unknown,
        }
    }
}

impl From<&CommandStorageSandboxProfile> for CommandSandboxProfile {
    fn from(sandbox: &CommandStorageSandboxProfile) -> Self {
        match sandbox {
            CommandStorageSandboxProfile::HostDefault => Self::HostDefault,
            CommandStorageSandboxProfile::ProjectRestricted => Self::ProjectRestricted,
            CommandStorageSandboxProfile::WorktreeRestricted => Self::WorktreeRestricted,
            CommandStorageSandboxProfile::NetworkDenied => Self::NetworkDenied,
            CommandStorageSandboxProfile::NetworkAllowed => Self::NetworkAllowed,
            CommandStorageSandboxProfile::NoFilesystemWrite => Self::NoFilesystemWrite,
            CommandStorageSandboxProfile::Custom(value) => Self::Custom(value.clone()),
        }
    }
}

impl From<&CommandStorageApprovalPolicy> for CommandApprovalPolicy {
    fn from(approval: &CommandStorageApprovalPolicy) -> Self {
        match approval {
            CommandStorageApprovalPolicy::AutoAllowed => Self::AutoAllowed,
            CommandStorageApprovalPolicy::ApprovalRequiredOnce => Self::ApprovalRequiredOnce,
            CommandStorageApprovalPolicy::ApprovalRequiredEveryTime => {
                Self::ApprovalRequiredEveryTime
            }
            CommandStorageApprovalPolicy::Denied => Self::Denied,
            CommandStorageApprovalPolicy::Inherit => Self::Inherit,
        }
    }
}

impl From<&CommandStorageExecutionStatus> for CommandExecutionStatus {
    fn from(status: &CommandStorageExecutionStatus) -> Self {
        match status {
            CommandStorageExecutionStatus::Accepted => Self::Accepted,
            CommandStorageExecutionStatus::Rejected => Self::Rejected,
            CommandStorageExecutionStatus::Queued => Self::Queued,
            CommandStorageExecutionStatus::Running => Self::Running,
            CommandStorageExecutionStatus::Succeeded => Self::Succeeded,
            CommandStorageExecutionStatus::Failed => Self::Failed,
            CommandStorageExecutionStatus::Cancelled => Self::Cancelled,
            CommandStorageExecutionStatus::TimedOut => Self::TimedOut,
            CommandStorageExecutionStatus::BlockedByPolicy => Self::BlockedByPolicy,
        }
    }
}

impl From<&CommandStorageOutputRetention> for CommandOutputRetention {
    fn from(retention: &CommandStorageOutputRetention) -> Self {
        match retention {
            CommandStorageOutputRetention::Discard => Self::Discard,
            CommandStorageOutputRetention::SummaryOnly => Self::SummaryOnly,
            CommandStorageOutputRetention::ArtifactReference => Self::ArtifactReference,
            CommandStorageOutputRetention::FullArtifactWithApproval => {
                Self::FullArtifactWithApproval
            }
        }
    }
}
