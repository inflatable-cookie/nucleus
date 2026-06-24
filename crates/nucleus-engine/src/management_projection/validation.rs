use serde::{Deserialize, Serialize};

use super::types::{
    ManagementProjectionEnvelope, ManagementProjectionFileDocument, ManagementProjectionFileRef,
    ManagementProjectionPayload, ManagementProjectionRecordId, ManagementProjectionRecordKind,
    MANAGEMENT_PROJECTION_SCHEMA_V1,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionValidationStatus {
    Valid,
    ValidWithWarnings,
    Invalid,
    UnsupportedSchema,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionValidationReport {
    pub file_ref: ManagementProjectionFileRef,
    pub record_id: Option<ManagementProjectionRecordId>,
    pub status: ManagementProjectionValidationStatus,
    pub issues: Vec<ManagementProjectionValidationIssue>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionValidationIssue {
    pub kind: ManagementProjectionValidationIssueKind,
    pub field: Option<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionValidationIssueKind {
    MissingRequiredField,
    InvalidIdentifier,
    UnsupportedSchemaVersion,
    UnknownRecordKind,
    MismatchedRecordKind,
    InvalidReference,
    ExcludedStatePresent,
    RequiresRepair,
    Custom(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionExcludedStateMarker {
    SecretMaterial,
    ProviderAuthMaterial,
    ProviderNativeTranscript,
    LiveRuntimeEventStream,
    LiveAgentSession,
    TerminalState,
    BrowserState,
    LocalCache,
    LocalIndex,
    LocalClientLayoutState,
    GlobalDisplayWindowSurfaceLayout,
    PerProjectPanelLayout,
    RawValidationOutput,
    Custom(String),
}

pub fn validate_projection_envelope(
    envelope: &ManagementProjectionEnvelope,
    excluded_markers: &[ManagementProjectionExcludedStateMarker],
) -> ManagementProjectionValidationReport {
    let mut issues = Vec::new();

    if envelope.schema_version.0 != MANAGEMENT_PROJECTION_SCHEMA_V1 {
        issues.push(ManagementProjectionValidationIssue {
            kind: ManagementProjectionValidationIssueKind::UnsupportedSchemaVersion,
            field: Some("schema_version".to_owned()),
            summary: format!("unsupported schema version {}", envelope.schema_version.0),
        });
    }

    if envelope.record_id.0.trim().is_empty() {
        issues.push(ManagementProjectionValidationIssue {
            kind: ManagementProjectionValidationIssueKind::MissingRequiredField,
            field: Some("record_id".to_owned()),
            summary: "record id is required".to_owned(),
        });
    }

    if !envelope.file_ref.0.starts_with("nucleus/") {
        issues.push(ManagementProjectionValidationIssue {
            kind: ManagementProjectionValidationIssueKind::InvalidReference,
            field: Some("file_ref".to_owned()),
            summary: "management projection files must live under nucleus/".to_owned(),
        });
    }

    for marker in excluded_markers {
        issues.push(ManagementProjectionValidationIssue {
            kind: ManagementProjectionValidationIssueKind::ExcludedStatePresent,
            field: None,
            summary: format!("excluded state present: {marker:?}"),
        });
    }

    let status = if issues.iter().any(|issue| {
        issue.kind == ManagementProjectionValidationIssueKind::UnsupportedSchemaVersion
    }) {
        ManagementProjectionValidationStatus::UnsupportedSchema
    } else if issues.is_empty() {
        ManagementProjectionValidationStatus::Valid
    } else {
        ManagementProjectionValidationStatus::Invalid
    };

    ManagementProjectionValidationReport {
        file_ref: envelope.file_ref.clone(),
        record_id: Some(envelope.record_id.clone()),
        status,
        issues,
    }
}

pub fn validate_projection_file_document(
    document: &ManagementProjectionFileDocument,
    excluded_markers: &[ManagementProjectionExcludedStateMarker],
) -> ManagementProjectionValidationReport {
    let mut report = validate_projection_envelope(&document.envelope, excluded_markers);

    if !projection_payload_matches_record_kind(&document.envelope.record_kind, &document.payload) {
        report.issues.push(ManagementProjectionValidationIssue {
            kind: ManagementProjectionValidationIssueKind::MismatchedRecordKind,
            field: Some("payload.kind".to_owned()),
            summary: "projection envelope record kind does not match payload kind".to_owned(),
        });
    }

    if report.status != ManagementProjectionValidationStatus::UnsupportedSchema {
        report.status = if report.issues.is_empty() {
            ManagementProjectionValidationStatus::Valid
        } else {
            ManagementProjectionValidationStatus::Invalid
        };
    }

    report
}

fn projection_payload_matches_record_kind(
    record_kind: &ManagementProjectionRecordKind,
    payload: &ManagementProjectionPayload,
) -> bool {
    matches!(
        (record_kind, payload),
        (
            ManagementProjectionRecordKind::Project,
            ManagementProjectionPayload::Project(_)
        ) | (
            ManagementProjectionRecordKind::Task,
            ManagementProjectionPayload::Task(_)
        ) | (
            ManagementProjectionRecordKind::PlanningArtifact,
            ManagementProjectionPayload::PlanningArtifact(_)
        ) | (
            ManagementProjectionRecordKind::PlanningTaskSeed,
            ManagementProjectionPayload::PlanningTaskSeed(_)
        ) | (
            ManagementProjectionRecordKind::Index,
            ManagementProjectionPayload::Index { .. }
        ) | (
            ManagementProjectionRecordKind::ArtifactIndex,
            ManagementProjectionPayload::ArtifactIndex { .. }
        ) | (
            ManagementProjectionRecordKind::Custom(_),
            ManagementProjectionPayload::Unsupported { .. }
        )
    )
}
