use serde::{Deserialize, Serialize};

use crate::{
    MemoryProposalReviewDiagnosticEntry, MemoryProposalReviewDiagnostics,
    MemoryProposalReviewProposalStatus, MemoryProposalReviewReviewStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlMemoryProposalReviewDiagnosticsDto {
    pub project_id: String,
    #[ts(as = "u32")]
    pub proposal_records: usize,
    #[ts(as = "u32")]
    pub queued_count: usize,
    #[ts(as = "u32")]
    pub deferred_count: usize,
    #[ts(as = "u32")]
    pub rejected_count: usize,
    #[ts(as = "u32")]
    pub reviewed_for_promotion_count: usize,
    #[ts(as = "u32")]
    pub blocked_count: usize,
    #[ts(as = "u32")]
    pub needs_review_count: usize,
    pub entries: Vec<ControlMemoryProposalReviewDiagnosticEntryDto>,
    pub client_can_mutate: bool,
    pub accepted_memory_created: bool,
    pub projection_written: bool,
    pub embedding_generated: bool,
    pub provider_native_memory_synced: bool,
    pub automatic_extraction_run: bool,
    pub raw_payload_exposed: bool,
    pub private_note_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlMemoryProposalReviewDiagnosticEntryDto {
    pub proposal_id: String,
    pub scope_ref: String,
    pub proposal_status: String,
    pub review_status: String,
    pub reviewer_ref_present: bool,
    pub note_present: bool,
    #[ts(as = "u32")]
    pub source_ref_count: usize,
    #[ts(as = "u32")]
    pub link_ref_count: usize,
}

impl From<&MemoryProposalReviewDiagnostics> for ControlMemoryProposalReviewDiagnosticsDto {
    fn from(diagnostics: &MemoryProposalReviewDiagnostics) -> Self {
        Self {
            project_id: diagnostics.project_id.0.clone(),
            proposal_records: diagnostics.proposal_records,
            queued_count: diagnostics.queued_count,
            deferred_count: diagnostics.deferred_count,
            rejected_count: diagnostics.rejected_count,
            reviewed_for_promotion_count: diagnostics.reviewed_for_promotion_count,
            blocked_count: diagnostics.blocked_count,
            needs_review_count: diagnostics.needs_review_count,
            entries: diagnostics
                .entries
                .iter()
                .map(ControlMemoryProposalReviewDiagnosticEntryDto::from)
                .collect(),
            client_can_mutate: diagnostics.client_can_mutate,
            accepted_memory_created: diagnostics.accepted_memory_created,
            projection_written: diagnostics.projection_written,
            embedding_generated: diagnostics.embedding_generated,
            provider_native_memory_synced: diagnostics.provider_native_memory_synced,
            automatic_extraction_run: diagnostics.automatic_extraction_run,
            raw_payload_exposed: diagnostics.raw_payload_exposed,
            private_note_exposed: diagnostics.private_note_exposed,
        }
    }
}

impl From<&MemoryProposalReviewDiagnosticEntry> for ControlMemoryProposalReviewDiagnosticEntryDto {
    fn from(entry: &MemoryProposalReviewDiagnosticEntry) -> Self {
        Self {
            proposal_id: entry.proposal_id.clone(),
            scope_ref: entry.scope_ref.clone(),
            proposal_status: proposal_status_dto(&entry.proposal_status),
            review_status: review_status_dto(&entry.review_status),
            reviewer_ref_present: entry.reviewer_ref_present,
            note_present: entry.note_present,
            source_ref_count: entry.source_ref_count,
            link_ref_count: entry.link_ref_count,
        }
    }
}

fn proposal_status_dto(status: &MemoryProposalReviewProposalStatus) -> String {
    match status {
        MemoryProposalReviewProposalStatus::Proposed => "proposed",
        MemoryProposalReviewProposalStatus::ReviewRequested => "review_requested",
        MemoryProposalReviewProposalStatus::Rejected => "rejected",
        MemoryProposalReviewProposalStatus::Stale => "stale",
        MemoryProposalReviewProposalStatus::Superseded => "superseded",
        MemoryProposalReviewProposalStatus::Archived => "archived",
    }
    .to_owned()
}

fn review_status_dto(status: &MemoryProposalReviewReviewStatus) -> String {
    match status {
        MemoryProposalReviewReviewStatus::Unreviewed => "unreviewed",
        MemoryProposalReviewReviewStatus::Queued => "queued",
        MemoryProposalReviewReviewStatus::NeedsHumanReview => "needs_human_review",
        MemoryProposalReviewReviewStatus::ReviewedForPromotion => "reviewed_for_promotion",
        MemoryProposalReviewReviewStatus::Rejected => "rejected",
        MemoryProposalReviewReviewStatus::Deferred => "deferred",
    }
    .to_owned()
}
