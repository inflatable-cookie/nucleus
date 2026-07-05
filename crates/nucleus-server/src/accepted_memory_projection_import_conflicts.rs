//! Read-only accepted-memory projection import conflict staging.
//!
//! Conflict staging compares admitted projected memory against active accepted
//! memory without resolving or applying imports.

use std::collections::HashMap;

use nucleus_memory::{AcceptedMemoryStorageBody, AcceptedMemoryStorageRecord};

use crate::accepted_memory_projection_import_admission::{
    AcceptedMemoryProjectionImportAdmissionRecord, AcceptedMemoryProjectionImportAdmissionStatus,
    AcceptedMemoryProjectionImportCandidateSummary,
};
use crate::accepted_memory_projection_payload::AcceptedMemoryProjectionPayload;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportConflictSet {
    pub conflicts: Vec<AcceptedMemoryProjectionImportConflictRecord>,
    pub counts: AcceptedMemoryProjectionImportConflictCounts,
    pub active_memory_apply_performed: bool,
    pub scm_effect_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub task_mutation_performed: bool,
    pub ui_effect_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportConflictRecord {
    pub conflict_ref: String,
    pub admission_ref: String,
    pub candidate_ref: String,
    pub memory_id: Option<String>,
    pub file_ref: String,
    pub status: AcceptedMemoryProjectionImportConflictStatus,
    pub summary: Option<AcceptedMemoryProjectionImportCandidateSummary>,
    pub blockers: Vec<AcceptedMemoryProjectionImportConflictBlocker>,
    pub active_memory_apply_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionImportConflictStatus {
    NoConflict,
    DuplicateNoop,
    SemanticConflict,
    PolicyConflict,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionImportConflictBlocker {
    AdmissionNotAdmitted,
    MissingMemoryId,
    MissingPayload,
    BodyMismatch,
    SupersessionMismatch,
    ReviewEvidenceMismatch,
    SensitivityMismatch,
    RetentionMismatch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionImportConflictCounts {
    pub admissions: usize,
    pub no_conflicts: usize,
    pub duplicate_noops: usize,
    pub semantic_conflicts: usize,
    pub policy_conflicts: usize,
    pub blocked: usize,
    pub blockers: usize,
}

pub fn accepted_memory_projection_import_conflicts(
    admissions: &[AcceptedMemoryProjectionImportAdmissionRecord],
    active_records: &[AcceptedMemoryStorageRecord],
) -> AcceptedMemoryProjectionImportConflictSet {
    let active_by_memory_id: HashMap<_, _> = active_records
        .iter()
        .map(|record| (record.memory_id.clone(), record))
        .collect();
    let conflicts: Vec<_> = admissions
        .iter()
        .map(|admission| {
            accepted_memory_projection_import_conflict(admission, &active_by_memory_id)
        })
        .collect();
    let counts = AcceptedMemoryProjectionImportConflictCounts::from_conflicts(&conflicts);

    AcceptedMemoryProjectionImportConflictSet {
        conflicts,
        counts,
        active_memory_apply_performed: false,
        scm_effect_performed: false,
        embedding_available: false,
        provider_sync_available: false,
        task_mutation_performed: false,
        ui_effect_performed: false,
    }
}

impl AcceptedMemoryProjectionImportConflictCounts {
    fn from_conflicts(conflicts: &[AcceptedMemoryProjectionImportConflictRecord]) -> Self {
        let mut counts = Self {
            admissions: conflicts.len(),
            no_conflicts: 0,
            duplicate_noops: 0,
            semantic_conflicts: 0,
            policy_conflicts: 0,
            blocked: 0,
            blockers: 0,
        };

        for conflict in conflicts {
            match conflict.status {
                AcceptedMemoryProjectionImportConflictStatus::NoConflict => {
                    counts.no_conflicts += 1;
                }
                AcceptedMemoryProjectionImportConflictStatus::DuplicateNoop => {
                    counts.duplicate_noops += 1;
                }
                AcceptedMemoryProjectionImportConflictStatus::SemanticConflict => {
                    counts.semantic_conflicts += 1;
                }
                AcceptedMemoryProjectionImportConflictStatus::PolicyConflict => {
                    counts.policy_conflicts += 1;
                }
                AcceptedMemoryProjectionImportConflictStatus::Blocked => {
                    counts.blocked += 1;
                }
            }
            counts.blockers += conflict.blockers.len();
        }

        counts
    }
}

fn accepted_memory_projection_import_conflict(
    admission: &AcceptedMemoryProjectionImportAdmissionRecord,
    active_by_memory_id: &HashMap<String, &AcceptedMemoryStorageRecord>,
) -> AcceptedMemoryProjectionImportConflictRecord {
    let mut blockers = Vec::new();
    if admission.status != AcceptedMemoryProjectionImportAdmissionStatus::Admitted {
        blockers.push(AcceptedMemoryProjectionImportConflictBlocker::AdmissionNotAdmitted);
    }

    let memory_id = admission.memory_id.clone();
    let Some(memory_id_ref) = memory_id.as_ref() else {
        blockers.push(AcceptedMemoryProjectionImportConflictBlocker::MissingMemoryId);
        return conflict_record(admission, memory_id, None, false, blockers);
    };

    let Some(payload) = admission.payload.as_ref() else {
        blockers.push(AcceptedMemoryProjectionImportConflictBlocker::MissingPayload);
        return conflict_record(admission, memory_id, None, false, blockers);
    };

    let active_match_found = if let Some(active) = active_by_memory_id.get(memory_id_ref) {
        blockers.extend(payload_active_conflict_blockers(payload, active));
        true
    } else {
        false
    };

    let summary = Some(payload_summary(payload));
    conflict_record(admission, memory_id, summary, active_match_found, blockers)
}

fn conflict_record(
    admission: &AcceptedMemoryProjectionImportAdmissionRecord,
    memory_id: Option<String>,
    summary: Option<AcceptedMemoryProjectionImportCandidateSummary>,
    active_match_found: bool,
    blockers: Vec<AcceptedMemoryProjectionImportConflictBlocker>,
) -> AcceptedMemoryProjectionImportConflictRecord {
    let status = conflict_status(active_match_found, &blockers);
    AcceptedMemoryProjectionImportConflictRecord {
        conflict_ref: accepted_memory_projection_import_conflict_ref(&admission.admission_ref),
        admission_ref: admission.admission_ref.clone(),
        candidate_ref: admission.candidate_ref.clone(),
        memory_id,
        file_ref: admission.file_ref.clone(),
        status,
        summary,
        blockers,
        active_memory_apply_performed: false,
    }
}

pub fn accepted_memory_projection_import_conflict_ref(admission_ref: &str) -> String {
    format!("accepted-memory-import-conflict:{admission_ref}")
}

fn conflict_status(
    active_match_found: bool,
    blockers: &[AcceptedMemoryProjectionImportConflictBlocker],
) -> AcceptedMemoryProjectionImportConflictStatus {
    if blockers.is_empty() {
        if active_match_found {
            return AcceptedMemoryProjectionImportConflictStatus::DuplicateNoop;
        }
        return AcceptedMemoryProjectionImportConflictStatus::NoConflict;
    }
    if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            AcceptedMemoryProjectionImportConflictBlocker::AdmissionNotAdmitted
                | AcceptedMemoryProjectionImportConflictBlocker::MissingMemoryId
                | AcceptedMemoryProjectionImportConflictBlocker::MissingPayload
        )
    }) {
        return AcceptedMemoryProjectionImportConflictStatus::Blocked;
    }
    if blockers.iter().any(|blocker| {
        matches!(
            blocker,
            AcceptedMemoryProjectionImportConflictBlocker::SensitivityMismatch
                | AcceptedMemoryProjectionImportConflictBlocker::RetentionMismatch
        )
    }) {
        return AcceptedMemoryProjectionImportConflictStatus::PolicyConflict;
    }
    AcceptedMemoryProjectionImportConflictStatus::SemanticConflict
}

fn payload_active_conflict_blockers(
    payload: &AcceptedMemoryProjectionPayload,
    active: &AcceptedMemoryStorageRecord,
) -> Vec<AcceptedMemoryProjectionImportConflictBlocker> {
    let mut blockers = Vec::new();

    if payload.body != active.body {
        blockers.push(AcceptedMemoryProjectionImportConflictBlocker::BodyMismatch);
    }
    if payload.supersession != active.supersession {
        blockers.push(AcceptedMemoryProjectionImportConflictBlocker::SupersessionMismatch);
    }
    if payload.accepted_by_ref != active.actors.accepted_by_ref
        || payload.review != active.review
        || payload.accepted_at != active.accepted_at
    {
        blockers.push(AcceptedMemoryProjectionImportConflictBlocker::ReviewEvidenceMismatch);
    }
    if payload.sensitivity != active.sensitivity {
        blockers.push(AcceptedMemoryProjectionImportConflictBlocker::SensitivityMismatch);
    }
    if payload.retention != active.retention {
        blockers.push(AcceptedMemoryProjectionImportConflictBlocker::RetentionMismatch);
    }

    blockers
}

fn payload_summary(
    payload: &AcceptedMemoryProjectionPayload,
) -> AcceptedMemoryProjectionImportCandidateSummary {
    match &payload.body {
        AcceptedMemoryStorageBody::Summary { summary, .. } => {
            AcceptedMemoryProjectionImportCandidateSummary {
                title: payload.title.clone(),
                body_kind: "summary".to_owned(),
                body_summary: summary.chars().take(160).collect(),
            }
        }
        AcceptedMemoryStorageBody::StructuredRef { ref_id, summary } => {
            AcceptedMemoryProjectionImportCandidateSummary {
                title: payload.title.clone(),
                body_kind: "structured_ref".to_owned(),
                body_summary: format!(
                    "{}: {}",
                    ref_id,
                    summary.chars().take(160).collect::<String>()
                ),
            }
        }
    }
}
