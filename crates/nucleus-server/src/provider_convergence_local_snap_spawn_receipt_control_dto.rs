//! Read-only control DTOs for Convergence local snap spawn receipts.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapSpawnReceiptBlocker, ConvergenceLocalSnapSpawnReceiptRecord,
    ConvergenceLocalSnapSpawnReceiptSet, ConvergenceLocalSnapSpawnReceiptStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapSpawnReceiptControlDto {
    pub dto_id: String,
    pub receipt_set_id: String,
    pub accepted_count: usize,
    pub blocked_count: usize,
    pub duplicate_count: usize,
    pub unsupported_count: usize,
    pub failed_count: usize,
    pub cleanup_required_count: usize,
    pub blocker_count: usize,
    pub accepted_receipt_ids: Vec<String>,
    pub blocked_receipt_ids: Vec<String>,
    pub duplicate_receipt_ids: Vec<String>,
    pub unsupported_receipt_ids: Vec<String>,
    pub failed_receipt_ids: Vec<String>,
    pub cleanup_required_receipt_ids: Vec<String>,
    pub records: Vec<ConvergenceLocalSnapSpawnReceiptControlRecordDto>,
    pub process_runner_invocation_permitted: bool,
    pub command_spawn_permitted: bool,
    pub local_snap_creation_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapSpawnReceiptControlRecordDto {
    pub receipt_id: String,
    pub handoff_id: String,
    pub spawn_request_id: String,
    pub preflight_record_id: String,
    pub replay_record_id: String,
    pub adapter_record_id: String,
    pub persisted_evidence_id: String,
    pub evidence_id: String,
    pub proof_id: String,
    pub persisted_request_id: String,
    pub stopped_request_id: String,
    pub idempotency_key: String,
    pub descriptor_id: String,
    pub admission_id: String,
    pub source_replay_record_id: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub source_authority_ref: String,
    pub execution_authority_ref: String,
    pub inspected_ref_count: usize,
    pub status: ConvergenceLocalSnapSpawnReceiptStatus,
    pub blockers: Vec<ConvergenceLocalSnapSpawnReceiptBlocker>,
    pub duplicate_receipt_detected: bool,
    pub process_runner_invocation_permitted: bool,
    pub command_spawn_permitted: bool,
    pub local_snap_creation_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_output_retained: bool,
}

pub fn convergence_local_snap_spawn_receipt_control_dto(
    receipt: ConvergenceLocalSnapSpawnReceiptSet,
) -> ConvergenceLocalSnapSpawnReceiptControlDto {
    let records = receipt
        .records
        .into_iter()
        .map(ConvergenceLocalSnapSpawnReceiptControlRecordDto::from)
        .collect::<Vec<_>>();

    ConvergenceLocalSnapSpawnReceiptControlDto {
        dto_id: "convergence-local-snap-spawn-receipt-control-dto".to_owned(),
        receipt_set_id: receipt.receipt_set_id,
        accepted_count: count_status(&records, ConvergenceLocalSnapSpawnReceiptStatus::Accepted),
        blocked_count: count_status(&records, ConvergenceLocalSnapSpawnReceiptStatus::Blocked),
        duplicate_count: count_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::DuplicateNoop,
        ),
        unsupported_count: count_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::Unsupported,
        ),
        failed_count: count_status(&records, ConvergenceLocalSnapSpawnReceiptStatus::Failed),
        cleanup_required_count: count_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::CleanupRequired,
        ),
        blocker_count: records.iter().map(|record| record.blockers.len()).sum(),
        accepted_receipt_ids: receipt.accepted_receipt_ids,
        blocked_receipt_ids: receipt.blocked_receipt_ids,
        duplicate_receipt_ids: receipt.duplicate_receipt_ids,
        unsupported_receipt_ids: receipt.unsupported_receipt_ids,
        failed_receipt_ids: receipt.failed_receipt_ids,
        cleanup_required_receipt_ids: receipt.cleanup_required_receipt_ids,
        records,
        process_runner_invocation_permitted: false,
        command_spawn_permitted: false,
        local_snap_creation_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}

impl From<ConvergenceLocalSnapSpawnReceiptRecord>
    for ConvergenceLocalSnapSpawnReceiptControlRecordDto
{
    fn from(record: ConvergenceLocalSnapSpawnReceiptRecord) -> Self {
        Self {
            receipt_id: record.receipt_id,
            handoff_id: record.handoff_id,
            spawn_request_id: record.spawn_request_id,
            preflight_record_id: record.preflight_record_id,
            replay_record_id: record.replay_record_id,
            adapter_record_id: record.adapter_record_id,
            persisted_evidence_id: record.persisted_evidence_id,
            evidence_id: record.evidence_id,
            proof_id: record.proof_id,
            persisted_request_id: record.persisted_request_id,
            stopped_request_id: record.stopped_request_id,
            idempotency_key: record.idempotency_key,
            descriptor_id: record.descriptor_id,
            admission_id: record.admission_id,
            source_replay_record_id: record.source_replay_record_id,
            task_ids: record.task_ids,
            repo_ids: record.repo_ids,
            source_authority_ref: record.source_authority_ref,
            execution_authority_ref: record.execution_authority_ref,
            inspected_ref_count: record.inspected_ref_count,
            status: record.status,
            blockers: record.blockers,
            duplicate_receipt_detected: record.duplicate_receipt_detected,
            process_runner_invocation_permitted: false,
            command_spawn_permitted: false,
            local_snap_creation_permitted: false,
            object_upload_permitted: false,
            publication_permitted: false,
            lane_sync_permitted: false,
            provider_write_permitted: false,
            task_mutation_permitted: false,
            raw_output_retained: false,
        }
    }
}

fn count_status(
    records: &[ConvergenceLocalSnapSpawnReceiptControlRecordDto],
    status: ConvergenceLocalSnapSpawnReceiptStatus,
) -> usize {
    records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_spawn_receipt_control_dto/tests.rs"]
mod tests;
