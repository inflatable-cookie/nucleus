use super::*;

use crate::ConvergenceLocalSnapRunnerReplayEffectFamily;

#[test]
fn convergence_local_snap_execution_preflight_admits_replayed_records() {
    let set = convergence_local_snap_execution_preflight(input(
        vec![replay(
            "ready",
            ConvergenceLocalSnapRunnerReplayStatus::Replayed,
        )],
        Vec::new(),
        true,
        true,
        true,
        false,
        false,
    ));

    assert_eq!(set.records.len(), 1);
    assert_eq!(
        set.records[0].status,
        ConvergenceLocalSnapExecutionPreflightStatus::Ready
    );
    assert_eq!(set.ready_preflight_record_ids.len(), 1);
    assert!(set.blocked_preflight_record_ids.is_empty());
}

#[test]
fn convergence_local_snap_execution_preflight_blocks_missing_prerequisites() {
    let set = convergence_local_snap_execution_preflight(input(
        vec![replay(
            "blocked",
            ConvergenceLocalSnapRunnerReplayStatus::Replayed,
        )],
        Vec::new(),
        false,
        false,
        false,
        true,
        true,
    ));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceLocalSnapExecutionPreflightStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapExecutionPreflightBlocker::MissingOperatorConfirmation));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapExecutionPreflightBlocker::ExecutableNotReady));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapExecutionPreflightBlocker::WorkspaceNotReady));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapExecutionPreflightBlocker::RawMaterialPresent));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapExecutionPreflightBlocker::CommandEffectRequested));
    assert_eq!(set.blocked_preflight_record_ids.len(), 1);
}

#[test]
fn convergence_local_snap_execution_preflight_blocks_missing_authority_refs() {
    let mut replay = replay(
        "authority",
        ConvergenceLocalSnapRunnerReplayStatus::Replayed,
    );
    replay.source_authority_ref.clear();
    replay.execution_authority_ref.clear();

    let set = convergence_local_snap_execution_preflight(input(
        vec![replay],
        Vec::new(),
        true,
        true,
        true,
        false,
        false,
    ));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceLocalSnapExecutionPreflightStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapExecutionPreflightBlocker::MissingSourceAuthority));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapExecutionPreflightBlocker::MissingExecutionAuthority));
}

#[test]
fn convergence_local_snap_execution_preflight_records_duplicate_noops() {
    let first = convergence_local_snap_execution_preflight(input(
        vec![replay(
            "duplicate",
            ConvergenceLocalSnapRunnerReplayStatus::Replayed,
        )],
        Vec::new(),
        true,
        true,
        true,
        false,
        false,
    ));
    let duplicate = convergence_local_snap_execution_preflight(input(
        vec![replay(
            "duplicate",
            ConvergenceLocalSnapRunnerReplayStatus::Replayed,
        )],
        vec![first.records[0].preflight_record_id.clone()],
        true,
        true,
        true,
        false,
        false,
    ));

    assert_eq!(
        duplicate.records[0].status,
        ConvergenceLocalSnapExecutionPreflightStatus::DuplicateNoop
    );
    assert!(duplicate.records[0]
        .blockers
        .contains(&ConvergenceLocalSnapExecutionPreflightBlocker::DuplicatePreflightRecord));
    assert_eq!(duplicate.duplicate_preflight_record_ids.len(), 1);
}

#[test]
fn convergence_local_snap_execution_preflight_keeps_non_replayed_records_not_ready() {
    let set = convergence_local_snap_execution_preflight(input(
        vec![
            replay(
                "duplicate-replay",
                ConvergenceLocalSnapRunnerReplayStatus::DuplicateNoop,
            ),
            replay(
                "unsupported",
                ConvergenceLocalSnapRunnerReplayStatus::Unsupported,
            ),
            replay("blocked", ConvergenceLocalSnapRunnerReplayStatus::Blocked),
        ],
        Vec::new(),
        true,
        true,
        true,
        false,
        false,
    ));

    assert_eq!(set.ready_preflight_record_ids.len(), 0);
    assert_eq!(set.duplicate_preflight_record_ids.len(), 1);
    assert_eq!(set.unsupported_preflight_record_ids.len(), 1);
    assert_eq!(set.blocked_preflight_record_ids.len(), 1);
}

#[test]
fn convergence_local_snap_execution_preflight_preserves_refs_and_executes_no_effects() {
    let set = convergence_local_snap_execution_preflight(input(
        vec![replay(
            "refs",
            ConvergenceLocalSnapRunnerReplayStatus::Replayed,
        )],
        Vec::new(),
        true,
        true,
        true,
        false,
        false,
    ));
    let record = &set.records[0];

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
    records: Vec<ConvergenceLocalSnapRunnerReplayRecord>,
    existing_preflight_record_ids: Vec<String>,
    operator_confirmed: bool,
    executable_ready: bool,
    workspace_ready: bool,
    raw_material_present: bool,
    command_effect_requested: bool,
) -> ConvergenceLocalSnapExecutionPreflightInput {
    ConvergenceLocalSnapExecutionPreflightInput {
        replay: ConvergenceLocalSnapRunnerReplayRecordSet {
            replay_set_id: "replay".to_owned(),
            records,
            duplicate_replay_record_ids: Vec::new(),
            blocked_replay_record_ids: Vec::new(),
            unsupported_replay_record_ids: Vec::new(),
            command_spawn_permitted: false,
            local_snap_creation_permitted: false,
            object_upload_permitted: false,
            publication_permitted: false,
            lane_sync_permitted: false,
            provider_write_permitted: false,
            task_mutation_permitted: false,
            raw_material_retained: false,
        },
        existing_preflight_record_ids,
        operator_confirmed,
        executable_ready,
        workspace_ready,
        raw_material_present,
        command_effect_requested,
    }
}

fn replay(
    suffix: &str,
    status: ConvergenceLocalSnapRunnerReplayStatus,
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
        blockers: Vec::new(),
        duplicate_replay_detected: false,
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
