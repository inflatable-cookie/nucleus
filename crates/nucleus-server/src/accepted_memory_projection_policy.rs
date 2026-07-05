//! Accepted-memory projection eligibility policy.
//!
//! This module decides whether server-owned accepted memory may be projected
//! later. It does not write files, call SCM/forge providers, run embeddings,
//! sync provider memory, mutate tasks, or expose raw memory bodies.

use nucleus_memory::{
    AcceptedMemoryStorageRecord, AcceptedMemoryStorageStatus, MemoryProposalStorageScope,
    MemoryRetentionStoragePosture, MemorySensitivityStorage,
};
use nucleus_projects::ProjectId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionPolicyDecision {
    pub memory_id: String,
    pub status: AcceptedMemoryProjectionPolicyStatus,
    pub blockers: Vec<AcceptedMemoryProjectionPolicyBlocker>,
    pub client_can_write_projection: bool,
    pub projection_write_performed: bool,
    pub scm_effect_available: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionPolicyStatus {
    Projectable,
    LocalOnly,
    Blocked,
    ReviewRequired,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionPolicyBlocker {
    NonAcceptedStatus { status: AcceptedMemoryPolicyStatus },
    MissingProjectScope,
    OutOfScopeProject { project_ref: String },
    UserPrivateScope,
    UserPrivateSensitivity,
    SecretAdjacentSensitivity,
    RestrictedSensitivity,
    ReviewQueueRetention,
    LocalOnlyRetention,
    ExpiringRetention,
    ArchiveRetention,
    MissingReviewEvidence,
    SupersededByAcceptedMemory { refs: Vec<String> },
    UnsafeExportIntent { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryPolicyStatus {
    Stale,
    Superseded,
    Archived,
}

pub fn accepted_memory_projection_policy_decision(
    project_id: &ProjectId,
    record: &AcceptedMemoryStorageRecord,
) -> AcceptedMemoryProjectionPolicyDecision {
    let mut blockers = Vec::new();

    add_status_blockers(record, &mut blockers);
    add_scope_blockers(project_id, record, &mut blockers);
    add_sensitivity_blockers(record, &mut blockers);
    add_retention_blockers(record, &mut blockers);
    add_review_blockers(record, &mut blockers);
    add_supersession_blockers(record, &mut blockers);
    add_export_intent_blockers(record, &mut blockers);

    AcceptedMemoryProjectionPolicyDecision {
        memory_id: record.memory_id.clone(),
        status: policy_status(&blockers),
        blockers,
        client_can_write_projection: false,
        projection_write_performed: false,
        scm_effect_available: false,
    }
}

fn add_status_blockers(
    record: &AcceptedMemoryStorageRecord,
    blockers: &mut Vec<AcceptedMemoryProjectionPolicyBlocker>,
) {
    match record.status {
        AcceptedMemoryStorageStatus::Accepted => {}
        AcceptedMemoryStorageStatus::Stale => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::NonAcceptedStatus {
                status: AcceptedMemoryPolicyStatus::Stale,
            });
        }
        AcceptedMemoryStorageStatus::Superseded => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::NonAcceptedStatus {
                status: AcceptedMemoryPolicyStatus::Superseded,
            });
        }
        AcceptedMemoryStorageStatus::Archived => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::NonAcceptedStatus {
                status: AcceptedMemoryPolicyStatus::Archived,
            });
        }
    }
}

fn add_scope_blockers(
    project_id: &ProjectId,
    record: &AcceptedMemoryStorageRecord,
    blockers: &mut Vec<AcceptedMemoryProjectionPolicyBlocker>,
) {
    match &record.scope {
        MemoryProposalStorageScope::Project { project_ref } if project_ref == &project_id.0 => {}
        MemoryProposalStorageScope::Project { project_ref } => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::OutOfScopeProject {
                project_ref: project_ref.clone(),
            });
        }
        MemoryProposalStorageScope::UserPrivate => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::UserPrivateScope);
        }
        MemoryProposalStorageScope::Task { .. }
        | MemoryProposalStorageScope::AgentSession { .. }
        | MemoryProposalStorageScope::RepoMembership { .. }
        | MemoryProposalStorageScope::Workspace { .. } => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::MissingProjectScope);
        }
    }
}

fn add_sensitivity_blockers(
    record: &AcceptedMemoryStorageRecord,
    blockers: &mut Vec<AcceptedMemoryProjectionPolicyBlocker>,
) {
    match record.sensitivity {
        MemorySensitivityStorage::PublicProject | MemorySensitivityStorage::InternalProject => {}
        MemorySensitivityStorage::UserPrivate => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::UserPrivateSensitivity);
        }
        MemorySensitivityStorage::SecretAdjacent => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::SecretAdjacentSensitivity);
        }
        MemorySensitivityStorage::Restricted => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::RestrictedSensitivity);
        }
    }
}

fn add_retention_blockers(
    record: &AcceptedMemoryStorageRecord,
    blockers: &mut Vec<AcceptedMemoryProjectionPolicyBlocker>,
) {
    match record.retention {
        MemoryRetentionStoragePosture::ProjectContextCandidate => {}
        MemoryRetentionStoragePosture::ReviewQueue => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::ReviewQueueRetention);
        }
        MemoryRetentionStoragePosture::LocalOnly => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::LocalOnlyRetention);
        }
        MemoryRetentionStoragePosture::Expires { .. } => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::ExpiringRetention);
        }
        MemoryRetentionStoragePosture::Archive => {
            blockers.push(AcceptedMemoryProjectionPolicyBlocker::ArchiveRetention);
        }
    }
}

fn add_review_blockers(
    record: &AcceptedMemoryStorageRecord,
    blockers: &mut Vec<AcceptedMemoryProjectionPolicyBlocker>,
) {
    if record.review.reviewer_ref.trim().is_empty()
        || record.actors.accepted_by_ref.trim().is_empty()
        || record.accepted_at.as_deref().is_none_or(str::is_empty)
    {
        blockers.push(AcceptedMemoryProjectionPolicyBlocker::MissingReviewEvidence);
    }
}

fn add_supersession_blockers(
    record: &AcceptedMemoryStorageRecord,
    blockers: &mut Vec<AcceptedMemoryProjectionPolicyBlocker>,
) {
    if !record.supersession.superseded_by.is_empty() {
        blockers.push(
            AcceptedMemoryProjectionPolicyBlocker::SupersededByAcceptedMemory {
                refs: record.supersession.superseded_by.clone(),
            },
        );
    }
}

fn add_export_intent_blockers(
    record: &AcceptedMemoryStorageRecord,
    blockers: &mut Vec<AcceptedMemoryProjectionPolicyBlocker>,
) {
    if !memory_id_is_path_safe(&record.memory_id) {
        blockers.push(AcceptedMemoryProjectionPolicyBlocker::UnsafeExportIntent {
            reason: "memory id is not safe for deterministic projection path".to_owned(),
        });
    }
}

fn policy_status(
    blockers: &[AcceptedMemoryProjectionPolicyBlocker],
) -> AcceptedMemoryProjectionPolicyStatus {
    if blockers.is_empty() {
        return AcceptedMemoryProjectionPolicyStatus::Projectable;
    }

    if blockers.iter().all(is_local_only_blocker) {
        return AcceptedMemoryProjectionPolicyStatus::LocalOnly;
    }

    if blockers.iter().all(is_review_required_blocker) {
        return AcceptedMemoryProjectionPolicyStatus::ReviewRequired;
    }

    AcceptedMemoryProjectionPolicyStatus::Blocked
}

fn is_local_only_blocker(blocker: &AcceptedMemoryProjectionPolicyBlocker) -> bool {
    matches!(
        blocker,
        AcceptedMemoryProjectionPolicyBlocker::UserPrivateScope
            | AcceptedMemoryProjectionPolicyBlocker::UserPrivateSensitivity
            | AcceptedMemoryProjectionPolicyBlocker::LocalOnlyRetention
    )
}

fn is_review_required_blocker(blocker: &AcceptedMemoryProjectionPolicyBlocker) -> bool {
    matches!(
        blocker,
        AcceptedMemoryProjectionPolicyBlocker::SecretAdjacentSensitivity
            | AcceptedMemoryProjectionPolicyBlocker::ReviewQueueRetention
            | AcceptedMemoryProjectionPolicyBlocker::MissingProjectScope
            | AcceptedMemoryProjectionPolicyBlocker::MissingReviewEvidence
    )
}

fn memory_id_is_path_safe(memory_id: &str) -> bool {
    !memory_id.trim().is_empty()
        && !memory_id.contains('/')
        && !memory_id.contains('\\')
        && !memory_id.contains("..")
}
