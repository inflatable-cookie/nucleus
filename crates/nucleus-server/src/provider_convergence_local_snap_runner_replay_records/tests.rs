use super::*;

use crate::{
    ConvergenceLocalSnapStoppedRunnerCommandAdapterKind,
    ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord,
    ConvergenceLocalSnapStoppedRunnerCommandShape,
};

#[test]
fn convergence_local_snap_runner_replay_records_persist_runnable_adapter_decisions() {
    let set = convergence_local_snap_runner_replay_records(input(
        vec![adapter(
            "one",
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Runnable,
        )],
        Vec::new(),
        false,
        false,
    ));

    assert_eq!(set.records.len(), 1);
    assert_eq!(
        set.records[0].status,
        ConvergenceLocalSnapRunnerReplayStatus::Replayed
    );
    assert_eq!(set.records[0].effect_families.len(), 2);
}

#[test]
fn convergence_local_snap_runner_replay_records_duplicate_ids_are_noops() {
    let first = convergence_local_snap_runner_replay_records(input(
        vec![adapter(
            "duplicate",
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Runnable,
        )],
        Vec::new(),
        false,
        false,
    ));
    let duplicate = convergence_local_snap_runner_replay_records(input(
        vec![adapter(
            "duplicate",
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Runnable,
        )],
        vec![first.records[0].replay_record_id.clone()],
        false,
        false,
    ));

    assert_eq!(
        duplicate.records[0].status,
        ConvergenceLocalSnapRunnerReplayStatus::DuplicateNoop
    );
    assert_eq!(duplicate.duplicate_replay_record_ids.len(), 1);
}

#[test]
fn convergence_local_snap_runner_replay_records_preserve_adapter_refs() {
    let set = convergence_local_snap_runner_replay_records(input(
        vec![adapter(
            "refs",
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Runnable,
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

#[test]
fn convergence_local_snap_runner_replay_records_block_effect_requests_without_effects() {
    let set = convergence_local_snap_runner_replay_records(input(
        vec![adapter(
            "blocked",
            ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Runnable,
        )],
        Vec::new(),
        true,
        true,
    ));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceLocalSnapRunnerReplayStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapRunnerReplayBlocker::CommandEffectRequested));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapRunnerReplayBlocker::RawMaterialPresent));
    assert!(!set.command_spawn_permitted);
    assert!(!set.local_snap_creation_permitted);
    assert!(!set.object_upload_permitted);
    assert!(!set.publication_permitted);
    assert!(!set.lane_sync_permitted);
    assert!(!set.provider_write_permitted);
    assert!(!set.task_mutation_permitted);
    assert!(!set.raw_material_retained);
    assert!(!record.command_spawn_permitted);
    assert!(!record.local_snap_creation_permitted);
    assert!(!record.provider_write_permitted);
    assert!(!record.task_mutation_permitted);
}

fn input(
    records: Vec<ConvergenceLocalSnapStoppedRunnerCommandAdapterRecord>,
    existing_replay_record_ids: Vec<String>,
    raw_material_present: bool,
    command_effect_requested: bool,
) -> ConvergenceLocalSnapRunnerReplayRecordsInput {
    ConvergenceLocalSnapRunnerReplayRecordsInput {
        adapter: ConvergenceLocalSnapStoppedRunnerCommandAdapterSet {
            adapter_set_id: "adapter".to_owned(),
            records,
            skipped_persisted_evidence_ids: Vec::new(),
            command_spawn_permitted: false,
            local_snap_creation_permitted: false,
            object_upload_permitted: false,
            publication_permitted: false,
            lane_sync_permitted: false,
            provider_write_permitted: false,
            task_mutation_permitted: false,
            raw_material_retained: false,
        },
        existing_replay_record_ids,
        raw_material_present,
        command_effect_requested,
    }
}

fn adapter(
    suffix: &str,
    status: ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus,
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
        replay_record_id: format!("source-replay:{suffix}"),
        task_ids: vec![format!("task:{suffix}")],
        repo_ids: vec![format!("repo:{suffix}")],
        source_authority_ref: format!("source-authority:{suffix}"),
        execution_authority_ref: format!("execution-authority:{suffix}"),
        inspected_ref_count: 1,
        local_snap_descriptor_present: true,
        adapter_kind: ConvergenceLocalSnapStoppedRunnerCommandAdapterKind::StoppedProof,
        command_shape: ConvergenceLocalSnapStoppedRunnerCommandShape::ConvergeSnap,
        status,
        blockers: Vec::new(),
        command_spawn_permitted: false,
        local_snap_creation_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}
