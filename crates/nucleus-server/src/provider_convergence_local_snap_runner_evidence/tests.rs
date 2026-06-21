use super::*;

#[test]
fn convergence_local_snap_runner_evidence_reviews_ready_proofs() {
    let set = convergence_local_snap_runner_evidence(input(
        vec![proof(
            "ready",
            ConvergenceLocalSnapRunnerProofStatus::Ready,
            true,
        )],
        2,
    ));

    assert_eq!(set.evidence.len(), 1);
    assert_eq!(
        set.evidence[0].status,
        ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable
    );
    assert!(set.skipped_proof_ids.is_empty());
    assert_eq!(
        set.evidence[0].source_authority_ref,
        "source-authority:ready"
    );
    assert_eq!(
        set.evidence[0].execution_authority_ref,
        "execution-authority:ready"
    );
}

#[test]
fn convergence_local_snap_runner_evidence_blocks_unready_proofs() {
    let set = convergence_local_snap_runner_evidence(input(
        vec![proof(
            "blocked",
            ConvergenceLocalSnapRunnerProofStatus::Blocked,
            true,
        )],
        2,
    ));

    assert_eq!(
        set.evidence[0].status,
        ConvergenceLocalSnapRunnerEvidenceStatus::Blocked
    );
    assert!(set.evidence[0]
        .blockers
        .contains(&ConvergenceLocalSnapRunnerEvidenceBlocker::ProofNotReady));
}

#[test]
fn convergence_local_snap_runner_evidence_blocks_missing_refs() {
    let set = convergence_local_snap_runner_evidence(input(
        vec![proof(
            "missing",
            ConvergenceLocalSnapRunnerProofStatus::Ready,
            false,
        )],
        0,
    ));
    let evidence = &set.evidence[0];

    assert!(evidence
        .blockers
        .contains(&ConvergenceLocalSnapRunnerEvidenceBlocker::NoRefsInspected));
    assert!(evidence
        .blockers
        .contains(&ConvergenceLocalSnapRunnerEvidenceBlocker::MissingLocalSnapDescriptor));
}

#[test]
fn convergence_local_snap_runner_evidence_executes_no_effects() {
    let set = convergence_local_snap_runner_evidence(input(
        vec![proof(
            "effects",
            ConvergenceLocalSnapRunnerProofStatus::Ready,
            true,
        )],
        1,
    ));
    let evidence = &set.evidence[0];

    assert!(!set.command_spawned);
    assert!(!set.local_snap_creation_executed);
    assert!(!set.object_upload_executed);
    assert!(!set.publication_executed);
    assert!(!set.lane_sync_executed);
    assert!(!set.provider_write_executed);
    assert!(!set.task_mutation_executed);
    assert!(!set.raw_output_retained);
    assert!(!evidence.command_spawned);
    assert!(!evidence.local_snap_creation_executed);
    assert!(!evidence.raw_output_retained);
}

fn input(
    proofs: Vec<ConvergenceLocalSnapRunnerProofRecord>,
    inspected_ref_count: usize,
) -> ConvergenceLocalSnapRunnerEvidenceInput {
    ConvergenceLocalSnapRunnerEvidenceInput {
        proofs: ConvergenceLocalSnapRunnerProofSet {
            proof_set_id: "proof".to_owned(),
            proofs,
            skipped_persisted_request_ids: Vec::new(),
            command_spawned: false,
            local_snap_creation_executed: false,
            object_upload_executed: false,
            publication_executed: false,
            lane_sync_executed: false,
            provider_write_executed: false,
            task_mutation_executed: false,
            raw_output_retained: false,
        },
        inspected_ref_count,
    }
}

fn proof(
    suffix: &str,
    status: ConvergenceLocalSnapRunnerProofStatus,
    local_snap_descriptor_present: bool,
) -> ConvergenceLocalSnapRunnerProofRecord {
    ConvergenceLocalSnapRunnerProofRecord {
        proof_id: format!("proof:{suffix}"),
        persisted_request_id: format!("persisted:{suffix}"),
        stopped_request_id: format!("stopped:{suffix}"),
        idempotency_key: format!("idempotency:{suffix}"),
        descriptor_id: format!("descriptor:{suffix}"),
        admission_id: format!("admission:{suffix}"),
        replay_record_id: format!("replay:{suffix}"),
        adapter_record_id: format!("adapter:{suffix}"),
        persisted_evidence_id: format!("persisted-evidence:{suffix}"),
        evidence_id: format!("evidence:{suffix}"),
        source_proof_id: format!("source-proof:{suffix}"),
        source_persisted_request_id: format!("request:persisted:{suffix}"),
        source_request_id: format!("request:{suffix}"),
        task_ids: vec![format!("task:{suffix}")],
        repo_ids: vec![format!("repo:{suffix}")],
        source_authority_ref: format!("source-authority:{suffix}"),
        execution_authority_ref: format!("execution-authority:{suffix}"),
        local_snap_descriptor_ref: local_snap_descriptor_present
            .then(|| format!("local-snap:{suffix}")),
        status,
        blockers: Vec::new(),
        command_spawned: false,
        local_snap_creation_executed: false,
        object_upload_executed: false,
        publication_executed: false,
        lane_sync_executed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}
