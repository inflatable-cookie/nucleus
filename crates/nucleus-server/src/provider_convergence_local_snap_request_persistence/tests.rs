use super::*;

#[test]
fn convergence_local_snap_request_persistence_persists_stopped_requests() {
    let set = convergence_local_snap_request_persistence(input(
        vec![request(
            "ready",
            ConvergenceLocalSnapStoppedRequestStatus::Stopped,
        )],
        Vec::new(),
        false,
    ));

    assert_eq!(set.records.len(), 1);
    assert_eq!(
        set.records[0].status,
        ConvergenceLocalSnapRequestPersistenceStatus::Persisted
    );
    assert_eq!(set.records[0].admission_id, "admission:ready");
    assert_eq!(
        set.records[0].source_authority_ref,
        "source-authority:ready"
    );
}

#[test]
fn convergence_local_snap_request_persistence_records_duplicate_noops() {
    let first = convergence_local_snap_request_persistence(input(
        vec![request(
            "duplicate",
            ConvergenceLocalSnapStoppedRequestStatus::Stopped,
        )],
        Vec::new(),
        false,
    ));
    let duplicate = convergence_local_snap_request_persistence(input(
        vec![request(
            "duplicate",
            ConvergenceLocalSnapStoppedRequestStatus::Stopped,
        )],
        vec![first.records[0].idempotency_key.clone()],
        false,
    ));

    assert_eq!(duplicate.duplicate_idempotency_keys.len(), 1);
    assert_eq!(
        duplicate.records[0].status,
        ConvergenceLocalSnapRequestPersistenceStatus::DuplicateNoop
    );
}

#[test]
fn convergence_local_snap_request_persistence_keeps_blocked_requests_visible() {
    let set = convergence_local_snap_request_persistence(input(
        vec![request(
            "blocked",
            ConvergenceLocalSnapStoppedRequestStatus::Blocked,
        )],
        Vec::new(),
        false,
    ));

    assert_eq!(
        set.records[0].status,
        ConvergenceLocalSnapRequestPersistenceStatus::Blocked
    );
    assert!(set.records[0]
        .blockers
        .contains(&ConvergenceLocalSnapRequestPersistenceBlocker::RequestNotStopped));
    assert_eq!(set.blocked_request_ids.len(), 1);
}

#[test]
fn convergence_local_snap_request_persistence_blocks_effect_requests() {
    let set = convergence_local_snap_request_persistence(input(
        vec![request(
            "effects",
            ConvergenceLocalSnapStoppedRequestStatus::Stopped,
        )],
        Vec::new(),
        true,
    ));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceLocalSnapRequestPersistenceStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapRequestPersistenceBlocker::CommandSpawnRequested));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapRequestPersistenceBlocker::ObjectUploadRequested));
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
    requests: Vec<ConvergenceLocalSnapStoppedRequestRecord>,
    existing_idempotency_keys: Vec<String>,
    request_effects: bool,
) -> ConvergenceLocalSnapRequestPersistenceInput {
    ConvergenceLocalSnapRequestPersistenceInput {
        requests: ConvergenceLocalSnapStoppedRequestSet {
            request_set_id: "requests".to_owned(),
            requests,
            skipped_descriptor_ids: Vec::new(),
            executable_argv_built: false,
            command_spawned: false,
            local_snap_creation_executed: false,
            object_upload_permitted: false,
            publication_permitted: false,
            lane_sync_permitted: false,
            provider_write_permitted: false,
            task_mutation_permitted: false,
            raw_output_retained: false,
        },
        existing_idempotency_keys,
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

fn request(
    suffix: &str,
    status: ConvergenceLocalSnapStoppedRequestStatus,
) -> ConvergenceLocalSnapStoppedRequestRecord {
    ConvergenceLocalSnapStoppedRequestRecord {
        stopped_request_id: format!("stopped-request:{suffix}"),
        idempotency_key: format!("idempotency:{suffix}"),
        descriptor_id: format!("descriptor:{suffix}"),
        admission_id: format!("admission:{suffix}"),
        replay_record_id: format!("replay:{suffix}"),
        adapter_record_id: format!("adapter:{suffix}"),
        persisted_evidence_id: format!("persisted-evidence:{suffix}"),
        evidence_id: format!("evidence:{suffix}"),
        proof_id: format!("proof:{suffix}"),
        persisted_request_id: format!("request:persisted:{suffix}"),
        source_request_id: format!("request:{suffix}"),
        task_ids: vec![format!("task:{suffix}")],
        repo_ids: vec![format!("repo:{suffix}")],
        source_authority_ref: format!("source-authority:{suffix}"),
        execution_authority_ref: format!("execution-authority:{suffix}"),
        local_snap_descriptor_ref: Some(format!("local-snap:{suffix}")),
        status,
        blockers: Vec::new(),
        executable_argv_built: false,
        command_spawned: false,
        local_snap_creation_executed: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}
