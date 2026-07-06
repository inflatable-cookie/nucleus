//! Read-only diagnostics for stopped accepted-memory active-apply admissions.

use nucleus_memory::AcceptedMemoryReviewReceiptStorageRecord;
use nucleus_projects::ProjectId;

use crate::accepted_memory_active_apply_admission::{
    accepted_memory_active_apply_admissions, AcceptedMemoryActiveApplyAdmissionCounts,
    AcceptedMemoryActiveApplyAdmissionInput, AcceptedMemoryActiveApplyAdmissionRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryActiveApplyDiagnostics {
    pub diagnostics_id: String,
    pub project_id: ProjectId,
    pub records: Vec<AcceptedMemoryActiveApplyAdmissionRecord>,
    pub counts: AcceptedMemoryActiveApplyDiagnosticCounts,
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryActiveApplyDiagnosticCounts {
    pub source_records: usize,
    pub admitted: usize,
    pub duplicate_noops: usize,
    pub blocked: usize,
    pub blockers: usize,
    pub missing_ref_blockers: usize,
    pub review_state_blockers: usize,
    pub stale_ref_blockers: usize,
    pub raw_payload_blockers: usize,
    pub effect_blockers: usize,
    pub unsupported_records_skipped: usize,
    pub other_project_records_skipped: usize,
    pub decode_failed_records: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryActiveApplyDiagnosticRecord {
    PersistedReviewReceipt(AcceptedMemoryReviewReceiptStorageRecord),
    UnsupportedRecordSkipped { record_id: String },
    DecodeFailedSkipped { record_id: String },
}

impl AcceptedMemoryActiveApplyDiagnostics {
    pub fn from_records(
        project_id: ProjectId,
        records: impl IntoIterator<Item = AcceptedMemoryActiveApplyDiagnosticRecord>,
    ) -> Self {
        let mut receipts = Vec::new();
        let mut unsupported_records_skipped = 0;
        let mut other_project_records_skipped = 0;
        let mut decode_failed_records = 0;

        for record in records {
            match record {
                AcceptedMemoryActiveApplyDiagnosticRecord::PersistedReviewReceipt(receipt)
                    if receipt.project_id == project_id.0 =>
                {
                    receipts.push(receipt);
                }
                AcceptedMemoryActiveApplyDiagnosticRecord::PersistedReviewReceipt(_) => {
                    other_project_records_skipped += 1;
                }
                AcceptedMemoryActiveApplyDiagnosticRecord::UnsupportedRecordSkipped { .. } => {
                    unsupported_records_skipped += 1;
                }
                AcceptedMemoryActiveApplyDiagnosticRecord::DecodeFailedSkipped { .. } => {
                    decode_failed_records += 1;
                }
            }
        }

        receipts.sort_by(|left, right| left.review_receipt_id.cmp(&right.review_receipt_id));
        let admission_set = accepted_memory_active_apply_admissions(
            receipts.into_iter().map(active_apply_input_from_receipt),
        );
        let counts = AcceptedMemoryActiveApplyDiagnosticCounts::from_parts(
            &admission_set.counts,
            unsupported_records_skipped,
            other_project_records_skipped,
            decode_failed_records,
        );

        Self {
            diagnostics_id: "accepted-memory-active-apply-diagnostics".to_owned(),
            project_id,
            records: admission_set.records,
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

impl AcceptedMemoryActiveApplyDiagnosticCounts {
    fn from_parts(
        counts: &AcceptedMemoryActiveApplyAdmissionCounts,
        unsupported_records_skipped: usize,
        other_project_records_skipped: usize,
        decode_failed_records: usize,
    ) -> Self {
        Self {
            source_records: counts.inputs,
            admitted: counts.admitted,
            duplicate_noops: counts.duplicate_noops,
            blocked: counts.blocked,
            blockers: counts.blockers,
            missing_ref_blockers: counts.missing_ref_blockers,
            review_state_blockers: counts.review_state_blockers,
            stale_ref_blockers: counts.stale_ref_blockers,
            raw_payload_blockers: counts.raw_payload_blockers,
            effect_blockers: counts.effect_blockers,
            unsupported_records_skipped,
            other_project_records_skipped,
            decode_failed_records,
        }
    }
}

fn active_apply_input_from_receipt(
    receipt: AcceptedMemoryReviewReceiptStorageRecord,
) -> AcceptedMemoryActiveApplyAdmissionInput {
    AcceptedMemoryActiveApplyAdmissionInput {
        request_id: format!(
            "diagnostics:accepted-memory-active-apply:{}",
            receipt.review_receipt_id
        ),
        operator_ref: "operator:diagnostics".to_owned(),
        approval_ref: format!(
            "approval:accepted-memory-active-apply:{}",
            receipt.review_receipt_id
        ),
        expected_apply_admission_ref: receipt.apply_admission_ref.clone(),
        expected_import_admission_ref: receipt.import_admission_ref.clone(),
        expected_conflict_ref: receipt.conflict_ref.clone(),
        expected_candidate_ref: receipt.candidate_ref.clone(),
        expected_memory_id: receipt.memory_id.clone(),
        expected_file_ref: receipt.file_ref.clone(),
        provenance_refs: receipt.provenance_refs.clone(),
        evidence_refs: receipt.evidence_refs.clone(),
        review_receipt: receipt,
        raw_payload_present: false,
        active_memory_mutation_requested: false,
        projection_write_requested: false,
        scm_effect_requested: false,
        embedding_requested: false,
        provider_sync_requested: false,
        automatic_extraction_requested: false,
        task_mutation_requested: false,
        agent_scheduling_requested: false,
        ui_effect_requested: false,
    }
}
