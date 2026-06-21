use super::*;

#[test]
fn convergence_local_snap_spawn_handoff_records_ready_requests() {
    let set = convergence_local_snap_spawn_handoff(input(
        vec![request(
            "ready",
            ConvergenceLocalSnapSpawnRequestStatus::Ready,
        )],
        Vec::new(),
        false,
        false,
    ));

    assert_eq!(set.records.len(), 1);
    assert_eq!(
        set.records[0].status,
        ConvergenceLocalSnapSpawnHandoffStatus::Ready
    );
    assert_eq!(set.ready_handoff_ids.len(), 1);
    assert!(set.blocked_handoff_ids.is_empty());
}

#[test]
fn convergence_local_snap_spawn_handoff_blocks_non_ready_requests() {
    let set = convergence_local_snap_spawn_handoff(input(
        vec![request(
            "blocked",
            ConvergenceLocalSnapSpawnRequestStatus::Blocked,
        )],
        Vec::new(),
        false,
        false,
    ));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceLocalSnapSpawnHandoffStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapSpawnHandoffBlocker::SpawnRequestNotReady));
    assert_eq!(set.blocked_handoff_ids.len(), 1);
}

#[test]
fn convergence_local_snap_spawn_handoff_records_duplicate_noops() {
    let first = convergence_local_snap_spawn_handoff(input(
        vec![request(
            "duplicate",
            ConvergenceLocalSnapSpawnRequestStatus::Ready,
        )],
        Vec::new(),
        false,
        false,
    ));
    let duplicate = convergence_local_snap_spawn_handoff(input(
        vec![request(
            "duplicate",
            ConvergenceLocalSnapSpawnRequestStatus::Ready,
        )],
        vec![first.records[0].handoff_id.clone()],
        false,
        false,
    ));

    assert_eq!(
        duplicate.records[0].status,
        ConvergenceLocalSnapSpawnHandoffStatus::DuplicateNoop
    );
    assert!(duplicate.records[0]
        .blockers
        .contains(&ConvergenceLocalSnapSpawnHandoffBlocker::DuplicateHandoff));
    assert_eq!(duplicate.duplicate_handoff_ids.len(), 1);
}

#[test]
fn convergence_local_snap_spawn_handoff_keeps_duplicate_and_unsupported_requests_not_ready() {
    let set = convergence_local_snap_spawn_handoff(input(
        vec![
            request(
                "duplicate-request",
                ConvergenceLocalSnapSpawnRequestStatus::DuplicateNoop,
            ),
            request(
                "unsupported",
                ConvergenceLocalSnapSpawnRequestStatus::Unsupported,
            ),
        ],
        Vec::new(),
        false,
        false,
    ));

    assert_eq!(set.ready_handoff_ids.len(), 0);
    assert_eq!(set.duplicate_handoff_ids.len(), 1);
    assert_eq!(set.unsupported_handoff_ids.len(), 1);
}

#[test]
fn convergence_local_snap_spawn_handoff_blocks_effect_requests_without_effects() {
    let set = convergence_local_snap_spawn_handoff(input(
        vec![request(
            "effects",
            ConvergenceLocalSnapSpawnRequestStatus::Ready,
        )],
        Vec::new(),
        true,
        true,
    ));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceLocalSnapSpawnHandoffStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapSpawnHandoffBlocker::RunnerEffectRequested));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapSpawnHandoffBlocker::RawMaterialPresent));
    assert!(!set.process_runner_invocation_permitted);
    assert!(!set.command_spawn_permitted);
    assert!(!set.local_snap_creation_permitted);
    assert!(!set.object_upload_permitted);
    assert!(!set.publication_permitted);
    assert!(!set.lane_sync_permitted);
    assert!(!set.provider_write_permitted);
    assert!(!set.task_mutation_permitted);
    assert!(!set.raw_material_retained);
    assert!(!record.process_runner_invocation_permitted);
    assert!(!record.command_spawn_permitted);
    assert!(!record.local_snap_creation_permitted);
    assert!(!record.provider_write_permitted);
    assert!(!record.task_mutation_permitted);
}

#[test]
fn convergence_local_snap_spawn_handoff_preserves_refs() {
    let set = convergence_local_snap_spawn_handoff(input(
        vec![request(
            "refs",
            ConvergenceLocalSnapSpawnRequestStatus::Ready,
        )],
        Vec::new(),
        false,
        false,
    ));
    let record = &set.records[0];

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
    records: Vec<ConvergenceLocalSnapSpawnRequestRecord>,
    existing_handoff_ids: Vec<String>,
    raw_material_present: bool,
    runner_effect_requested: bool,
) -> ConvergenceLocalSnapSpawnHandoffInput {
    ConvergenceLocalSnapSpawnHandoffInput {
        request: ConvergenceLocalSnapSpawnRequestSet {
            request_set_id: "request".to_owned(),
            records,
            ready_spawn_request_ids: Vec::new(),
            blocked_spawn_request_ids: Vec::new(),
            duplicate_spawn_request_ids: Vec::new(),
            unsupported_spawn_request_ids: Vec::new(),
            command_spawn_permitted: false,
            local_snap_creation_permitted: false,
            object_upload_permitted: false,
            publication_permitted: false,
            lane_sync_permitted: false,
            provider_write_permitted: false,
            task_mutation_permitted: false,
            raw_material_retained: false,
        },
        existing_handoff_ids,
        raw_material_present,
        runner_effect_requested,
    }
}

fn request(
    suffix: &str,
    status: ConvergenceLocalSnapSpawnRequestStatus,
) -> ConvergenceLocalSnapSpawnRequestRecord {
    ConvergenceLocalSnapSpawnRequestRecord {
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
        duplicate_spawn_request_detected: false,
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
