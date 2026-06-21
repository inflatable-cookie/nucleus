//! Sanitized stopped spawn receipts for Convergence local snap handoffs.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergenceLocalSnapSpawnHandoffRecord, ConvergenceLocalSnapSpawnHandoffSet,
    ConvergenceLocalSnapSpawnHandoffStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergenceLocalSnapSpawnReceiptInput {
    pub handoff: ConvergenceLocalSnapSpawnHandoffSet,
    pub existing_receipt_ids: Vec<String>,
    pub raw_output_present: bool,
    pub runner_effect_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapSpawnReceiptSet {
    pub receipt_set_id: String,
    pub records: Vec<ConvergenceLocalSnapSpawnReceiptRecord>,
    pub accepted_receipt_ids: Vec<String>,
    pub blocked_receipt_ids: Vec<String>,
    pub duplicate_receipt_ids: Vec<String>,
    pub unsupported_receipt_ids: Vec<String>,
    pub failed_receipt_ids: Vec<String>,
    pub cleanup_required_receipt_ids: Vec<String>,
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
pub struct ConvergenceLocalSnapSpawnReceiptRecord {
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapSpawnReceiptStatus {
    Accepted,
    Blocked,
    DuplicateNoop,
    Unsupported,
    Failed,
    CleanupRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLocalSnapSpawnReceiptBlocker {
    HandoffNotReady,
    DuplicateHandoff,
    DuplicateReceipt,
    RunnerEffectRequested,
    RawOutputPresent,
}

pub fn convergence_local_snap_spawn_receipt(
    input: ConvergenceLocalSnapSpawnReceiptInput,
) -> ConvergenceLocalSnapSpawnReceiptSet {
    let existing_receipt_ids = input.existing_receipt_ids;
    let mut records = input
        .handoff
        .records
        .into_iter()
        .map(|record| {
            receipt_record(
                record,
                &existing_receipt_ids,
                input.raw_output_present,
                input.runner_effect_requested,
            )
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.receipt_id.cmp(&right.receipt_id));

    ConvergenceLocalSnapSpawnReceiptSet {
        receipt_set_id: "convergence-local-snap-spawn-receipt".to_owned(),
        accepted_receipt_ids: ids_by_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::Accepted,
        ),
        blocked_receipt_ids: ids_by_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::Blocked,
        ),
        duplicate_receipt_ids: ids_by_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::DuplicateNoop,
        ),
        unsupported_receipt_ids: ids_by_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::Unsupported,
        ),
        failed_receipt_ids: ids_by_status(&records, ConvergenceLocalSnapSpawnReceiptStatus::Failed),
        cleanup_required_receipt_ids: ids_by_status(
            &records,
            ConvergenceLocalSnapSpawnReceiptStatus::CleanupRequired,
        ),
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

fn receipt_record(
    handoff: ConvergenceLocalSnapSpawnHandoffRecord,
    existing_receipt_ids: &[String],
    raw_output_present: bool,
    runner_effect_requested: bool,
) -> ConvergenceLocalSnapSpawnReceiptRecord {
    let receipt_id = format!(
        "convergence-local-snap-spawn-receipt:{}",
        handoff.handoff_id
    );
    let duplicate_receipt_detected = existing_receipt_ids.contains(&receipt_id);
    let blockers = blockers(
        &handoff,
        duplicate_receipt_detected,
        raw_output_present,
        runner_effect_requested,
    );
    let status = status(&handoff, duplicate_receipt_detected, &blockers);

    ConvergenceLocalSnapSpawnReceiptRecord {
        receipt_id,
        handoff_id: handoff.handoff_id,
        spawn_request_id: handoff.spawn_request_id,
        preflight_record_id: handoff.preflight_record_id,
        replay_record_id: handoff.replay_record_id,
        adapter_record_id: handoff.adapter_record_id,
        persisted_evidence_id: handoff.persisted_evidence_id,
        evidence_id: handoff.evidence_id,
        proof_id: handoff.proof_id,
        persisted_request_id: handoff.persisted_request_id,
        stopped_request_id: handoff.stopped_request_id,
        idempotency_key: handoff.idempotency_key,
        descriptor_id: handoff.descriptor_id,
        admission_id: handoff.admission_id,
        source_replay_record_id: handoff.source_replay_record_id,
        task_ids: handoff.task_ids,
        repo_ids: handoff.repo_ids,
        source_authority_ref: handoff.source_authority_ref,
        execution_authority_ref: handoff.execution_authority_ref,
        inspected_ref_count: handoff.inspected_ref_count,
        status,
        blockers,
        duplicate_receipt_detected,
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

fn status(
    handoff: &ConvergenceLocalSnapSpawnHandoffRecord,
    duplicate_receipt_detected: bool,
    blockers: &[ConvergenceLocalSnapSpawnReceiptBlocker],
) -> ConvergenceLocalSnapSpawnReceiptStatus {
    if duplicate_receipt_detected
        || handoff.status == ConvergenceLocalSnapSpawnHandoffStatus::DuplicateNoop
    {
        ConvergenceLocalSnapSpawnReceiptStatus::DuplicateNoop
    } else if handoff.status == ConvergenceLocalSnapSpawnHandoffStatus::Unsupported {
        ConvergenceLocalSnapSpawnReceiptStatus::Unsupported
    } else if !blockers.is_empty() {
        ConvergenceLocalSnapSpawnReceiptStatus::Blocked
    } else {
        ConvergenceLocalSnapSpawnReceiptStatus::Accepted
    }
}

fn blockers(
    handoff: &ConvergenceLocalSnapSpawnHandoffRecord,
    duplicate_receipt_detected: bool,
    raw_output_present: bool,
    runner_effect_requested: bool,
) -> Vec<ConvergenceLocalSnapSpawnReceiptBlocker> {
    let mut blockers = Vec::new();
    if duplicate_receipt_detected {
        blockers.push(ConvergenceLocalSnapSpawnReceiptBlocker::DuplicateReceipt);
    }
    if handoff.status == ConvergenceLocalSnapSpawnHandoffStatus::DuplicateNoop {
        blockers.push(ConvergenceLocalSnapSpawnReceiptBlocker::DuplicateHandoff);
    }
    if handoff.status != ConvergenceLocalSnapSpawnHandoffStatus::Ready
        && handoff.status != ConvergenceLocalSnapSpawnHandoffStatus::Unsupported
        && handoff.status != ConvergenceLocalSnapSpawnHandoffStatus::DuplicateNoop
    {
        blockers.push(ConvergenceLocalSnapSpawnReceiptBlocker::HandoffNotReady);
    }
    if runner_effect_requested {
        blockers.push(ConvergenceLocalSnapSpawnReceiptBlocker::RunnerEffectRequested);
    }
    if raw_output_present {
        blockers.push(ConvergenceLocalSnapSpawnReceiptBlocker::RawOutputPresent);
    }
    blockers
}

fn ids_by_status(
    records: &[ConvergenceLocalSnapSpawnReceiptRecord],
    status: ConvergenceLocalSnapSpawnReceiptStatus,
) -> Vec<String> {
    records
        .iter()
        .filter(|record| record.status == status)
        .map(|record| record.receipt_id.clone())
        .collect()
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_spawn_receipt/tests.rs"]
mod tests;
