//! JSON storage codec for command request and sanitized evidence records.

use serde::{Deserialize, Serialize};

use crate::{
    CommandApprovalPolicy, CommandAuthorityArea, CommandEvidence, CommandExecutionRequest,
    CommandExecutionStatus, CommandOutputRetention, CommandRisk, CommandSandboxProfile,
    CommandScope,
};
use crate::{CommandEvidenceId, CommandPolicyId, CommandRequestId};

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

/// Encode command request metadata into the first JSON storage payload.
pub fn encode_command_request_storage_record(
    request: &CommandExecutionRequest,
) -> Result<Vec<u8>, CommandRecordCodecError> {
    encode_command_request_storage_payload(&CommandExecutionRequestStorageRecord::from(request))
}

/// Encode already projected command request metadata.
pub fn encode_command_request_storage_payload(
    record: &CommandExecutionRequestStorageRecord,
) -> Result<Vec<u8>, CommandRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

/// Decode command request metadata from the first JSON storage payload.
pub fn decode_command_request_storage_record(
    bytes: &[u8],
) -> Result<CommandExecutionRequestStorageRecord, CommandRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

/// Rebuild a command execution request from storage metadata.
pub fn command_request_from_storage_record(
    record: &CommandExecutionRequestStorageRecord,
) -> CommandExecutionRequest {
    CommandExecutionRequest {
        id: CommandRequestId(record.request_id.clone()),
        policy_id: record
            .policy_id
            .as_ref()
            .map(|id| CommandPolicyId(id.clone())),
        authority_area: CommandAuthorityArea::from(&record.authority_area),
        scope: CommandScope::from(&record.scope),
        risk: CommandRisk::from(&record.risk),
        sandbox: CommandSandboxProfile::from(&record.sandbox),
        approval: CommandApprovalPolicy::from(&record.approval),
        command_display: record.command_display.clone(),
        working_directory_hint: record.working_directory_hint.clone(),
    }
}

/// Encode sanitized command evidence metadata into the first JSON storage payload.
pub fn encode_command_evidence_storage_record(
    evidence: &CommandEvidence,
) -> Result<Vec<u8>, CommandRecordCodecError> {
    encode_command_evidence_storage_payload(&CommandEvidenceStorageRecord::from(evidence))
}

/// Encode already projected command evidence metadata.
pub fn encode_command_evidence_storage_payload(
    record: &CommandEvidenceStorageRecord,
) -> Result<Vec<u8>, CommandRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

/// Decode sanitized command evidence metadata from the first JSON storage payload.
pub fn decode_command_evidence_storage_record(
    bytes: &[u8],
) -> Result<CommandEvidenceStorageRecord, CommandRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

/// Rebuild sanitized command evidence from storage metadata.
pub fn command_evidence_from_storage_record(
    record: &CommandEvidenceStorageRecord,
) -> CommandEvidence {
    CommandEvidence {
        id: CommandEvidenceId(record.evidence_id.clone()),
        request_id: CommandRequestId(record.request_id.clone()),
        status: CommandExecutionStatus::from(&record.status),
        exit_status: record.exit_status,
        retention: CommandOutputRetention::from(&record.retention),
        summary: record.summary.clone(),
        stdout_artifact_ref: record.stdout_artifact_ref.clone(),
        stderr_artifact_ref: record.stderr_artifact_ref.clone(),
    }
}

fn codec_error(error: serde_json::Error) -> CommandRecordCodecError {
    CommandRecordCodecError {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_request_storage_codec_preserves_metadata() {
        let request = CommandExecutionRequest {
            id: CommandRequestId("command:request:1".to_owned()),
            policy_id: Some(CommandPolicyId("command:policy:readonly".to_owned())),
            authority_area: CommandAuthorityArea::Validation,
            scope: CommandScope::ReadOnlyInspection,
            risk: CommandRisk::Low,
            sandbox: CommandSandboxProfile::NoFilesystemWrite,
            approval: CommandApprovalPolicy::AutoAllowed,
            command_display: Some("cargo check --workspace".to_owned()),
            working_directory_hint: Some("/workspace/nucleus".to_owned()),
        };

        let bytes = encode_command_request_storage_record(&request).expect("encode request");
        let decoded = decode_command_request_storage_record(&bytes).expect("decode request");
        let restored = command_request_from_storage_record(&decoded);

        assert_eq!(restored, request);
    }

    #[test]
    fn command_evidence_storage_codec_preserves_sanitized_metadata() {
        let evidence = CommandEvidence {
            id: CommandEvidenceId("command:evidence:1".to_owned()),
            request_id: CommandRequestId("command:request:1".to_owned()),
            status: CommandExecutionStatus::Succeeded,
            exit_status: Some(0),
            retention: CommandOutputRetention::ArtifactReference,
            summary: Some("workspace check passed".to_owned()),
            stdout_artifact_ref: Some("artifact:stdout:1".to_owned()),
            stderr_artifact_ref: None,
        };

        let bytes = encode_command_evidence_storage_record(&evidence).expect("encode evidence");
        let decoded = decode_command_evidence_storage_record(&bytes).expect("decode evidence");
        let restored = command_evidence_from_storage_record(&decoded);

        assert_eq!(restored, evidence);
    }

    #[test]
    fn command_evidence_storage_payload_has_no_raw_output_fields() {
        let evidence = CommandEvidence {
            id: CommandEvidenceId("command:evidence:1".to_owned()),
            request_id: CommandRequestId("command:request:1".to_owned()),
            status: CommandExecutionStatus::Failed,
            exit_status: Some(1),
            retention: CommandOutputRetention::SummaryOnly,
            summary: Some("command failed; see retained evidence policy".to_owned()),
            stdout_artifact_ref: None,
            stderr_artifact_ref: None,
        };

        let bytes = encode_command_evidence_storage_record(&evidence).expect("encode evidence");
        let json = String::from_utf8(bytes).expect("json should be utf8");

        for forbidden in [
            "raw_stdout",
            "raw_stderr",
            "stdout_bytes",
            "stderr_bytes",
            "terminal_stream",
            "shell_trace",
            "environment",
            "credential",
        ] {
            assert!(
                !json.contains(forbidden),
                "storage payload should not contain {forbidden}"
            );
        }
    }
}
