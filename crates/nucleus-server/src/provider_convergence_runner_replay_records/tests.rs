use super::*;

use crate::{
    ConvergenceStoppedRunnerCommandAdapterKind, ConvergenceStoppedRunnerCommandAdapterRecord,
    ConvergenceStoppedRunnerCommandShape,
};

#[test]
fn convergence_runner_replay_records_persist_runnable_adapter_decisions() {
    let set = convergence_runner_replay_records(input(
        vec![adapter(
            "one",
            ConvergenceStoppedRunnerCommandAdapterStatus::Runnable,
        )],
        Vec::new(),
        false,
        false,
    ));

    assert_eq!(set.records.len(), 1);
    assert_eq!(
        set.records[0].status,
        ConvergenceRunnerReplayStatus::Replayed
    );
    assert_eq!(set.records[0].effect_families.len(), 9);
    assert_eq!(set.records[0].provider_refs.snap_id, None);
}

#[test]
fn convergence_runner_replay_records_duplicate_ids_are_noops() {
    let first = convergence_runner_replay_records(input(
        vec![adapter(
            "duplicate",
            ConvergenceStoppedRunnerCommandAdapterStatus::Runnable,
        )],
        Vec::new(),
        false,
        false,
    ));
    let duplicate = convergence_runner_replay_records(input(
        vec![adapter(
            "duplicate",
            ConvergenceStoppedRunnerCommandAdapterStatus::Runnable,
        )],
        vec![first.records[0].replay_record_id.clone()],
        false,
        false,
    ));

    assert_eq!(
        duplicate.records[0].status,
        ConvergenceRunnerReplayStatus::DuplicateNoop
    );
    assert_eq!(duplicate.duplicate_replay_record_ids.len(), 1);
}

#[test]
fn convergence_runner_replay_records_preserve_adapter_refs() {
    let set = convergence_runner_replay_records(input(
        vec![adapter(
            "refs",
            ConvergenceStoppedRunnerCommandAdapterStatus::Runnable,
        )],
        Vec::new(),
        false,
        false,
    ));
    let record = &set.records[0];

    assert_eq!(record.adapter_record_id, "adapter:refs");
    assert_eq!(record.persisted_evidence_id, "persisted-evidence:refs");
    assert_eq!(record.evidence_id, "evidence:refs");
    assert_eq!(record.proof_id, "proof:refs");
    assert_eq!(record.persisted_request_id, "request:persisted:refs");
    assert_eq!(record.request_id, "request:refs");
    assert_eq!(record.idempotency_key, "idempotency:refs");
    assert_eq!(record.task_ids, vec!["task:refs"]);
    assert_eq!(record.repo_ids, vec!["repo:refs"]);
}

#[test]
fn convergence_runner_replay_records_block_effect_requests_without_effects() {
    let set = convergence_runner_replay_records(input(
        vec![adapter(
            "blocked",
            ConvergenceStoppedRunnerCommandAdapterStatus::Runnable,
        )],
        Vec::new(),
        true,
        true,
    ));
    let record = &set.records[0];

    assert_eq!(record.status, ConvergenceRunnerReplayStatus::Blocked);
    assert!(record
        .blockers
        .contains(&ConvergenceRunnerReplayBlocker::BackendEffectRequested));
    assert!(record
        .blockers
        .contains(&ConvergenceRunnerReplayBlocker::RawMaterialPresent));
    assert!(!set.backend_effect_permitted);
    assert!(!set.object_upload_permitted);
    assert!(!set.publication_permitted);
    assert!(!set.lane_sync_permitted);
    assert!(!set.bundle_permitted);
    assert!(!set.approval_permitted);
    assert!(!set.promotion_permitted);
    assert!(!set.release_permitted);
    assert!(!set.resolution_publication_permitted);
    assert!(!set.provider_write_permitted);
    assert!(!set.task_mutation_permitted);
    assert!(!set.raw_material_retained);
    assert!(!record.backend_effect_permitted);
    assert!(!record.provider_write_permitted);
    assert!(!record.task_mutation_permitted);
}

fn input(
    records: Vec<ConvergenceStoppedRunnerCommandAdapterRecord>,
    existing_replay_record_ids: Vec<String>,
    raw_material_present: bool,
    backend_effect_requested: bool,
) -> ConvergenceRunnerReplayRecordsInput {
    ConvergenceRunnerReplayRecordsInput {
        adapter: ConvergenceStoppedRunnerCommandAdapterSet {
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
        },
        existing_replay_record_ids,
        raw_material_present,
        backend_effect_requested,
    }
}

fn adapter(
    suffix: &str,
    status: ConvergenceStoppedRunnerCommandAdapterStatus,
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
        blockers: Vec::new(),
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
