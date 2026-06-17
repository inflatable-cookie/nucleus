use nucleus_command_policy::{CommandArtifactPayloadClass, CommandArtifactRef, CommandRequestId};
use serde::{Deserialize, Serialize};

use crate::artifact_store_backend::ArtifactStoreBackendEvidenceRef;

use super::{LocalArtifactMetadataId, LocalArtifactMetadataRecord, LocalArtifactStoreError};

const MAX_SUMMARY_BYTES: usize = 4096;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct LocalArtifactMetadataRecordDto {
    id: String,
    artifact_ref: String,
    command_request_id: String,
    payload_class: String,
    declared_payload_bytes: u64,
    retention_evidence_ref: String,
    redaction_evidence_ref: String,
    summary: Option<String>,
}

pub(super) fn encode_metadata_record(
    record: &LocalArtifactMetadataRecord,
) -> Result<Vec<u8>, LocalArtifactStoreError> {
    serde_json::to_vec_pretty(&record_to_dto(record))
        .map_err(|error| LocalArtifactStoreError::Codec(error.to_string()))
}

pub(super) fn decode_metadata_record(
    payload: &[u8],
) -> Result<LocalArtifactMetadataRecord, LocalArtifactStoreError> {
    let dto: LocalArtifactMetadataRecordDto = serde_json::from_slice(payload)
        .map_err(|error| LocalArtifactStoreError::Codec(error.to_string()))?;

    dto_to_record(dto)
}

pub(super) fn validate_record(
    record: &LocalArtifactMetadataRecord,
    accepted_payload_classes: &[CommandArtifactPayloadClass],
) -> Result<(), LocalArtifactStoreError> {
    validate_metadata_id(&record.id)?;

    if record.payload_class.is_raw_process_output()
        || !accepted_payload_classes.contains(&record.payload_class)
    {
        return Err(LocalArtifactStoreError::UnsupportedPayloadClass(
            record.payload_class.clone(),
        ));
    }

    if let Some(summary) = &record.summary {
        let actual_bytes = summary.len();
        if actual_bytes > MAX_SUMMARY_BYTES {
            return Err(LocalArtifactStoreError::SummaryTooLarge {
                max_bytes: MAX_SUMMARY_BYTES,
                actual_bytes,
            });
        }
        reject_secret_markers(summary)?;
    }

    Ok(())
}

pub(super) fn validate_metadata_id(
    id: &LocalArtifactMetadataId,
) -> Result<(), LocalArtifactStoreError> {
    if id.0.is_empty()
        || id.0.contains('/')
        || id.0.contains('\\')
        || id.0.contains("..")
        || !id
            .0
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.'))
    {
        return Err(LocalArtifactStoreError::InvalidMetadataId(id.0.clone()));
    }

    Ok(())
}

fn reject_secret_markers(summary: &str) -> Result<(), LocalArtifactStoreError> {
    let lower = summary.to_ascii_lowercase();

    for marker in [
        "raw_stdout",
        "raw_stderr",
        "terminal_stream",
        "credential",
        "password",
        "api_key",
        "private_key",
        "secret",
        "token=",
    ] {
        if lower.contains(marker) {
            return Err(LocalArtifactStoreError::SecretMaterialMarkerDetected(
                marker.to_owned(),
            ));
        }
    }

    Ok(())
}

fn record_to_dto(record: &LocalArtifactMetadataRecord) -> LocalArtifactMetadataRecordDto {
    LocalArtifactMetadataRecordDto {
        id: record.id.0.clone(),
        artifact_ref: record.artifact_ref.0.clone(),
        command_request_id: record.command_request_id.0.clone(),
        payload_class: payload_class_to_string(&record.payload_class),
        declared_payload_bytes: record.declared_payload_bytes,
        retention_evidence_ref: record.retention_evidence_ref.0.clone(),
        redaction_evidence_ref: record.redaction_evidence_ref.0.clone(),
        summary: record.summary.clone(),
    }
}

fn dto_to_record(
    dto: LocalArtifactMetadataRecordDto,
) -> Result<LocalArtifactMetadataRecord, LocalArtifactStoreError> {
    Ok(LocalArtifactMetadataRecord {
        id: LocalArtifactMetadataId(dto.id),
        artifact_ref: CommandArtifactRef(dto.artifact_ref),
        command_request_id: CommandRequestId(dto.command_request_id),
        payload_class: payload_class_from_string(&dto.payload_class)?,
        declared_payload_bytes: dto.declared_payload_bytes,
        retention_evidence_ref: ArtifactStoreBackendEvidenceRef(dto.retention_evidence_ref),
        redaction_evidence_ref: ArtifactStoreBackendEvidenceRef(dto.redaction_evidence_ref),
        summary: dto.summary,
    })
}

fn payload_class_to_string(payload_class: &CommandArtifactPayloadClass) -> String {
    match payload_class {
        CommandArtifactPayloadClass::Stdout => "stdout".to_owned(),
        CommandArtifactPayloadClass::Stderr => "stderr".to_owned(),
        CommandArtifactPayloadClass::CombinedOutput => "combined-output".to_owned(),
        CommandArtifactPayloadClass::TerminalTranscript => "terminal-transcript".to_owned(),
        CommandArtifactPayloadClass::ValidationReport => "validation-report".to_owned(),
        CommandArtifactPayloadClass::SanitizedSummary => "sanitized-summary".to_owned(),
        CommandArtifactPayloadClass::Custom(value) => format!("custom:{value}"),
    }
}

fn payload_class_from_string(
    value: &str,
) -> Result<CommandArtifactPayloadClass, LocalArtifactStoreError> {
    match value {
        "stdout" => Ok(CommandArtifactPayloadClass::Stdout),
        "stderr" => Ok(CommandArtifactPayloadClass::Stderr),
        "combined-output" => Ok(CommandArtifactPayloadClass::CombinedOutput),
        "terminal-transcript" => Ok(CommandArtifactPayloadClass::TerminalTranscript),
        "validation-report" => Ok(CommandArtifactPayloadClass::ValidationReport),
        "sanitized-summary" => Ok(CommandArtifactPayloadClass::SanitizedSummary),
        value if value.starts_with("custom:") => Ok(CommandArtifactPayloadClass::Custom(
            value.trim_start_matches("custom:").to_owned(),
        )),
        value => Err(LocalArtifactStoreError::Codec(format!(
            "unknown payload class {value}"
        ))),
    }
}
