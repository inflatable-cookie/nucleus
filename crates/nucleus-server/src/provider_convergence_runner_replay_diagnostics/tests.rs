use super::*;

use crate::{
    ConvergenceRunnerReplayBlocker, ConvergenceRunnerReplayEffectFamily,
    ConvergenceRunnerReplayProviderRefs, ConvergenceRunnerReplayRecord,
};

#[test]
fn convergence_runner_replay_diagnostics_count_record_states() {
    let diagnostics = convergence_runner_replay_diagnostics(input(vec![
        record(
            "replayed",
            ConvergenceRunnerReplayStatus::Replayed,
            Vec::new(),
        ),
        record(
            "duplicate",
            ConvergenceRunnerReplayStatus::DuplicateNoop,
            vec![ConvergenceRunnerReplayBlocker::DuplicateReplayRecord],
        ),
        record(
            "blocked",
            ConvergenceRunnerReplayStatus::Blocked,
            vec![ConvergenceRunnerReplayBlocker::BackendEffectRequested],
        ),
        record(
            "unsupported",
            ConvergenceRunnerReplayStatus::Unsupported,
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
fn convergence_runner_replay_diagnostics_are_read_only() {
    let diagnostics = convergence_runner_replay_diagnostics(input(vec![record(
        "replayed",
        ConvergenceRunnerReplayStatus::Replayed,
        Vec::new(),
    )]));

    assert!(!diagnostics.backend_effect_permitted);
    assert!(!diagnostics.object_upload_permitted);
    assert!(!diagnostics.publication_permitted);
    assert!(!diagnostics.lane_sync_permitted);
    assert!(!diagnostics.bundle_permitted);
    assert!(!diagnostics.approval_permitted);
    assert!(!diagnostics.promotion_permitted);
    assert!(!diagnostics.release_permitted);
    assert!(!diagnostics.resolution_publication_permitted);
    assert!(!diagnostics.provider_write_permitted);
    assert!(!diagnostics.task_mutation_permitted);
    assert!(!diagnostics.raw_material_retained);
}

fn input(records: Vec<ConvergenceRunnerReplayRecord>) -> ConvergenceRunnerReplayRecordSet {
    ConvergenceRunnerReplayRecordSet {
        replay_set_id: "replay".to_owned(),
        records,
        duplicate_replay_record_ids: Vec::new(),
        blocked_replay_record_ids: Vec::new(),
        unsupported_replay_record_ids: Vec::new(),
        backend_effect_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        bundle_permitted: false,
        approval_permitted: false,
        promotion_permitted: false,
        release_permitted: false,
        resolution_publication_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn record(
    suffix: &str,
    status: ConvergenceRunnerReplayStatus,
    blockers: Vec<ConvergenceRunnerReplayBlocker>,
) -> ConvergenceRunnerReplayRecord {
    ConvergenceRunnerReplayRecord {
        replay_record_id: format!("replay:{suffix}"),
        adapter_record_id: format!("adapter:{suffix}"),
        persisted_evidence_id: format!("persisted-evidence:{suffix}"),
        evidence_id: format!("evidence:{suffix}"),
        proof_id: format!("proof:{suffix}"),
        persisted_request_id: format!("request:persisted:{suffix}"),
        request_id: format!("request:{suffix}"),
        idempotency_key: format!("idempotency:{suffix}"),
        task_ids: vec![format!("task:{suffix}")],
        repo_ids: vec![format!("repo:{suffix}")],
        effect_families: vec![
            ConvergenceRunnerReplayEffectFamily::PublicationCreation,
            ConvergenceRunnerReplayEffectFamily::BundlePromotion,
        ],
        provider_refs: ConvergenceRunnerReplayProviderRefs {
            snap_id: None,
            root_manifest_ref: None,
            scope_id: None,
            gate_id: None,
            lane_id: None,
            publication_id: None,
            bundle_id: None,
            promotion_id: None,
            release_channel: None,
            publisher_user_id: None,
            metadata_only: None,
            resolution_ref: None,
        },
        status,
        blockers,
        duplicate_replay_detected: false,
        backend_effect_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        bundle_permitted: false,
        approval_permitted: false,
        promotion_permitted: false,
        release_permitted: false,
        resolution_publication_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}
