use super::*;
use crate::provider_no_effects::ConvergenceSnapNoAuthority;

#[test]
fn convergence_local_snap_spawn_receipt_accepts_ready_handoffs() {
    let set = convergence_local_snap_spawn_receipt(input(
        vec![handoff(
            "accepted",
            ConvergenceLocalSnapSpawnHandoffStatus::Ready,
        )],
        Vec::new(),
        false,
        false,
    ));

    assert_eq!(set.records.len(), 1);
    assert_eq!(
        set.records[0].status,
        ConvergenceLocalSnapSpawnReceiptStatus::Accepted
    );
    assert_eq!(set.accepted_receipt_ids.len(), 1);
    assert!(set.blocked_receipt_ids.is_empty());
}

#[test]
fn convergence_local_snap_spawn_receipt_blocks_non_ready_handoffs() {
    let set = convergence_local_snap_spawn_receipt(input(
        vec![handoff(
            "blocked",
            ConvergenceLocalSnapSpawnHandoffStatus::Blocked,
        )],
        Vec::new(),
        false,
        false,
    ));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceLocalSnapSpawnReceiptStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapSpawnReceiptBlocker::HandoffNotReady));
    assert_eq!(set.blocked_receipt_ids.len(), 1);
}

#[test]
fn convergence_local_snap_spawn_receipt_records_duplicate_noops() {
    let first = convergence_local_snap_spawn_receipt(input(
        vec![handoff(
            "duplicate",
            ConvergenceLocalSnapSpawnHandoffStatus::Ready,
        )],
        Vec::new(),
        false,
        false,
    ));
    let duplicate = convergence_local_snap_spawn_receipt(input(
        vec![handoff(
            "duplicate",
            ConvergenceLocalSnapSpawnHandoffStatus::Ready,
        )],
        vec![first.records[0].receipt_id.clone()],
        false,
        false,
    ));

    assert_eq!(
        duplicate.records[0].status,
        ConvergenceLocalSnapSpawnReceiptStatus::DuplicateNoop
    );
    assert!(duplicate.records[0]
        .blockers
        .contains(&ConvergenceLocalSnapSpawnReceiptBlocker::DuplicateReceipt));
    assert_eq!(duplicate.duplicate_receipt_ids.len(), 1);
}

#[test]
fn convergence_local_snap_spawn_receipt_keeps_duplicate_and_unsupported_handoffs_not_accepted() {
    let set = convergence_local_snap_spawn_receipt(input(
        vec![
            handoff(
                "duplicate-handoff",
                ConvergenceLocalSnapSpawnHandoffStatus::DuplicateNoop,
            ),
            handoff(
                "unsupported",
                ConvergenceLocalSnapSpawnHandoffStatus::Unsupported,
            ),
        ],
        Vec::new(),
        false,
        false,
    ));

    assert_eq!(set.accepted_receipt_ids.len(), 0);
    assert_eq!(set.duplicate_receipt_ids.len(), 1);
    assert_eq!(set.unsupported_receipt_ids.len(), 1);
}

#[test]
fn convergence_local_snap_spawn_receipt_blocks_effect_and_raw_output_requests() {
    let set = convergence_local_snap_spawn_receipt(input(
        vec![handoff(
            "effects",
            ConvergenceLocalSnapSpawnHandoffStatus::Ready,
        )],
        Vec::new(),
        true,
        true,
    ));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceLocalSnapSpawnReceiptStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapSpawnReceiptBlocker::RunnerEffectRequested));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapSpawnReceiptBlocker::RawOutputPresent));
    assert!(!set.process_runner_invocation_permitted);
    assert!(!set.command_spawn_permitted);
    assert!(!set.local_snap_creation_permitted);
    assert!(!set.object_upload_permitted);
    assert!(!set.publication_permitted);
    assert!(!set.lane_sync_permitted);
    assert!(!set.provider_write_permitted);
    assert!(!set.task_mutation_permitted);
    assert!(!set.raw_output_retained);
    assert!(!record.process_runner_invocation_permitted);
    assert!(!record.command_spawn_permitted);
    assert!(!record.local_snap_creation_permitted);
    assert!(!record.provider_write_permitted);
    assert!(!record.task_mutation_permitted);
    assert!(!record.raw_output_retained);
}

#[test]
fn convergence_local_snap_spawn_receipt_preserves_refs() {
    let set = convergence_local_snap_spawn_receipt(input(
        vec![handoff(
            "refs",
            ConvergenceLocalSnapSpawnHandoffStatus::Ready,
        )],
        Vec::new(),
        false,
        false,
    ));
    let record = &set.records[0];

    assert_eq!(record.handoff_id, "handoff:refs");
    assert_eq!(record.spawn_request_id, "spawn:refs");
    assert_eq!(record.preflight_record_id, "preflight:refs");
    assert_eq!(record.replay_record_id, "replay:refs");
    assert_eq!(record.adapter_record_id, "adapter:refs");
    assert_eq!(record.persisted_evidence_id, "persisted-evidence:refs");
    assert_eq!(record.evidence_id, "evidence:refs");
    assert_eq!(record.proof_id, "proof:refs");
    assert_eq!(record.persisted_request_id, "persisted:refs");
    assert_eq!(record.stopped_request_id, "stopped:refs");
    assert_eq!(record.idempotency_key, "idempotency:refs");
    assert_eq!(record.descriptor_id, "descriptor:refs");
    assert_eq!(record.admission_id, "admission:refs");
    assert_eq!(record.source_replay_record_id, "source-replay:refs");
    assert_eq!(record.task_ids, vec!["task:refs"]);
    assert_eq!(record.repo_ids, vec!["repo:refs"]);
    assert_eq!(record.source_authority_ref, "source-authority:refs");
    assert_eq!(record.execution_authority_ref, "execution-authority:refs");
}

fn input(
    records: Vec<ConvergenceLocalSnapSpawnHandoffRecord>,
    existing_receipt_ids: Vec<String>,
    raw_output_present: bool,
    runner_effect_requested: bool,
) -> ConvergenceLocalSnapSpawnReceiptInput {
    ConvergenceLocalSnapSpawnReceiptInput {
        handoff: ConvergenceLocalSnapSpawnHandoffSet {
            handoff_set_id: "handoff".to_owned(),
            records,
            ready_handoff_ids: Vec::new(),
            blocked_handoff_ids: Vec::new(),
            duplicate_handoff_ids: Vec::new(),
            unsupported_handoff_ids: Vec::new(),
            process_runner_invocation_permitted: false,
            no_effects: ConvergenceSnapNoAuthority::none(),
        },
        existing_receipt_ids,
        raw_output_present,
        runner_effect_requested,
    }
}

fn handoff(
    suffix: &str,
    status: ConvergenceLocalSnapSpawnHandoffStatus,
) -> ConvergenceLocalSnapSpawnHandoffRecord {
    ConvergenceLocalSnapSpawnHandoffRecord {
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
        blockers: Vec::new(),
        duplicate_handoff_detected: false,
        process_runner_invocation_permitted: false,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}
