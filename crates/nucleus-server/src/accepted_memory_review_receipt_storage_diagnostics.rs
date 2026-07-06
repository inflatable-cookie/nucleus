//! Read-only diagnostics over persisted accepted-memory review receipts.

use nucleus_memory::{
    AcceptedMemoryReviewReceiptAdmissionStatusStorage, AcceptedMemoryReviewReceiptDecisionStorage,
    AcceptedMemoryReviewReceiptStatusStorage, AcceptedMemoryReviewReceiptStorageRecord,
};
use nucleus_projects::ProjectId;

/// State-backed diagnostics for durable accepted-memory review receipts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryReviewReceiptStorageDiagnostics {
    pub diagnostics_id: String,
    pub project_id: ProjectId,
    pub receipts: Vec<AcceptedMemoryReviewReceiptStorageRecord>,
    pub counts: AcceptedMemoryReviewReceiptStorageDiagnosticCounts,
    pub review_receipts_persisted: bool,
    pub active_memory_apply_performed: bool,
    pub projection_write_performed: bool,
    pub scm_effect_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub automatic_extraction_performed: bool,
    pub task_mutation_performed: bool,
    pub agent_scheduling_performed: bool,
    pub ui_effect_performed: bool,
}

/// Persisted review receipt diagnostics counts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryReviewReceiptStorageDiagnosticCounts {
    pub records: usize,
    pub approved: usize,
    pub deferred: usize,
    pub rejected: usize,
    pub blocked: usize,
    pub admitted: usize,
    pub duplicate_noops: usize,
    pub admission_blocked: usize,
    pub blockers: usize,
    pub admission_blockers: usize,
    pub provenance_refs: usize,
    pub evidence_refs: usize,
    pub unsupported_records_skipped: usize,
    pub other_project_records_skipped: usize,
    pub decode_failed_records: usize,
}

/// Input bucket from persisted shared-memory state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryReviewReceiptStorageDiagnosticRecord {
    Persisted(AcceptedMemoryReviewReceiptStorageRecord),
    UnsupportedRecordSkipped { record_id: String },
    DecodeFailedSkipped { record_id: String },
}

impl AcceptedMemoryReviewReceiptStorageDiagnostics {
    pub fn from_records(
        project_id: ProjectId,
        records: impl IntoIterator<Item = AcceptedMemoryReviewReceiptStorageDiagnosticRecord>,
    ) -> Self {
        let mut receipts = Vec::new();
        let mut unsupported_records_skipped = 0;
        let mut other_project_records_skipped = 0;
        let mut decode_failed_records = 0;

        for record in records {
            match record {
                AcceptedMemoryReviewReceiptStorageDiagnosticRecord::Persisted(receipt)
                    if receipt.project_id == project_id.0 =>
                {
                    receipts.push(receipt);
                }
                AcceptedMemoryReviewReceiptStorageDiagnosticRecord::Persisted(_) => {
                    other_project_records_skipped += 1;
                }
                AcceptedMemoryReviewReceiptStorageDiagnosticRecord::UnsupportedRecordSkipped {
                    ..
                } => {
                    unsupported_records_skipped += 1;
                }
                AcceptedMemoryReviewReceiptStorageDiagnosticRecord::DecodeFailedSkipped {
                    ..
                } => {
                    decode_failed_records += 1;
                }
            }
        }

        receipts.sort_by(|left, right| left.review_receipt_id.cmp(&right.review_receipt_id));
        let counts = AcceptedMemoryReviewReceiptStorageDiagnosticCounts::from_parts(
            &receipts,
            unsupported_records_skipped,
            other_project_records_skipped,
            decode_failed_records,
        );

        Self {
            diagnostics_id: "accepted-memory-review-receipt-storage-diagnostics".to_owned(),
            project_id,
            review_receipts_persisted: !receipts.is_empty(),
            receipts,
            counts,
            active_memory_apply_performed: false,
            projection_write_performed: false,
            scm_effect_performed: false,
            embedding_available: false,
            provider_sync_available: false,
            automatic_extraction_performed: false,
            task_mutation_performed: false,
            agent_scheduling_performed: false,
            ui_effect_performed: false,
        }
    }
}

impl AcceptedMemoryReviewReceiptStorageDiagnosticCounts {
    fn from_parts(
        receipts: &[AcceptedMemoryReviewReceiptStorageRecord],
        unsupported_records_skipped: usize,
        other_project_records_skipped: usize,
        decode_failed_records: usize,
    ) -> Self {
        let mut counts = Self {
            records: receipts.len(),
            approved: 0,
            deferred: 0,
            rejected: 0,
            blocked: 0,
            admitted: 0,
            duplicate_noops: 0,
            admission_blocked: 0,
            blockers: 0,
            admission_blockers: 0,
            provenance_refs: 0,
            evidence_refs: 0,
            unsupported_records_skipped,
            other_project_records_skipped,
            decode_failed_records,
        };

        for receipt in receipts {
            count_decision_status(&mut counts, receipt);
            count_admission_status(&mut counts, receipt);
            counts.blockers += receipt.blockers.len();
            counts.admission_blockers += receipt.admission_blockers.len();
            counts.provenance_refs += receipt.provenance_refs.len();
            counts.evidence_refs += receipt.evidence_refs.len();
        }

        counts
    }
}

fn count_decision_status(
    counts: &mut AcceptedMemoryReviewReceiptStorageDiagnosticCounts,
    receipt: &AcceptedMemoryReviewReceiptStorageRecord,
) {
    match receipt.decision {
        AcceptedMemoryReviewReceiptDecisionStorage::Approve => counts.approved += 1,
        AcceptedMemoryReviewReceiptDecisionStorage::Defer => counts.deferred += 1,
        AcceptedMemoryReviewReceiptDecisionStorage::Reject => counts.rejected += 1,
    }
    if receipt.status == AcceptedMemoryReviewReceiptStatusStorage::Blocked {
        counts.blocked += 1;
    }
}

fn count_admission_status(
    counts: &mut AcceptedMemoryReviewReceiptStorageDiagnosticCounts,
    receipt: &AcceptedMemoryReviewReceiptStorageRecord,
) {
    match receipt.admission_status {
        AcceptedMemoryReviewReceiptAdmissionStatusStorage::Admitted => counts.admitted += 1,
        AcceptedMemoryReviewReceiptAdmissionStatusStorage::DuplicateNoop => {
            counts.duplicate_noops += 1;
        }
        AcceptedMemoryReviewReceiptAdmissionStatusStorage::Blocked => {
            counts.admission_blocked += 1;
        }
    }
}
