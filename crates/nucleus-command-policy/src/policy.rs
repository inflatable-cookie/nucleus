//! Command authority and sandbox policy types.

use crate::ids::{CommandPolicyId, CommandRequestId};

/// Request for server-owned command execution authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandExecutionRequest {
    pub id: CommandRequestId,
    pub policy_id: Option<CommandPolicyId>,
    pub authority_area: CommandAuthorityArea,
    pub scope: CommandScope,
    pub risk: CommandRisk,
    pub sandbox: CommandSandboxProfile,
    pub approval: CommandApprovalPolicy,
    pub command_display: Option<String>,
    pub working_directory_hint: Option<String>,
}

/// Caller or workflow asking for command authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandAuthorityArea {
    ScmAdapter,
    ForgeAdapter,
    HarnessAdapter,
    NativePersona,
    Validation,
    Steward,
    UserTerminal,
    Custom(String),
}

/// Command effect scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandScope {
    ReadOnlyInspection,
    ManagementStateWrite,
    SourceCodeWrite,
    NetworkAccess,
    Destructive,
    ProcessLifecycle,
    SecretAccess,
    Custom(String),
}

/// Coarse execution risk.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandRisk {
    Low,
    Medium,
    High,
    Critical,
    Unknown,
}

/// Required execution sandbox.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandSandboxProfile {
    HostDefault,
    ProjectRestricted,
    WorktreeRestricted,
    NetworkDenied,
    NetworkAllowed,
    NoFilesystemWrite,
    Custom(String),
}

/// Approval policy for a command request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandApprovalPolicy {
    AutoAllowed,
    ApprovalRequiredOnce,
    ApprovalRequiredEveryTime,
    Denied,
    Inherit,
}
