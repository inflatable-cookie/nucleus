use super::*;

use crate::ConvergenceLocalSnapStoppedRequestStatus;

#[test]
fn convergence_local_snap_runner_proof_records_ready_persisted_requests() {
    let set = convergence_local_snap_runner_proof(input(vec![record(
        "ready",
        ConvergenceLocalSnapRequestPersistenceStatus::Persisted,
        false,
    )]));

    assert_eq!(set.proofs.len(), 1);
    assert_eq!(
        set.proofs[0].status,
        ConvergenceLocalSnapRunnerProofStatus::Ready
    );
    assert!(set.skipped_persisted_request_ids.is_empty());
}

#[test]
fn convergence_local_snap_runner_proof_blocks_duplicate_and_blocked_persistence() {
    let set = convergence_local_snap_runner_proof(input(vec![
        record(
            "blocked",
            ConvergenceLocalSnapRequestPersistenceStatus::Blocked,
            false,
        ),
        record(
            "duplicate",
            ConvergenceLocalSnapRequestPersistenceStatus::DuplicateNoop,
            true,
        ),
    ]));

    assert_eq!(set.skipped_persisted_request_ids.len(), 2);
    assert!(set.proofs.iter().any(|proof| {
        proof
            .blockers
            .contains(&ConvergenceLocalSnapRunnerProofBlocker::RequestPersistenceNotReady)
    }));
    assert!(set.proofs.iter().any(|proof| {
        proof
            .blockers
            .contains(&ConvergenceLocalSnapRunnerProofBlocker::DuplicateRequest)
    }));
}

#[test]
fn convergence_local_snap_runner_proof_preserves_request_and_authority_refs() {
    let set = convergence_local_snap_runner_proof(input(vec![record(
        "refs",
        ConvergenceLocalSnapRequestPersistenceStatus::Persisted,
        false,
    )]));
    let proof = &set.proofs[0];

    assert_eq!(proof.persisted_request_id, "persisted:refs");
    assert_eq!(proof.stopped_request_id, "stopped:refs");
    assert_eq!(proof.admission_id, "admission:refs");
    assert_eq!(proof.replay_record_id, "replay:refs");
    assert_eq!(proof.task_ids, vec!["task:refs"]);
    assert_eq!(proof.repo_ids, vec!["repo:refs"]);
    assert_eq!(proof.source_authority_ref, "source-authority:refs");
    assert_eq!(proof.execution_authority_ref, "execution-authority:refs");
}

#[test]
fn convergence_local_snap_runner_proof_executes_no_effects() {
    let set = convergence_local_snap_runner_proof(input(vec![record(
        "effects",
        ConvergenceLocalSnapRequestPersistenceStatus::Persisted,
        false,
    )]));
    let proof = &set.proofs[0];

    assert!(!set.command_spawned);
    assert!(!set.local_snap_creation_executed);
    assert!(!set.object_upload_executed);
    assert!(!set.publication_executed);
    assert!(!set.lane_sync_executed);
    assert!(!set.provider_write_executed);
    assert!(!set.task_mutation_executed);
    assert!(!set.raw_output_retained);
    assert!(!proof.command_spawned);
    assert!(!proof.local_snap_creation_executed);
    assert!(!proof.raw_output_retained);
}

fn input(
    records: Vec<ConvergenceLocalSnapRequestPersistenceRecord>,
) -> ConvergenceLocalSnapRunnerProofInput {
    ConvergenceLocalSnapRunnerProofInput {
        persisted_requests: ConvergenceLocalSnapRequestPersistenceSet {
            persistence_set_id: "persistence".to_owned(),
            records,
            duplicate_idempotency_keys: Vec::new(),
            blocked_request_ids: Vec::new(),
            command_spawn_permitted: false,
            local_snap_creation_permitted: false,
            object_upload_permitted: false,
            publication_permitted: false,
            lane_sync_permitted: false,
            provider_write_permitted: false,
            task_mutation_permitted: false,
            raw_material_retained: false,
        },
    }
}

fn record(
    suffix: &str,
    status: ConvergenceLocalSnapRequestPersistenceStatus,
    duplicate_idempotency_detected: bool,
) -> ConvergenceLocalSnapRequestPersistenceRecord {
    ConvergenceLocalSnapRequestPersistenceRecord {
        persisted_request_id: format!("persisted:{suffix}"),
        stopped_request_id: format!("stopped:{suffix}"),
        idempotency_key: format!("idempotency:{suffix}"),
        descriptor_id: format!("descriptor:{suffix}"),
        admission_id: format!("admission:{suffix}"),
        replay_record_id: format!("replay:{suffix}"),
        adapter_record_id: format!("adapter:{suffix}"),
        persisted_evidence_id: format!("persisted-evidence:{suffix}"),
        evidence_id: format!("evidence:{suffix}"),
        proof_id: format!("proof:{suffix}"),
        source_persisted_request_id: format!("request:persisted:{suffix}"),
        source_request_id: format!("request:{suffix}"),
        task_ids: vec![format!("task:{suffix}")],
        repo_ids: vec![format!("repo:{suffix}")],
        source_authority_ref: format!("source-authority:{suffix}"),
        execution_authority_ref: format!("execution-authority:{suffix}"),
        local_snap_descriptor_ref: Some(format!("local-snap:{suffix}")),
        request_status: ConvergenceLocalSnapStoppedRequestStatus::Stopped,
        status,
        blockers: Vec::new(),
        duplicate_idempotency_detected,
        command_spawn_permitted: false,
        local_snap_creation_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}
