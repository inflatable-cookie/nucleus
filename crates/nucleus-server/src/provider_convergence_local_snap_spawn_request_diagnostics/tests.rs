use crate::provider_no_effects::{ConvergenceSnapNoAuthority};
use super::*;

use crate::{ConvergenceLocalSnapSpawnRequestBlocker, ConvergenceLocalSnapSpawnRequestRecord};

#[test]
fn convergence_local_snap_spawn_request_diagnostics_count_record_states() {
    let diagnostics = convergence_local_snap_spawn_request_diagnostics(input(vec![
        record(
            "ready",
            ConvergenceLocalSnapSpawnRequestStatus::Ready,
            Vec::new(),
        ),
        record(
            "blocked",
            ConvergenceLocalSnapSpawnRequestStatus::Blocked,
            vec![ConvergenceLocalSnapSpawnRequestBlocker::PreflightNotReady],
        ),
        record(
            "duplicate",
            ConvergenceLocalSnapSpawnRequestStatus::DuplicateNoop,
            vec![ConvergenceLocalSnapSpawnRequestBlocker::DuplicateSpawnRequest],
        ),
        record(
            "unsupported",
            ConvergenceLocalSnapSpawnRequestStatus::Unsupported,
            Vec::new(),
        ),
    ]));

    assert_eq!(diagnostics.record_count, 4);
    assert_eq!(diagnostics.ready_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.duplicate_count, 1);
    assert_eq!(diagnostics.unsupported_count, 1);
    assert_eq!(diagnostics.blocker_count, 2);
}

#[test]
fn convergence_local_snap_spawn_request_diagnostics_are_read_only() {
    let diagnostics = convergence_local_snap_spawn_request_diagnostics(input(vec![record(
        "ready",
        ConvergenceLocalSnapSpawnRequestStatus::Ready,
        Vec::new(),
    )]));

    assert!(!diagnostics.no_effects.command_spawn_permitted);
    assert!(!diagnostics.no_effects.local_snap_creation_permitted);
    assert!(!diagnostics.no_effects.object_upload_permitted);
    assert!(!diagnostics.no_effects.publication_permitted);
    assert!(!diagnostics.no_effects.lane_sync_permitted);
    assert!(!diagnostics.no_effects.provider_write_permitted);
    assert!(!diagnostics.no_effects.task_mutation_permitted);
    assert!(!diagnostics.no_effects.raw_material_retained);
}

fn input(
    records: Vec<ConvergenceLocalSnapSpawnRequestRecord>,
) -> ConvergenceLocalSnapSpawnRequestSet {
    ConvergenceLocalSnapSpawnRequestSet {
        request_set_id: "request".to_owned(),
        records,
        ready_spawn_request_ids: Vec::new(),
        blocked_spawn_request_ids: Vec::new(),
        duplicate_spawn_request_ids: Vec::new(),
        unsupported_spawn_request_ids: Vec::new(),
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn record(
    suffix: &str,
    status: ConvergenceLocalSnapSpawnRequestStatus,
    blockers: Vec<ConvergenceLocalSnapSpawnRequestBlocker>,
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
        blockers,
        duplicate_spawn_request_detected: false,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}
