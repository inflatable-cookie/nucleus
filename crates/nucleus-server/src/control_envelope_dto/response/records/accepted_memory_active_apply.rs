use crate::provider_no_effects::MemoryApplyNoEffects;
use serde::{Deserialize, Serialize};

use crate::accepted_memory_active_apply_admission::{
    AcceptedMemoryActiveApplyAdmissionBlocker, AcceptedMemoryActiveApplyAdmissionRecord,
    AcceptedMemoryActiveApplyAdmissionStatus,
};
use crate::accepted_memory_active_apply_diagnostics::{
    AcceptedMemoryActiveApplyDiagnosticCounts, AcceptedMemoryActiveApplyDiagnostics,
};
use nucleus_memory::{
    AcceptedMemoryReviewReceiptAdmissionStatusStorage, AcceptedMemoryReviewReceiptDecisionStorage,
    AcceptedMemoryReviewReceiptStatusStorage,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryActiveApplyDiagnosticsDto {
    pub diagnostics_id: String,
    pub project_id: String,
    pub records: Vec<ControlAcceptedMemoryActiveApplyRecordDto>,
    pub counts: ControlAcceptedMemoryActiveApplyCountsDto,
    #[serde(flatten)]
    pub no_effects: MemoryApplyNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryActiveApplyRecordDto {
    pub active_apply_admission_ref: String,
    pub request_id: String,
    pub review_receipt_id: String,
    pub project_id: String,
    pub command_id: String,
    pub apply_admission_ref: String,
    pub import_admission_ref: String,
    pub conflict_ref: String,
    pub candidate_ref: String,
    pub memory_id: String,
    pub file_ref: String,
    pub operator_ref: String,
    pub approval_ref: String,
    pub provenance_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub review_decision: String,
    pub review_status: String,
    pub review_admission_status: String,
    pub status: String,
    pub blockers: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryActiveApplyCountsDto {
    #[ts(as = "u32")]
    pub source_records: usize,
    #[ts(as = "u32")]
    pub admitted: usize,
    #[ts(as = "u32")]
    pub duplicate_noops: usize,
    #[ts(as = "u32")]
    pub blocked: usize,
    #[ts(as = "u32")]
    pub blockers: usize,
    #[ts(as = "u32")]
    pub missing_ref_blockers: usize,
    #[ts(as = "u32")]
    pub review_state_blockers: usize,
    #[ts(as = "u32")]
    pub stale_ref_blockers: usize,
    #[ts(as = "u32")]
    pub raw_payload_blockers: usize,
    #[ts(as = "u32")]
    pub effect_blockers: usize,
    #[ts(as = "u32")]
    pub unsupported_records_skipped: usize,
    #[ts(as = "u32")]
    pub other_project_records_skipped: usize,
    #[ts(as = "u32")]
    pub decode_failed_records: usize,
}

impl From<&AcceptedMemoryActiveApplyDiagnostics>
    for ControlAcceptedMemoryActiveApplyDiagnosticsDto
{
    fn from(diagnostics: &AcceptedMemoryActiveApplyDiagnostics) -> Self {
        Self {
            diagnostics_id: diagnostics.diagnostics_id.clone(),
            project_id: diagnostics.project_id.0.clone(),
            records: diagnostics
                .records
                .iter()
                .map(ControlAcceptedMemoryActiveApplyRecordDto::from)
                .collect(),
            counts: ControlAcceptedMemoryActiveApplyCountsDto::from(&diagnostics.counts),
            no_effects: diagnostics.no_effects,
        }
    }
}

impl From<&AcceptedMemoryActiveApplyAdmissionRecord> for ControlAcceptedMemoryActiveApplyRecordDto {
    fn from(record: &AcceptedMemoryActiveApplyAdmissionRecord) -> Self {
        Self {
            active_apply_admission_ref: record.active_apply_admission_ref.clone(),
            request_id: record.request_id.clone(),
            review_receipt_id: record.review_receipt_id.clone(),
            project_id: record.project_id.clone(),
            command_id: record.command_id.clone(),
            apply_admission_ref: record.apply_admission_ref.clone(),
            import_admission_ref: record.import_admission_ref.clone(),
            conflict_ref: record.conflict_ref.clone(),
            candidate_ref: record.candidate_ref.clone(),
            memory_id: record.memory_id.clone(),
            file_ref: record.file_ref.clone(),
            operator_ref: record.operator_ref.clone(),
            approval_ref: record.approval_ref.clone(),
            provenance_refs: record.provenance_refs.clone(),
            evidence_refs: record.evidence_refs.clone(),
            review_decision: review_decision(&record.review_decision),
            review_status: review_status(&record.review_status),
            review_admission_status: review_admission_status(&record.review_admission_status),
            status: status(&record.status),
            blockers: record.blockers.iter().map(blocker).collect(),
        }
    }
}

impl From<&AcceptedMemoryActiveApplyDiagnosticCounts>
    for ControlAcceptedMemoryActiveApplyCountsDto
{
    fn from(counts: &AcceptedMemoryActiveApplyDiagnosticCounts) -> Self {
        Self {
            source_records: counts.source_records,
            admitted: counts.admitted,
            duplicate_noops: counts.duplicate_noops,
            blocked: counts.blocked,
            blockers: counts.blockers,
            missing_ref_blockers: counts.missing_ref_blockers,
            review_state_blockers: counts.review_state_blockers,
            stale_ref_blockers: counts.stale_ref_blockers,
            raw_payload_blockers: counts.raw_payload_blockers,
            effect_blockers: counts.effect_blockers,
            unsupported_records_skipped: counts.unsupported_records_skipped,
            other_project_records_skipped: counts.other_project_records_skipped,
            decode_failed_records: counts.decode_failed_records,
        }
    }
}

fn status(value: &AcceptedMemoryActiveApplyAdmissionStatus) -> String {
    match value {
        AcceptedMemoryActiveApplyAdmissionStatus::Admitted => "admitted",
        AcceptedMemoryActiveApplyAdmissionStatus::DuplicateNoop => "duplicate_noop",
        AcceptedMemoryActiveApplyAdmissionStatus::Blocked => "blocked",
    }
    .to_owned()
}

fn blocker(value: &AcceptedMemoryActiveApplyAdmissionBlocker) -> String {
    match value {
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingRequestId => "missing_request_id",
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingOperatorRef => "missing_operator_ref",
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingApprovalRef => "missing_approval_ref",
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingReviewReceiptId => {
            "missing_review_receipt_id"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingReviewApprovalRef => {
            "missing_review_approval_ref"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingApplyAdmissionRef => {
            "missing_apply_admission_ref"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingImportAdmissionRef => {
            "missing_import_admission_ref"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingConflictRef => "missing_conflict_ref",
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingCandidateRef => "missing_candidate_ref",
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingMemoryId => "missing_memory_id",
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingFileRef => "missing_file_ref",
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingProvenanceRefs => {
            "missing_provenance_refs"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::MissingEvidenceRefs => "missing_evidence_refs",
        AcceptedMemoryActiveApplyAdmissionBlocker::ReviewNotApproved => "review_not_approved",
        AcceptedMemoryActiveApplyAdmissionBlocker::ReviewDeferred => "review_deferred",
        AcceptedMemoryActiveApplyAdmissionBlocker::ReviewRejected => "review_rejected",
        AcceptedMemoryActiveApplyAdmissionBlocker::ReviewBlocked => "review_blocked",
        AcceptedMemoryActiveApplyAdmissionBlocker::ReviewAdmissionDuplicateNoop => {
            "review_admission_duplicate_noop"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::ReviewAdmissionBlocked => {
            "review_admission_blocked"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::ReviewBlockersPresent => {
            "review_blockers_present"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::AdmissionBlockersPresent => {
            "admission_blockers_present"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::StaleApplyAdmissionRef => {
            "stale_apply_admission_ref"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::StaleImportAdmissionRef => {
            "stale_import_admission_ref"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::StaleConflictRef => "stale_conflict_ref",
        AcceptedMemoryActiveApplyAdmissionBlocker::StaleCandidateRef => "stale_candidate_ref",
        AcceptedMemoryActiveApplyAdmissionBlocker::StaleMemoryId => "stale_memory_id",
        AcceptedMemoryActiveApplyAdmissionBlocker::StaleFileRef => "stale_file_ref",
        AcceptedMemoryActiveApplyAdmissionBlocker::StaleProvenanceRefs => "stale_provenance_refs",
        AcceptedMemoryActiveApplyAdmissionBlocker::StaleEvidenceRefs => "stale_evidence_refs",
        AcceptedMemoryActiveApplyAdmissionBlocker::RawPayloadPresent => "raw_payload_present",
        AcceptedMemoryActiveApplyAdmissionBlocker::ActiveMemoryMutationRequested => {
            "active_memory_mutation_requested"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::ProjectionWriteRequested => {
            "projection_write_requested"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::ScmEffectRequested => "scm_effect_requested",
        AcceptedMemoryActiveApplyAdmissionBlocker::EmbeddingRequested => "embedding_requested",
        AcceptedMemoryActiveApplyAdmissionBlocker::ProviderSyncRequested => {
            "provider_sync_requested"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::AutomaticExtractionRequested => {
            "automatic_extraction_requested"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::TaskMutationRequested => {
            "task_mutation_requested"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::AgentSchedulingRequested => {
            "agent_scheduling_requested"
        }
        AcceptedMemoryActiveApplyAdmissionBlocker::UiEffectRequested => "ui_effect_requested",
    }
    .to_owned()
}

fn review_decision(value: &AcceptedMemoryReviewReceiptDecisionStorage) -> String {
    match value {
        AcceptedMemoryReviewReceiptDecisionStorage::Approve => "approve",
        AcceptedMemoryReviewReceiptDecisionStorage::Defer => "defer",
        AcceptedMemoryReviewReceiptDecisionStorage::Reject => "reject",
    }
    .to_owned()
}

fn review_status(value: &AcceptedMemoryReviewReceiptStatusStorage) -> String {
    match value {
        AcceptedMemoryReviewReceiptStatusStorage::Approved => "approved",
        AcceptedMemoryReviewReceiptStatusStorage::Deferred => "deferred",
        AcceptedMemoryReviewReceiptStatusStorage::Rejected => "rejected",
        AcceptedMemoryReviewReceiptStatusStorage::Blocked => "blocked",
    }
    .to_owned()
}

fn review_admission_status(value: &AcceptedMemoryReviewReceiptAdmissionStatusStorage) -> String {
    match value {
        AcceptedMemoryReviewReceiptAdmissionStatusStorage::Admitted => "admitted",
        AcceptedMemoryReviewReceiptAdmissionStatusStorage::DuplicateNoop => "duplicate_noop",
        AcceptedMemoryReviewReceiptAdmissionStatusStorage::Blocked => "blocked",
    }
    .to_owned()
}
