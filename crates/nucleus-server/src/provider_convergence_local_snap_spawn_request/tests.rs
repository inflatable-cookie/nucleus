use crate::provider_no_effects::{ConvergenceSnapNoAuthority};
use super::*;

#[test]
fn convergence_local_snap_spawn_request_records_ready_preflight() {
    let set = convergence_local_snap_spawn_request(input(
        vec![preflight(
            "ready",
            ConvergenceLocalSnapExecutionPreflightStatus::Ready,
        )],
        Vec::new(),
        false,
        false,
    ));

    assert_eq!(set.records.len(), 1);
    assert_eq!(
        set.records[0].status,
        ConvergenceLocalSnapSpawnRequestStatus::Ready
    );
    assert_eq!(set.ready_spawn_request_ids.len(), 1);
    assert!(set.blocked_spawn_request_ids.is_empty());
}

#[test]
fn convergence_local_snap_spawn_request_blocks_non_ready_preflight() {
    let set = convergence_local_snap_spawn_request(input(
        vec![preflight(
            "blocked",
            ConvergenceLocalSnapExecutionPreflightStatus::Blocked,
        )],
        Vec::new(),
        false,
        false,
    ));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceLocalSnapSpawnRequestStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapSpawnRequestBlocker::PreflightNotReady));
    assert_eq!(set.blocked_spawn_request_ids.len(), 1);
}

#[test]
fn convergence_local_snap_spawn_request_records_duplicate_noops() {
    let first = convergence_local_snap_spawn_request(input(
        vec![preflight(
            "duplicate",
            ConvergenceLocalSnapExecutionPreflightStatus::Ready,
        )],
        Vec::new(),
        false,
        false,
    ));
    let duplicate = convergence_local_snap_spawn_request(input(
        vec![preflight(
            "duplicate",
            ConvergenceLocalSnapExecutionPreflightStatus::Ready,
        )],
        vec![first.records[0].spawn_request_id.clone()],
        false,
        false,
    ));

    assert_eq!(
        duplicate.records[0].status,
        ConvergenceLocalSnapSpawnRequestStatus::DuplicateNoop
    );
    assert!(duplicate.records[0]
        .blockers
        .contains(&ConvergenceLocalSnapSpawnRequestBlocker::DuplicateSpawnRequest));
    assert_eq!(duplicate.duplicate_spawn_request_ids.len(), 1);
}

#[test]
fn convergence_local_snap_spawn_request_keeps_duplicate_and_unsupported_preflight_not_ready() {
    let set = convergence_local_snap_spawn_request(input(
        vec![
            preflight(
                "duplicate-preflight",
                ConvergenceLocalSnapExecutionPreflightStatus::DuplicateNoop,
            ),
            preflight(
                "unsupported",
                ConvergenceLocalSnapExecutionPreflightStatus::Unsupported,
            ),
        ],
        Vec::new(),
        false,
        false,
    ));

    assert_eq!(set.ready_spawn_request_ids.len(), 0);
    assert_eq!(set.duplicate_spawn_request_ids.len(), 1);
    assert_eq!(set.unsupported_spawn_request_ids.len(), 1);
}

#[test]
fn convergence_local_snap_spawn_request_blocks_effect_requests_without_effects() {
    let set = convergence_local_snap_spawn_request(input(
        vec![preflight(
            "effects",
            ConvergenceLocalSnapExecutionPreflightStatus::Ready,
        )],
        Vec::new(),
        true,
        true,
    ));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceLocalSnapSpawnRequestStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapSpawnRequestBlocker::CommandEffectRequested));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapSpawnRequestBlocker::RawMaterialPresent));
    assert!(!set.no_effects.command_spawn_permitted);
    assert!(!set.no_effects.local_snap_creation_permitted);
    assert!(!set.no_effects.object_upload_permitted);
    assert!(!set.no_effects.publication_permitted);
    assert!(!set.no_effects.lane_sync_permitted);
    assert!(!set.no_effects.provider_write_permitted);
    assert!(!set.no_effects.task_mutation_permitted);
    assert!(!set.no_effects.raw_material_retained);
    assert!(!record.no_effects.command_spawn_permitted);
    assert!(!record.no_effects.local_snap_creation_permitted);
    assert!(!record.no_effects.provider_write_permitted);
    assert!(!record.no_effects.task_mutation_permitted);
}

#[test]
fn convergence_local_snap_spawn_request_preserves_refs() {
    let set = convergence_local_snap_spawn_request(input(
        vec![preflight(
            "refs",
            ConvergenceLocalSnapExecutionPreflightStatus::Ready,
        )],
        Vec::new(),
        false,
        false,
    ));
    let record = &set.records[0];

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
    records: Vec<ConvergenceLocalSnapExecutionPreflightRecord>,
    existing_spawn_request_ids: Vec<String>,
    raw_material_present: bool,
    command_effect_requested: bool,
) -> ConvergenceLocalSnapSpawnRequestInput {
    ConvergenceLocalSnapSpawnRequestInput {
        preflight: ConvergenceLocalSnapExecutionPreflightSet {
            preflight_set_id: "preflight".to_owned(),
            records,
            ready_preflight_record_ids: Vec::new(),
            blocked_preflight_record_ids: Vec::new(),
            duplicate_preflight_record_ids: Vec::new(),
            unsupported_preflight_record_ids: Vec::new(),
        no_effects: ConvergenceSnapNoAuthority::none(),
        },
        existing_spawn_request_ids,
        raw_material_present,
        command_effect_requested,
    }
}

fn preflight(
    suffix: &str,
    status: ConvergenceLocalSnapExecutionPreflightStatus,
) -> ConvergenceLocalSnapExecutionPreflightRecord {
    ConvergenceLocalSnapExecutionPreflightRecord {
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
        operator_confirmed: true,
        executable_ready: true,
        workspace_ready: true,
        status,
        blockers: Vec::new(),
        duplicate_preflight_detected: false,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}
