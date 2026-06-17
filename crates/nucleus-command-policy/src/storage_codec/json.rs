use crate::{
    CommandApprovalPolicy, CommandAuthorityArea, CommandEvidence, CommandExecutionRequest,
    CommandExecutionStatus, CommandOutputRetention, CommandRisk, CommandSandboxProfile,
    CommandScope,
};
use crate::{CommandEvidenceId, CommandPolicyId, CommandRequestId};

use super::records::{
    CommandEvidenceStorageRecord, CommandExecutionRequestStorageRecord, CommandRecordCodecError,
};

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
