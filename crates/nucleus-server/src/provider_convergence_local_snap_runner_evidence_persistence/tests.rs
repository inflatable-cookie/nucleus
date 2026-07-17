use super::*;

#[test]
fn convergence_local_snap_runner_evidence_persistence_persists_reviewable_evidence() {
    let set = convergence_local_snap_runner_evidence_persistence(input(
        vec![evidence(
            "ready",
            ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable,
        )],
        Vec::new(),
        false,
    ));

    assert_eq!(set.records.len(), 1);
    assert_eq!(
        set.records[0].status,
        ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Persisted
    );
    assert_eq!(set.records[0].admission_id, "admission:ready");
    assert_eq!(set.records[0].inspected_ref_count, 1);
    assert_eq!(
        set.records[0].source_authority_ref,
        "source-authority:ready"
    );
    assert_eq!(
        set.records[0].execution_authority_ref,
        "execution-authority:ready"
    );
}

#[test]
fn convergence_local_snap_runner_evidence_persistence_records_duplicate_noops() {
    let first = convergence_local_snap_runner_evidence_persistence(input(
        vec![evidence(
            "duplicate",
            ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable,
        )],
        Vec::new(),
        false,
    ));
    let duplicate = convergence_local_snap_runner_evidence_persistence(input(
        vec![evidence(
            "duplicate",
            ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable,
        )],
        vec![first.records[0].persisted_evidence_id.clone()],
        false,
    ));

    assert_eq!(duplicate.duplicate_evidence_ids.len(), 1);
    assert_eq!(
        duplicate.records[0].status,
        ConvergenceLocalSnapRunnerEvidencePersistenceStatus::DuplicateNoop
    );
}

#[test]
fn convergence_local_snap_runner_evidence_persistence_keeps_blocked_evidence_visible() {
    let set = convergence_local_snap_runner_evidence_persistence(input(
        vec![evidence(
            "blocked",
            ConvergenceLocalSnapRunnerEvidenceStatus::Blocked,
        )],
        Vec::new(),
        false,
    ));

    assert_eq!(
        set.records[0].status,
        ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Blocked
    );
    assert!(set.records[0]
        .blockers
        .contains(&ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::EvidenceNotReviewable));
    assert_eq!(set.blocked_evidence_ids.len(), 1);
}

#[test]
fn convergence_local_snap_runner_evidence_persistence_blocks_effect_requests() {
    let set = convergence_local_snap_runner_evidence_persistence(input(
        vec![evidence(
            "effects",
            ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable,
        )],
        Vec::new(),
        true,
    ));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::CommandSpawnRequested));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::ObjectUploadRequested));
    assert!(!set.no_effects.command_spawn_permitted);
    assert!(!set.no_effects.local_snap_creation_permitted);
    assert!(!set.no_effects.object_upload_permitted);
    assert!(!set.no_effects.publication_permitted);
    assert!(!set.no_effects.lane_sync_permitted);
    assert!(!set.no_effects.provider_write_permitted);
    assert!(!set.no_effects.task_mutation_permitted);
    assert!(!set.no_effects.raw_material_retained);
}

fn input(
    evidence: Vec<ConvergenceLocalSnapRunnerEvidenceRecord>,
    existing_evidence_ids: Vec<String>,
    request_effects: bool,
) -> ConvergenceLocalSnapRunnerEvidencePersistenceInput {
    ConvergenceLocalSnapRunnerEvidencePersistenceInput {
        evidence: ConvergenceLocalSnapRunnerEvidenceSet {
            evidence_set_id: "evidence".to_owned(),
            evidence,
            skipped_proof_ids: Vec::new(),
            command_spawned: false,
            local_snap_creation_executed: false,
            object_upload_executed: false,
            publication_executed: false,
            lane_sync_executed: false,
            provider_write_executed: false,
            task_mutation_executed: false,
            raw_output_retained: false,
        },
        existing_evidence_ids,
        raw_material_present: request_effects,
        command_spawn_requested: request_effects,
        local_snap_creation_requested: request_effects,
        object_upload_requested: request_effects,
        publication_requested: request_effects,
        lane_sync_requested: request_effects,
        provider_write_requested: request_effects,
        task_mutation_requested: request_effects,
    }
}

fn evidence(
    suffix: &str,
    status: ConvergenceLocalSnapRunnerEvidenceStatus,
) -> ConvergenceLocalSnapRunnerEvidenceRecord {
    ConvergenceLocalSnapRunnerEvidenceRecord {
        evidence_id: format!("evidence:{suffix}"),
        proof_id: format!("proof:{suffix}"),
        persisted_request_id: format!("persisted:{suffix}"),
        stopped_request_id: format!("stopped:{suffix}"),
        idempotency_key: format!("idempotency:{suffix}"),
        descriptor_id: format!("descriptor:{suffix}"),
        admission_id: format!("admission:{suffix}"),
        replay_record_id: format!("replay:{suffix}"),
        task_ids: vec![format!("task:{suffix}")],
        repo_ids: vec![format!("repo:{suffix}")],
        source_authority_ref: format!("source-authority:{suffix}"),
        execution_authority_ref: format!("execution-authority:{suffix}"),
        inspected_ref_count: 1,
        local_snap_descriptor_present: true,
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
