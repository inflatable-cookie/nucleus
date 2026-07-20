use super::*;
use crate::provider_no_effects::ConvergenceSnapNoAuthority;

use crate::{
    ConvergenceLocalSnapExecutionPreflightBlocker, ConvergenceLocalSnapExecutionPreflightRecord,
};

#[test]
fn convergence_local_snap_execution_preflight_diagnostics_count_record_states() {
    let diagnostics = convergence_local_snap_execution_preflight_diagnostics(input(vec![
        record(
            "ready",
            ConvergenceLocalSnapExecutionPreflightStatus::Ready,
            Vec::new(),
        ),
        record(
            "blocked",
            ConvergenceLocalSnapExecutionPreflightStatus::Blocked,
            vec![ConvergenceLocalSnapExecutionPreflightBlocker::ExecutableNotReady],
        ),
        record(
            "duplicate",
            ConvergenceLocalSnapExecutionPreflightStatus::DuplicateNoop,
            vec![ConvergenceLocalSnapExecutionPreflightBlocker::DuplicatePreflightRecord],
        ),
        record(
            "unsupported",
            ConvergenceLocalSnapExecutionPreflightStatus::Unsupported,
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
fn convergence_local_snap_execution_preflight_diagnostics_are_read_only() {
    let diagnostics = convergence_local_snap_execution_preflight_diagnostics(input(vec![record(
        "ready",
        ConvergenceLocalSnapExecutionPreflightStatus::Ready,
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
    records: Vec<ConvergenceLocalSnapExecutionPreflightRecord>,
) -> ConvergenceLocalSnapExecutionPreflightSet {
    ConvergenceLocalSnapExecutionPreflightSet {
        preflight_set_id: "preflight".to_owned(),
        ready_preflight_record_ids: Vec::new(),
        blocked_preflight_record_ids: Vec::new(),
        duplicate_preflight_record_ids: Vec::new(),
        unsupported_preflight_record_ids: Vec::new(),
        records,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn record(
    suffix: &str,
    status: ConvergenceLocalSnapExecutionPreflightStatus,
    blockers: Vec<ConvergenceLocalSnapExecutionPreflightBlocker>,
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
        blockers,
        duplicate_preflight_detected: false,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}
