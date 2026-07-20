use super::*;
use crate::provider_no_effects::ConvergenceSnapNoAuthority;

use crate::{
    ConvergenceLocalSnapRequestPersistenceBlocker, ConvergenceLocalSnapRequestPersistenceRecord,
};

#[test]
fn convergence_local_snap_request_control_dto_reports_counts() {
    let dto = convergence_local_snap_request_control_dto(input(vec![
        record(
            "persisted",
            ConvergenceLocalSnapRequestPersistenceStatus::Persisted,
            ConvergenceLocalSnapStoppedRequestStatus::Stopped,
            false,
            Vec::new(),
        ),
        record(
            "duplicate",
            ConvergenceLocalSnapRequestPersistenceStatus::DuplicateNoop,
            ConvergenceLocalSnapStoppedRequestStatus::Stopped,
            true,
            Vec::new(),
        ),
        record(
            "blocked",
            ConvergenceLocalSnapRequestPersistenceStatus::Blocked,
            ConvergenceLocalSnapStoppedRequestStatus::Blocked,
            false,
            vec![ConvergenceLocalSnapRequestPersistenceBlocker::RequestNotStopped],
        ),
    ]));

    assert_eq!(dto.persisted_count, 1);
    assert_eq!(dto.duplicate_count, 1);
    assert_eq!(dto.blocked_count, 1);
    assert_eq!(dto.stopped_request_count, 2);
    assert_eq!(dto.blocker_count, 1);
}

#[test]
fn convergence_local_snap_request_control_dto_carries_no_authority() {
    let dto = convergence_local_snap_request_control_dto(input(vec![record(
        "persisted",
        ConvergenceLocalSnapRequestPersistenceStatus::Persisted,
        ConvergenceLocalSnapStoppedRequestStatus::Stopped,
        false,
        Vec::new(),
    )]));

    assert!(!dto.no_effects.command_spawn_permitted);
    assert!(!dto.no_effects.local_snap_creation_permitted);
    assert!(!dto.no_effects.object_upload_permitted);
    assert!(!dto.no_effects.publication_permitted);
    assert!(!dto.no_effects.lane_sync_permitted);
    assert!(!dto.no_effects.provider_write_permitted);
    assert!(!dto.no_effects.task_mutation_permitted);
    assert!(!dto.no_effects.raw_material_retained);
}

fn input(
    records: Vec<ConvergenceLocalSnapRequestPersistenceRecord>,
) -> ConvergenceLocalSnapRequestPersistenceSet {
    ConvergenceLocalSnapRequestPersistenceSet {
        persistence_set_id: "persistence".to_owned(),
        duplicate_idempotency_keys: records
            .iter()
            .filter(|record| record.duplicate_idempotency_detected)
            .map(|record| record.idempotency_key.clone())
            .collect(),
        blocked_request_ids: records
            .iter()
            .filter(|record| record.status == ConvergenceLocalSnapRequestPersistenceStatus::Blocked)
            .map(|record| record.stopped_request_id.clone())
            .collect(),
        records,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn record(
    suffix: &str,
    status: ConvergenceLocalSnapRequestPersistenceStatus,
    request_status: ConvergenceLocalSnapStoppedRequestStatus,
    duplicate_idempotency_detected: bool,
    blockers: Vec<ConvergenceLocalSnapRequestPersistenceBlocker>,
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
        request_status,
        status,
        blockers,
        duplicate_idempotency_detected,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}
