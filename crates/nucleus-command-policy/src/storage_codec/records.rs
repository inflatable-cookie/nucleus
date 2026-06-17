use serde::{Deserialize, Serialize};

/// Storage-ready command request metadata.
///
/// This record is intentionally policy metadata only. It does not contain raw
/// stdout, raw stderr, shell traces, environment values, credentials, or a
/// process transcript.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommandExecutionRequestStorageRecord {
    pub request_id: String,
    pub policy_id: Option<String>,
    pub authority_area: CommandStorageAuthorityArea,
    pub scope: CommandStorageScope,
    pub risk: CommandStorageRisk,
    pub sandbox: CommandStorageSandboxProfile,
    pub approval: CommandStorageApprovalPolicy,
    pub command_display: Option<String>,
    pub working_directory_hint: Option<String>,
}

/// Storage-ready sanitized command evidence metadata.
///
/// Raw command output must live behind explicitly retained artifact refs later,
/// not inside this record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommandEvidenceStorageRecord {
    pub evidence_id: String,
    pub request_id: String,
    pub status: CommandStorageExecutionStatus,
    pub exit_status: Option<i32>,
    pub retention: CommandStorageOutputRetention,
    pub summary: Option<String>,
    pub stdout_artifact_ref: Option<String>,
    pub stderr_artifact_ref: Option<String>,
}

/// Serializable command authority area.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum CommandStorageAuthorityArea {
    ScmAdapter,
    ForgeAdapter,
    HarnessAdapter,
    NativePersona,
    Validation,
    Steward,
    UserTerminal,
    Custom(String),
}

/// Serializable command scope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum CommandStorageScope {
    ReadOnlyInspection,
    ManagementStateWrite,
    SourceCodeWrite,
    NetworkAccess,
    Destructive,
    ProcessLifecycle,
    SecretAccess,
    Custom(String),
}

/// Serializable command risk.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandStorageRisk {
    Low,
    Medium,
    High,
    Critical,
    Unknown,
}

/// Serializable command sandbox posture.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum CommandStorageSandboxProfile {
    HostDefault,
    ProjectRestricted,
    WorktreeRestricted,
    NetworkDenied,
    NetworkAllowed,
    NoFilesystemWrite,
    Custom(String),
}

/// Serializable command approval policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandStorageApprovalPolicy {
    AutoAllowed,
    ApprovalRequiredOnce,
    ApprovalRequiredEveryTime,
    Denied,
    Inherit,
}

/// Serializable command execution status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandStorageExecutionStatus {
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

/// Serializable command output retention posture.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandStorageOutputRetention {
    Discard,
    SummaryOnly,
    ArtifactReference,
    FullArtifactWithApproval,
}

/// Command record codec error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandRecordCodecError {
    pub reason: String,
}
