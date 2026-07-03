//! Read-only diagnostics for memory proposal review state.

use nucleus_memory::{
    MemoryProposalStorageRecord, MemoryProposalStorageScope, MemoryProposalStorageStatus,
    MemoryReviewStorageStatus,
};
use nucleus_projects::ProjectId;

/// Sanitized review-state diagnostics for memory proposals.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalReviewDiagnostics {
    pub project_id: ProjectId,
    pub proposal_records: usize,
    pub queued_count: usize,
    pub deferred_count: usize,
    pub rejected_count: usize,
    pub reviewed_for_promotion_count: usize,
    pub blocked_count: usize,
    pub needs_review_count: usize,
    pub entries: Vec<MemoryProposalReviewDiagnosticEntry>,
    pub client_can_mutate: bool,
    pub accepted_memory_created: bool,
    pub projection_written: bool,
    pub embedding_generated: bool,
    pub provider_native_memory_synced: bool,
    pub automatic_extraction_run: bool,
    pub raw_payload_exposed: bool,
    pub private_note_exposed: bool,
}

/// Sanitized proposal review diagnostic entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryProposalReviewDiagnosticEntry {
    pub proposal_id: String,
    pub scope_ref: String,
    pub proposal_status: MemoryProposalReviewProposalStatus,
    pub review_status: MemoryProposalReviewReviewStatus,
    pub reviewer_ref_present: bool,
    pub note_present: bool,
    pub source_ref_count: usize,
    pub link_ref_count: usize,
}

/// Proposal status bucket exposed to clients.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MemoryProposalReviewProposalStatus {
    Proposed,
    ReviewRequested,
    Rejected,
    Stale,
    Superseded,
    Archived,
}

/// Review status bucket exposed to clients.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MemoryProposalReviewReviewStatus {
    Unreviewed,
    Queued,
    NeedsHumanReview,
    ReviewedForPromotion,
    Rejected,
    Deferred,
}

pub fn memory_proposal_review_diagnostics(
    project_id: ProjectId,
    records: impl IntoIterator<Item = MemoryProposalStorageRecord>,
) -> MemoryProposalReviewDiagnostics {
    let mut records = records
        .into_iter()
        .filter(|record| record_project_ref(record).is_some_and(|scope| scope == project_id.0))
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.proposal_id.cmp(&right.proposal_id));

    let mut diagnostics = MemoryProposalReviewDiagnostics {
        project_id,
        proposal_records: records.len(),
        queued_count: 0,
        deferred_count: 0,
        rejected_count: 0,
        reviewed_for_promotion_count: 0,
        blocked_count: 0,
        needs_review_count: 0,
        entries: records.iter().map(entry_from_record).collect(),
        client_can_mutate: false,
        accepted_memory_created: false,
        projection_written: false,
        embedding_generated: false,
        provider_native_memory_synced: false,
        automatic_extraction_run: false,
        raw_payload_exposed: false,
        private_note_exposed: false,
    };

    for entry in &diagnostics.entries {
        match entry.review_status {
            MemoryProposalReviewReviewStatus::Queued => diagnostics.queued_count += 1,
            MemoryProposalReviewReviewStatus::Deferred => diagnostics.deferred_count += 1,
            MemoryProposalReviewReviewStatus::Rejected => diagnostics.rejected_count += 1,
            MemoryProposalReviewReviewStatus::ReviewedForPromotion => {
                diagnostics.reviewed_for_promotion_count += 1;
            }
            MemoryProposalReviewReviewStatus::NeedsHumanReview
            | MemoryProposalReviewReviewStatus::Unreviewed => diagnostics.needs_review_count += 1,
        }
        if is_blocked_proposal_status(&entry.proposal_status) {
            diagnostics.blocked_count += 1;
        }
    }

    diagnostics
}

fn entry_from_record(record: &MemoryProposalStorageRecord) -> MemoryProposalReviewDiagnosticEntry {
    MemoryProposalReviewDiagnosticEntry {
        proposal_id: record.proposal_id.clone(),
        scope_ref: record_project_ref(record)
            .unwrap_or("scope:unsupported")
            .to_owned(),
        proposal_status: proposal_status(&record.status),
        review_status: review_status(&record.review.status),
        reviewer_ref_present: record.review.reviewer_ref.is_some(),
        note_present: record.review.note.is_some(),
        source_ref_count: record.source_refs.len(),
        link_ref_count: record.link_refs.planning_session_refs.len()
            + record.link_refs.exploration_session_refs.len()
            + record.link_refs.planning_artifact_refs.len()
            + record.link_refs.task_seed_refs.len()
            + record.link_refs.research_brief_refs.len()
            + record.link_refs.task_refs.len()
            + record.link_refs.evidence_refs.len(),
    }
}

fn record_project_ref(record: &MemoryProposalStorageRecord) -> Option<&str> {
    match &record.scope {
        MemoryProposalStorageScope::Project { project_ref } => Some(project_ref.as_str()),
        _ => None,
    }
}

fn is_blocked_proposal_status(status: &MemoryProposalReviewProposalStatus) -> bool {
    matches!(
        status,
        MemoryProposalReviewProposalStatus::Stale
            | MemoryProposalReviewProposalStatus::Superseded
            | MemoryProposalReviewProposalStatus::Archived
    )
}

fn proposal_status(status: &MemoryProposalStorageStatus) -> MemoryProposalReviewProposalStatus {
    match status {
        MemoryProposalStorageStatus::Proposed => MemoryProposalReviewProposalStatus::Proposed,
        MemoryProposalStorageStatus::ReviewRequested => {
            MemoryProposalReviewProposalStatus::ReviewRequested
        }
        MemoryProposalStorageStatus::Rejected => MemoryProposalReviewProposalStatus::Rejected,
        MemoryProposalStorageStatus::Stale => MemoryProposalReviewProposalStatus::Stale,
        MemoryProposalStorageStatus::Superseded => MemoryProposalReviewProposalStatus::Superseded,
        MemoryProposalStorageStatus::Archived => MemoryProposalReviewProposalStatus::Archived,
    }
}

fn review_status(status: &MemoryReviewStorageStatus) -> MemoryProposalReviewReviewStatus {
    match status {
        MemoryReviewStorageStatus::Unreviewed => MemoryProposalReviewReviewStatus::Unreviewed,
        MemoryReviewStorageStatus::Queued => MemoryProposalReviewReviewStatus::Queued,
        MemoryReviewStorageStatus::NeedsHumanReview => {
            MemoryProposalReviewReviewStatus::NeedsHumanReview
        }
        MemoryReviewStorageStatus::ReviewedForPromotion => {
            MemoryProposalReviewReviewStatus::ReviewedForPromotion
        }
        MemoryReviewStorageStatus::Rejected => MemoryProposalReviewReviewStatus::Rejected,
        MemoryReviewStorageStatus::Deferred => MemoryProposalReviewReviewStatus::Deferred,
    }
}

#[cfg(test)]
mod tests {
    use nucleus_memory::{
        MemoryConfidenceStorage, MemoryLinkStorageRefs, MemoryProposalStorageKind,
        MemoryRetentionStoragePosture, MemoryReviewStorageState, MemorySensitivityStorage,
        MemorySourceStorageKind, MemorySourceStorageRef, MemorySupersessionStorageRefs,
        MEMORY_STORAGE_SCHEMA_VERSION,
    };

    use super::*;

    #[test]
    fn diagnostics_counts_review_states_without_private_payloads() {
        let diagnostics = memory_proposal_review_diagnostics(
            ProjectId("project:nucleus".to_owned()),
            vec![
                proposal(
                    "memory-proposal:queued",
                    MemoryProposalStorageStatus::ReviewRequested,
                    MemoryReviewStorageStatus::Queued,
                ),
                proposal(
                    "memory-proposal:reviewed",
                    MemoryProposalStorageStatus::ReviewRequested,
                    MemoryReviewStorageStatus::ReviewedForPromotion,
                ),
                proposal(
                    "memory-proposal:archived",
                    MemoryProposalStorageStatus::Archived,
                    MemoryReviewStorageStatus::Deferred,
                ),
            ],
        );

        assert_eq!(diagnostics.proposal_records, 3);
        assert_eq!(diagnostics.queued_count, 1);
        assert_eq!(diagnostics.deferred_count, 1);
        assert_eq!(diagnostics.reviewed_for_promotion_count, 1);
        assert_eq!(diagnostics.blocked_count, 1);
        assert!(!diagnostics.raw_payload_exposed);
        assert!(!diagnostics.private_note_exposed);
        assert_eq!(
            diagnostics.entries[0].proposal_id,
            "memory-proposal:archived"
        );
    }

    fn proposal(
        proposal_id: &str,
        status: MemoryProposalStorageStatus,
        review_status: MemoryReviewStorageStatus,
    ) -> MemoryProposalStorageRecord {
        MemoryProposalStorageRecord {
            schema_version: MEMORY_STORAGE_SCHEMA_VERSION,
            proposal_id: proposal_id.to_owned(),
            scope: MemoryProposalStorageScope::Project {
                project_ref: "project:nucleus".to_owned(),
            },
            kind: MemoryProposalStorageKind::Decision,
            status,
            title: "Hidden".to_owned(),
            summary: "Hidden".to_owned(),
            detail: Some("Hidden".to_owned()),
            source_refs: vec![MemorySourceStorageRef {
                kind: MemorySourceStorageKind::PlanningSession,
                source_ref: "planning-session:memory".to_owned(),
                evidence_ref: None,
            }],
            link_refs: MemoryLinkStorageRefs::default(),
            confidence: MemoryConfidenceStorage::Medium,
            review: MemoryReviewStorageState {
                status: review_status,
                reviewer_ref: Some("user:tom".to_owned()),
                note: Some("Hidden note".to_owned()),
            },
            sensitivity: MemorySensitivityStorage::InternalProject,
            retention: MemoryRetentionStoragePosture::ReviewQueue,
            supersession: MemorySupersessionStorageRefs::default(),
            proposed_at: None,
            updated_at: None,
        }
    }
}
