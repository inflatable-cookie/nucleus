use crate::provider_no_effects::{ConvergenceSnapNoAuthority};
use super::*;

use crate::{
    ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker,
    ConvergenceLocalSnapStoppedRunnerCommandAdapterKind,
    ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord,
    ConvergenceLocalSnapStoppedRunnerCommandShape,
};

#[test]
fn convergence_local_snap_stopped_runner_command_diagnostics_count_record_states() {
    let diagnostics = convergence_local_snap_stopped_runner_command_diagnostics(input(vec![
        record(
            "runnable",
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Runnable,
            Vec::new(),
        ),
        record(
            "blocked",
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Blocked,
            vec![
                ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker::MissingLocalSnapDescriptor,
            ],
        ),
        record(
            "duplicate",
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::DuplicateNoop,
            vec![ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker::DuplicateEvidence],
        ),
        record(
            "unsupported",
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Unsupported,
            Vec::new(),
        ),
    ]));

    assert_eq!(diagnostics.record_count, 4);
    assert_eq!(diagnostics.runnable_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.duplicate_count, 1);
    assert_eq!(diagnostics.unsupported_count, 1);
    assert_eq!(diagnostics.blocker_count, 2);
}

#[test]
fn convergence_local_snap_stopped_runner_command_diagnostics_are_read_only() {
    let diagnostics =
        convergence_local_snap_stopped_runner_command_diagnostics(input(vec![record(
            "runnable",
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Runnable,
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
    records: Vec<ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord>,
) -> ConvergenceLocalSnapStoppedRunnerCommandAdapterSet {
    ConvergenceLocalSnapStoppedRunnerCommandAdapterSet {
        adapter_set_id: "adapter".to_owned(),
        records,
        skipped_persisted_evidence_ids: Vec::new(),
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn record(
    suffix: &str,
    status: ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus,
    blockers: Vec<ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker>,
) -> ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord {
    ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord {
        adapter_record_id: format!("adapter:{suffix}"),
        persisted_evidence_id: format!("persisted-evidence:{suffix}"),
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
        adapter_kind: ConvergenceLocalSnapStoppedRunnerCommandAdapterKind::StoppedProof,
        command_shape: ConvergenceLocalSnapStoppedRunnerCommandShape::ConvergeSnap,
        status,
        blockers,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}
