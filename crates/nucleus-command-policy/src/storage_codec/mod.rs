//! JSON storage codec for command request and sanitized evidence records.

mod conversions;
mod json;
mod records;

#[cfg(test)]
mod tests;

pub use json::{
    command_evidence_from_storage_record, command_request_from_storage_record,
    decode_command_evidence_storage_record, decode_command_request_storage_record,
    encode_command_evidence_storage_payload, encode_command_evidence_storage_record,
    encode_command_request_storage_payload, encode_command_request_storage_record,
};
pub use records::{
    CommandEvidenceStorageRecord, CommandExecutionRequestStorageRecord, CommandRecordCodecError,
    CommandStorageApprovalPolicy, CommandStorageAuthorityArea, CommandStorageExecutionStatus,
    CommandStorageOutputRetention, CommandStorageRisk, CommandStorageSandboxProfile,
    CommandStorageScope,
};
