use super::*;

use crate::{
    ConvergenceStoppedRunnerCommandAdapterBlocker, ConvergenceStoppedRunnerCommandAdapterKind,
    ConvergenceStoppedRunnerCommandAdapterRecord, ConvergenceStoppedRunnerCommandShape,
};

#[test]
fn convergence_stopped_runner_command_diagnostics_count_record_states() {
    let diagnostics = convergence_stopped_runner_command_diagnostics(input(vec![
        record(
            "runnable",
            ConvergenceStoppedRunnerCommandAdapterStatus::Runnable,
            Vec::new(),
        ),
        record(
            "blocked",
            ConvergenceStoppedRunnerCommandAdapterStatus::Blocked,
            vec![ConvergenceStoppedRunnerCommandAdapterBlocker::MissingSnapshotStage],
        ),
        record(
            "duplicate",
            ConvergenceStoppedRunnerCommandAdapterStatus::DuplicateNoop,
            vec![ConvergenceStoppedRunnerCommandAdapterBlocker::DuplicateEvidence],
        ),
        record(
            "unsupported",
            ConvergenceStoppedRunnerCommandAdapterStatus::Unsupported,
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
fn convergence_stopped_runner_command_diagnostics_are_read_only() {
    let diagnostics = convergence_stopped_runner_command_diagnostics(input(vec![record(
        "runnable",
        ConvergenceStoppedRunnerCommandAdapterStatus::Runnable,
        Vec::new(),
    )]));

    assert!(!diagnostics.runner_invocation_permitted);
    assert!(!diagnostics.provider_handoff_permitted);
    assert!(!diagnostics.snapshot_creation_permitted);
    assert!(!diagnostics.publish_permitted);
    assert!(!diagnostics.publication_review_permitted);
    assert!(!diagnostics.provider_write_permitted);
    assert!(!diagnostics.task_mutation_permitted);
    assert!(!diagnostics.raw_material_retained);
}

fn input(
    records: Vec<ConvergenceStoppedRunnerCommandAdapterRecord>,
) -> ConvergenceStoppedRunnerCommandAdapterSet {
    ConvergenceStoppedRunnerCommandAdapterSet {
        adapter_set_id: "adapter".to_owned(),
        records,
        skipped_persisted_evidence_ids: Vec::new(),
        runner_invocation_permitted: false,
        provider_handoff_permitted: false,
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn record(
    suffix: &str,
    status: ConvergenceStoppedRunnerCommandAdapterStatus,
    blockers: Vec<ConvergenceStoppedRunnerCommandAdapterBlocker>,
) -> ConvergenceStoppedRunnerCommandAdapterRecord {
    ConvergenceStoppedRunnerCommandAdapterRecord {
        adapter_record_id: format!("adapter:{suffix}"),
        persisted_evidence_id: format!("persisted-evidence:{suffix}"),
        evidence_id: format!("evidence:{suffix}"),
        proof_id: format!("proof:{suffix}"),
        persisted_request_id: format!("request:persisted:{suffix}"),
        request_id: format!("request:{suffix}"),
        idempotency_key: format!("idempotency:{suffix}"),
        task_ids: vec![format!("task:{suffix}")],
        repo_ids: vec![format!("repo:{suffix}")],
        snapshot_stage_count: 1,
        publish_stage_count: 1,
        publication_review_stage_count: 1,
        inspected_stage_count: 3,
        adapter_kind: ConvergenceStoppedRunnerCommandAdapterKind::StoppedProof,
        command_shape: ConvergenceStoppedRunnerCommandShape::SnapshotPublishReview,
        status,
        blockers,
        runner_invocation_permitted: false,
        provider_handoff_permitted: false,
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}
