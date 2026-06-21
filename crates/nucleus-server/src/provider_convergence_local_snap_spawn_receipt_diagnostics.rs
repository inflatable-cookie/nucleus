//! Read-only diagnostics for stopped Convergence local snap spawn receipts.

use serde::{Deserialize, Serialize};

use crate::{ConvergenceLocalSnapSpawnReceiptSet, ConvergenceLocalSnapSpawnReceiptStatus};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapSpawnReceiptDiagnostics {
    pub diagnostics_id: String,
    pub record_count: usize,
    pub accepted_count: usize,
    pub blocked_count: usize,
    pub duplicate_count: usize,
    pub unsupported_count: usize,
    pub failed_count: usize,
    pub cleanup_required_count: usize,
    pub blocker_count: usize,
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

pub fn convergence_local_snap_spawn_receipt_diagnostics(
    receipt: ConvergenceLocalSnapSpawnReceiptSet,
) -> ConvergenceLocalSnapSpawnReceiptDiagnostics {
    ConvergenceLocalSnapSpawnReceiptDiagnostics {
        diagnostics_id: "convergence-local-snap-spawn-receipt-diagnostics".to_owned(),
        record_count: receipt.records.len(),
        accepted_count: count_status(&receipt, ConvergenceLocalSnapSpawnReceiptStatus::Accepted),
        blocked_count: count_status(&receipt, ConvergenceLocalSnapSpawnReceiptStatus::Blocked),
        duplicate_count: count_status(
            &receipt,
            ConvergenceLocalSnapSpawnReceiptStatus::DuplicateNoop,
        ),
        unsupported_count: count_status(
            &receipt,
            ConvergenceLocalSnapSpawnReceiptStatus::Unsupported,
        ),
        failed_count: count_status(&receipt, ConvergenceLocalSnapSpawnReceiptStatus::Failed),
        cleanup_required_count: count_status(
            &receipt,
            ConvergenceLocalSnapSpawnReceiptStatus::CleanupRequired,
        ),
        blocker_count: receipt
            .records
            .iter()
            .map(|record| record.blockers.len())
            .sum(),
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

fn count_status(
    receipt: &ConvergenceLocalSnapSpawnReceiptSet,
    status: ConvergenceLocalSnapSpawnReceiptStatus,
) -> usize {
    receipt
        .records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_spawn_receipt_diagnostics/tests.rs"]
mod tests;
