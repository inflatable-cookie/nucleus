//! Accepted-memory projection import validation helpers.

use nucleus_memory::{
    AcceptedMemoryStorageBody, AcceptedMemoryStorageStatus, MemoryProposalStorageKind,
    MemoryProposalStorageScope, MemoryRetentionStoragePosture, MemorySensitivityStorage,
};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_export_plan::accepted_memory_projection_file_ref;
use crate::accepted_memory_projection_import_records::{
    AcceptedMemoryProjectionImportCandidateBlocker, AcceptedMemoryProjectionImportCandidateStatus,
    AcceptedMemoryProjectionImportCandidateSummary,
};
use crate::accepted_memory_projection_payload::{
    decode_accepted_memory_projection_payload, AcceptedMemoryProjectionPayload,
    ACCEPTED_MEMORY_PROJECTION_FILE_SCHEMA_VERSION,
};

pub(super) fn candidate_status(
    blockers: &[AcceptedMemoryProjectionImportCandidateBlocker],
) -> AcceptedMemoryProjectionImportCandidateStatus {
    if blockers.is_empty() {
        AcceptedMemoryProjectionImportCandidateStatus::Ready
    } else {
        AcceptedMemoryProjectionImportCandidateStatus::Blocked
    }
}

pub(super) fn file_ref_blockers(
    file_ref: &str,
) -> Vec<AcceptedMemoryProjectionImportCandidateBlocker> {
    if file_ref_is_safe(file_ref) {
        Vec::new()
    } else {
        vec![
            AcceptedMemoryProjectionImportCandidateBlocker::UnsafeFileRef {
                reason: "file ref is outside nucleus/memory projection root".to_owned(),
            },
        ]
    }
}

pub(super) fn decode_payload_or_blocker(
    bytes: &[u8],
) -> Result<AcceptedMemoryProjectionPayload, AcceptedMemoryProjectionImportCandidateBlocker> {
    match decode_accepted_memory_projection_payload(bytes) {
        Ok(payload) => Ok(payload),
        Err(error) => Err(unsupported_schema_blocker(bytes).unwrap_or(
            AcceptedMemoryProjectionImportCandidateBlocker::DecodeFailed {
                reason: error.reason,
            },
        )),
    }
}

pub(super) fn payload_blockers(
    project_id: &ProjectId,
    file_ref: &str,
    payload: &AcceptedMemoryProjectionPayload,
) -> Vec<AcceptedMemoryProjectionImportCandidateBlocker> {
    let mut blockers = Vec::new();
    push_memory_id_and_path_blockers(&mut blockers, file_ref, payload);
    push_scope_blockers(&mut blockers, project_id, payload);
    push_kind_and_status_blockers(&mut blockers, payload);
    push_sensitivity_and_retention_blockers(&mut blockers, payload);
    push_review_blockers(&mut blockers, payload);
    blockers
}

pub(super) fn candidate_summary(
    payload: &AcceptedMemoryProjectionPayload,
) -> AcceptedMemoryProjectionImportCandidateSummary {
    match &payload.body {
        AcceptedMemoryStorageBody::Summary { summary, .. } => {
            AcceptedMemoryProjectionImportCandidateSummary {
                title: payload.title.clone(),
                body_kind: "summary".to_owned(),
                body_summary: truncate_summary(summary),
            }
        }
        AcceptedMemoryStorageBody::StructuredRef { ref_id, summary } => {
            AcceptedMemoryProjectionImportCandidateSummary {
                title: payload.title.clone(),
                body_kind: "structured_ref".to_owned(),
                body_summary: format!("{}: {}", ref_id, truncate_summary(summary)),
            }
        }
    }
}

fn file_ref_is_safe(file_ref: &str) -> bool {
    file_ref.starts_with("nucleus/memory/")
        && file_ref.ends_with(".toml")
        && !file_ref.contains("..")
        && !file_ref.contains('\\')
        && !file_ref.starts_with('/')
}

fn unsupported_schema_blocker(
    bytes: &[u8],
) -> Option<AcceptedMemoryProjectionImportCandidateBlocker> {
    let text = std::str::from_utf8(bytes).ok()?;
    let value: toml::Value = toml::from_str(text).ok()?;
    let schema_version = value
        .get("schema_version")
        .and_then(toml::Value::as_integer)?;
    if schema_version == i64::from(ACCEPTED_MEMORY_PROJECTION_FILE_SCHEMA_VERSION) {
        return None;
    }
    u16::try_from(schema_version).ok().map(|schema_version| {
        AcceptedMemoryProjectionImportCandidateBlocker::UnsupportedSchema { schema_version }
    })
}

fn push_memory_id_and_path_blockers(
    blockers: &mut Vec<AcceptedMemoryProjectionImportCandidateBlocker>,
    file_ref: &str,
    payload: &AcceptedMemoryProjectionPayload,
) {
    if payload.memory_id.trim().is_empty() {
        blockers.push(AcceptedMemoryProjectionImportCandidateBlocker::MissingMemoryId);
    } else if let Ok(expected_file_ref) = accepted_memory_projection_file_ref(&payload.memory_id) {
        if expected_file_ref != file_ref {
            blockers.push(
                AcceptedMemoryProjectionImportCandidateBlocker::MemoryIdFileRefMismatch {
                    expected_file_ref,
                },
            );
        }
    } else {
        blockers.push(
            AcceptedMemoryProjectionImportCandidateBlocker::UnsafeFileRef {
                reason: "memory id is not safe for nucleus/memory projection path".to_owned(),
            },
        );
    }
}

fn push_scope_blockers(
    blockers: &mut Vec<AcceptedMemoryProjectionImportCandidateBlocker>,
    project_id: &ProjectId,
    payload: &AcceptedMemoryProjectionPayload,
) {
    match &payload.scope {
        MemoryProposalStorageScope::Project { project_ref } if project_ref == &project_id.0 => {}
        MemoryProposalStorageScope::Project { .. } => {
            blockers.push(
                AcceptedMemoryProjectionImportCandidateBlocker::OutOfScopeProject {
                    expected_project_ref: project_id.0.clone(),
                },
            );
        }
        _ => blockers.push(AcceptedMemoryProjectionImportCandidateBlocker::MissingProjectScope),
    }
}

fn push_kind_and_status_blockers(
    blockers: &mut Vec<AcceptedMemoryProjectionImportCandidateBlocker>,
    payload: &AcceptedMemoryProjectionPayload,
) {
    if let MemoryProposalStorageKind::Other { label } = &payload.kind {
        blockers.push(
            AcceptedMemoryProjectionImportCandidateBlocker::UnsupportedMemoryKind {
                kind: label.clone(),
            },
        );
    }

    if payload.status != AcceptedMemoryStorageStatus::Accepted {
        blockers.push(
            AcceptedMemoryProjectionImportCandidateBlocker::NonAcceptedStatus {
                status: payload.status,
            },
        );
    }
}

fn push_sensitivity_and_retention_blockers(
    blockers: &mut Vec<AcceptedMemoryProjectionImportCandidateBlocker>,
    payload: &AcceptedMemoryProjectionPayload,
) {
    match payload.sensitivity {
        MemorySensitivityStorage::PublicProject | MemorySensitivityStorage::InternalProject => {}
        MemorySensitivityStorage::UserPrivate => {
            blockers.push(AcceptedMemoryProjectionImportCandidateBlocker::UserPrivateSensitivity);
        }
        MemorySensitivityStorage::SecretAdjacent => {
            blockers.push(AcceptedMemoryProjectionImportCandidateBlocker::SecretAdjacentSensitivity)
        }
        MemorySensitivityStorage::Restricted => {
            blockers.push(AcceptedMemoryProjectionImportCandidateBlocker::RestrictedSensitivity);
        }
    }

    match payload.retention {
        MemoryRetentionStoragePosture::ProjectContextCandidate => {}
        MemoryRetentionStoragePosture::ReviewQueue => {
            blockers.push(AcceptedMemoryProjectionImportCandidateBlocker::ReviewQueueRetention);
        }
        MemoryRetentionStoragePosture::LocalOnly => {
            blockers.push(AcceptedMemoryProjectionImportCandidateBlocker::LocalOnlyRetention);
        }
        MemoryRetentionStoragePosture::Expires { .. } => {
            blockers.push(AcceptedMemoryProjectionImportCandidateBlocker::ExpiringRetention);
        }
        MemoryRetentionStoragePosture::Archive => {
            blockers.push(AcceptedMemoryProjectionImportCandidateBlocker::ArchiveRetention);
        }
    }
}

fn push_review_blockers(
    blockers: &mut Vec<AcceptedMemoryProjectionImportCandidateBlocker>,
    payload: &AcceptedMemoryProjectionPayload,
) {
    if payload.accepted_by_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryProjectionImportCandidateBlocker::MissingAcceptedByRef);
    }
    if payload.review.reviewer_ref.trim().is_empty() {
        blockers.push(AcceptedMemoryProjectionImportCandidateBlocker::MissingReviewerRef);
    }
    if payload
        .accepted_at
        .as_deref()
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        blockers.push(AcceptedMemoryProjectionImportCandidateBlocker::MissingAcceptedAt);
    }
}

fn truncate_summary(summary: &str) -> String {
    const MAX_SUMMARY_CHARS: usize = 160;
    if summary.chars().count() <= MAX_SUMMARY_CHARS {
        return summary.to_owned();
    }
    summary.chars().take(MAX_SUMMARY_CHARS).collect()
}
