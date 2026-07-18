use crate::provider_no_effects::{MemoryApplyNoEffects};
use serde::{Deserialize, Serialize};

use crate::accepted_memory_review_receipt_storage_diagnostics::{
    AcceptedMemoryReviewReceiptStorageDiagnosticCounts,
    AcceptedMemoryReviewReceiptStorageDiagnostics,
};
use nucleus_memory::{
    AcceptedMemoryReviewReceiptAdmissionBlockerStorage,
    AcceptedMemoryReviewReceiptAdmissionStatusStorage, AcceptedMemoryReviewReceiptBlockerStorage,
    AcceptedMemoryReviewReceiptDecisionStorage, AcceptedMemoryReviewReceiptStatusStorage,
    AcceptedMemoryReviewReceiptStorageRecord,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryReviewReceiptStorageDiagnosticsDto {
    pub diagnostics_id: String,
    pub project_id: String,
    pub receipts: Vec<ControlAcceptedMemoryReviewReceiptStorageRecordDto>,
    pub counts: ControlAcceptedMemoryReviewReceiptStorageCountsDto,
    pub review_receipts_persisted: bool,
    #[serde(flatten)]
    pub no_effects: MemoryApplyNoEffects,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryReviewReceiptStorageRecordDto {
    pub review_receipt_id: String,
    pub command_id: String,
    pub operator_ref: String,
    pub approval_ref: Option<String>,
    pub decision_reason_ref: Option<String>,
    pub apply_admission_ref: String,
    pub import_admission_ref: String,
    pub conflict_ref: String,
    pub candidate_ref: String,
    pub memory_id: String,
    pub file_ref: String,
    pub provenance_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub decision: String,
    pub status: String,
    pub admission_status: String,
    pub blockers: Vec<String>,
    pub admission_blockers: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ControlAcceptedMemoryReviewReceiptStorageCountsDto {
    #[ts(as = "u32")]
    pub records: usize,
    #[ts(as = "u32")]
    pub approved: usize,
    #[ts(as = "u32")]
    pub deferred: usize,
    #[ts(as = "u32")]
    pub rejected: usize,
    #[ts(as = "u32")]
    pub blocked: usize,
    #[ts(as = "u32")]
    pub admitted: usize,
    #[ts(as = "u32")]
    pub duplicate_noops: usize,
    #[ts(as = "u32")]
    pub admission_blocked: usize,
    #[ts(as = "u32")]
    pub blockers: usize,
    #[ts(as = "u32")]
    pub admission_blockers: usize,
    #[ts(as = "u32")]
    pub provenance_refs: usize,
    #[ts(as = "u32")]
    pub evidence_refs: usize,
    #[ts(as = "u32")]
    pub unsupported_records_skipped: usize,
    #[ts(as = "u32")]
    pub other_project_records_skipped: usize,
    #[ts(as = "u32")]
    pub decode_failed_records: usize,
}

impl From<&AcceptedMemoryReviewReceiptStorageDiagnostics>
    for ControlAcceptedMemoryReviewReceiptStorageDiagnosticsDto
{
    fn from(diagnostics: &AcceptedMemoryReviewReceiptStorageDiagnostics) -> Self {
        Self {
            diagnostics_id: diagnostics.diagnostics_id.clone(),
            project_id: diagnostics.project_id.0.clone(),
            receipts: diagnostics
                .receipts
                .iter()
                .map(ControlAcceptedMemoryReviewReceiptStorageRecordDto::from)
                .collect(),
            counts: ControlAcceptedMemoryReviewReceiptStorageCountsDto::from(&diagnostics.counts),
            review_receipts_persisted: diagnostics.review_receipts_persisted,
        no_effects: diagnostics.no_effects,
        }
    }
}

impl From<&AcceptedMemoryReviewReceiptStorageRecord>
    for ControlAcceptedMemoryReviewReceiptStorageRecordDto
{
    fn from(record: &AcceptedMemoryReviewReceiptStorageRecord) -> Self {
        Self {
            review_receipt_id: record.review_receipt_id.clone(),
            command_id: record.command_id.clone(),
            operator_ref: record.operator_ref.clone(),
            approval_ref: record.approval_ref.clone(),
            decision_reason_ref: record.decision_reason_ref.clone(),
            apply_admission_ref: record.apply_admission_ref.clone(),
            import_admission_ref: record.import_admission_ref.clone(),
            conflict_ref: record.conflict_ref.clone(),
            candidate_ref: record.candidate_ref.clone(),
            memory_id: record.memory_id.clone(),
            file_ref: record.file_ref.clone(),
            provenance_refs: record.provenance_refs.clone(),
            evidence_refs: record.evidence_refs.clone(),
            decision: decision(&record.decision),
            status: status(&record.status),
            admission_status: admission_status(&record.admission_status),
            blockers: record.blockers.iter().map(blocker).collect(),
            admission_blockers: record
                .admission_blockers
                .iter()
                .map(admission_blocker)
                .collect(),
        }
    }
}

impl From<&AcceptedMemoryReviewReceiptStorageDiagnosticCounts>
    for ControlAcceptedMemoryReviewReceiptStorageCountsDto
{
    fn from(counts: &AcceptedMemoryReviewReceiptStorageDiagnosticCounts) -> Self {
        Self {
            records: counts.records,
            approved: counts.approved,
            deferred: counts.deferred,
            rejected: counts.rejected,
            blocked: counts.blocked,
            admitted: counts.admitted,
            duplicate_noops: counts.duplicate_noops,
            admission_blocked: counts.admission_blocked,
            blockers: counts.blockers,
            admission_blockers: counts.admission_blockers,
            provenance_refs: counts.provenance_refs,
            evidence_refs: counts.evidence_refs,
            unsupported_records_skipped: counts.unsupported_records_skipped,
            other_project_records_skipped: counts.other_project_records_skipped,
            decode_failed_records: counts.decode_failed_records,
        }
    }
}

fn decision(value: &AcceptedMemoryReviewReceiptDecisionStorage) -> String {
    match value {
        AcceptedMemoryReviewReceiptDecisionStorage::Approve => "approve",
        AcceptedMemoryReviewReceiptDecisionStorage::Defer => "defer",
        AcceptedMemoryReviewReceiptDecisionStorage::Reject => "reject",
    }
    .to_owned()
}

fn status(value: &AcceptedMemoryReviewReceiptStatusStorage) -> String {
    match value {
        AcceptedMemoryReviewReceiptStatusStorage::Approved => "approved",
        AcceptedMemoryReviewReceiptStatusStorage::Deferred => "deferred",
        AcceptedMemoryReviewReceiptStatusStorage::Rejected => "rejected",
        AcceptedMemoryReviewReceiptStatusStorage::Blocked => "blocked",
    }
    .to_owned()
}

fn admission_status(value: &AcceptedMemoryReviewReceiptAdmissionStatusStorage) -> String {
    match value {
        AcceptedMemoryReviewReceiptAdmissionStatusStorage::Admitted => "admitted",
        AcceptedMemoryReviewReceiptAdmissionStatusStorage::DuplicateNoop => "duplicate_noop",
        AcceptedMemoryReviewReceiptAdmissionStatusStorage::Blocked => "blocked",
    }
    .to_owned()
}

fn blocker(value: &AcceptedMemoryReviewReceiptBlockerStorage) -> String {
    format!("{value:?}")
}

fn admission_blocker(value: &AcceptedMemoryReviewReceiptAdmissionBlockerStorage) -> String {
    format!("{value:?}")
}
