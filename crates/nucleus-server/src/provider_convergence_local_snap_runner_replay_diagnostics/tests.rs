use super::*;
use crate::provider_no_effects::ConvergenceSnapNoAuthority;

use crate::{
    ConvergenceLocalSnapRunnerReplayBlocker, ConvergenceLocalSnapRunnerReplayEffectFamily,
    ConvergenceLocalSnapRunnerReplayRecord,
};

#[test]
fn convergence_local_snap_runner_replay_diagnostics_count_record_states() {
    let diagnostics = convergence_local_snap_runner_replay_diagnostics(input(vec![
        record(
            "replayed",
            ConvergenceLocalSnapRunnerReplayStatus::Replayed,
            Vec::new(),
        ),
        record(
            "duplicate",
            ConvergenceLocalSnapRunnerReplayStatus::DuplicateNoop,
            vec![ConvergenceLocalSnapRunnerReplayBlocker::DuplicateReplayRecord],
        ),
        record(
            "blocked",
            ConvergenceLocalSnapRunnerReplayStatus::Blocked,
            vec![ConvergenceLocalSnapRunnerReplayBlocker::CommandEffectRequested],
        ),
        record(
            "unsupported",
            ConvergenceLocalSnapRunnerReplayStatus::Unsupported,
            Vec::new(),
        ),
    ]));

    assert_eq!(diagnostics.record_count, 4);
    assert_eq!(diagnostics.replayed_count, 1);
    assert_eq!(diagnostics.duplicate_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.unsupported_count, 1);
    assert_eq!(diagnostics.blocker_count, 2);
    assert_eq!(diagnostics.effect_family_count, 8);
}

#[test]
fn convergence_local_snap_runner_replay_diagnostics_are_read_only() {
    let diagnostics = convergence_local_snap_runner_replay_diagnostics(input(vec![record(
        "replayed",
        ConvergenceLocalSnapRunnerReplayStatus::Replayed,
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
    records: Vec<ConvergenceLocalSnapRunnerReplayRecord>,
) -> ConvergenceLocalSnapRunnerReplayRecordSet {
    ConvergenceLocalSnapRunnerReplayRecordSet {
        replay_set_id: "replay".to_owned(),
        records,
        duplicate_replay_record_ids: Vec::new(),
        blocked_replay_record_ids: Vec::new(),
        unsupported_replay_record_ids: Vec::new(),
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn record(
    suffix: &str,
    status: ConvergenceLocalSnapRunnerReplayStatus,
    blockers: Vec<ConvergenceLocalSnapRunnerReplayBlocker>,
) -> ConvergenceLocalSnapRunnerReplayRecord {
    ConvergenceLocalSnapRunnerReplayRecord {
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
        effect_families: vec![
            ConvergenceLocalSnapRunnerReplayEffectFamily::CommandSpawn,
            ConvergenceLocalSnapRunnerReplayEffectFamily::LocalSnapCreation,
        ],
        status,
        blockers,
        duplicate_replay_detected: false,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}
