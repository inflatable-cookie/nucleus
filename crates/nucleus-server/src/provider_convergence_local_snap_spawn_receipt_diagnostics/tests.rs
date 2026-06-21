use super::*;

use crate::{ConvergenceLocalSnapSpawnReceiptBlocker, ConvergenceLocalSnapSpawnReceiptRecord};

#[test]
fn convergence_local_snap_spawn_receipt_diagnostics_count_record_states() {
    let diagnostics = convergence_local_snap_spawn_receipt_diagnostics(input(vec![
        record(
            "accepted",
            ConvergenceLocalSnapSpawnReceiptStatus::Accepted,
            Vec::new(),
        ),
        record(
            "blocked",
            ConvergenceLocalSnapSpawnReceiptStatus::Blocked,
            vec![ConvergenceLocalSnapSpawnReceiptBlocker::HandoffNotReady],
        ),
        record(
            "duplicate",
            ConvergenceLocalSnapSpawnReceiptStatus::DuplicateNoop,
            vec![ConvergenceLocalSnapSpawnReceiptBlocker::DuplicateReceipt],
        ),
        record(
            "unsupported",
            ConvergenceLocalSnapSpawnReceiptStatus::Unsupported,
            Vec::new(),
        ),
        record(
            "failed",
            ConvergenceLocalSnapSpawnReceiptStatus::Failed,
            Vec::new(),
        ),
        record(
            "cleanup",
            ConvergenceLocalSnapSpawnReceiptStatus::CleanupRequired,
            Vec::new(),
        ),
    ]));

    assert_eq!(diagnostics.record_count, 6);
    assert_eq!(diagnostics.accepted_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.duplicate_count, 1);
    assert_eq!(diagnostics.unsupported_count, 1);
    assert_eq!(diagnostics.failed_count, 1);
    assert_eq!(diagnostics.cleanup_required_count, 1);
    assert_eq!(diagnostics.blocker_count, 2);
}

#[test]
fn convergence_local_snap_spawn_receipt_diagnostics_are_read_only() {
    let diagnostics = convergence_local_snap_spawn_receipt_diagnostics(input(vec![record(
        "accepted",
        ConvergenceLocalSnapSpawnReceiptStatus::Accepted,
        Vec::new(),
    )]));

    assert!(!diagnostics.process_runner_invocation_permitted);
    assert!(!diagnostics.command_spawn_permitted);
    assert!(!diagnostics.local_snap_creation_permitted);
    assert!(!diagnostics.object_upload_permitted);
    assert!(!diagnostics.publication_permitted);
    assert!(!diagnostics.lane_sync_permitted);
    assert!(!diagnostics.provider_write_permitted);
    assert!(!diagnostics.task_mutation_permitted);
    assert!(!diagnostics.raw_output_retained);
}

fn input(
    records: Vec<ConvergenceLocalSnapSpawnReceiptRecord>,
) -> ConvergenceLocalSnapSpawnReceiptSet {
    ConvergenceLocalSnapSpawnReceiptSet {
        receipt_set_id: "receipt".to_owned(),
        records,
        accepted_receipt_ids: Vec::new(),
        blocked_receipt_ids: Vec::new(),
        duplicate_receipt_ids: Vec::new(),
        unsupported_receipt_ids: Vec::new(),
        failed_receipt_ids: Vec::new(),
        cleanup_required_receipt_ids: Vec::new(),
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

fn record(
    suffix: &str,
    status: ConvergenceLocalSnapSpawnReceiptStatus,
    blockers: Vec<ConvergenceLocalSnapSpawnReceiptBlocker>,
) -> ConvergenceLocalSnapSpawnReceiptRecord {
    ConvergenceLocalSnapSpawnReceiptRecord {
        receipt_id: format!("receipt:{suffix}"),
        handoff_id: format!("handoff:{suffix}"),
        spawn_request_id: format!("spawn:{suffix}"),
        preflight_record_id: format!("preflight:{suffix}"),
        replay_record_id: format!("replay:{suffix}"),
        adapter_record_id: format!("adapter:{suffix}"),
        persisted_evidence_id: format!("persisted-evidence:{suffix}"),
        evidence_id: format!("evidence:{suffix}"),
        proof_id: format!("proof:{suffix}"),
        persisted_request_id: format!("persisted:{suffix}"),
        stopped_request_id: format!("stopped:{suffix}"),
        idempotency_key: format!("idempotency:{suffix}"),
        descriptor_id: format!("descriptor:{suffix}"),
        admission_id: format!("admission:{suffix}"),
        source_replay_record_id: format!("source-replay:{suffix}"),
        task_ids: vec![format!("task:{suffix}")],
        repo_ids: vec![format!("repo:{suffix}")],
        source_authority_ref: format!("source-authority:{suffix}"),
        execution_authority_ref: format!("execution-authority:{suffix}"),
        inspected_ref_count: 1,
        status,
        blockers,
        duplicate_receipt_detected: false,
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
