use super::*;

use crate::ConvergenceRunnerReplayProviderRefs;

#[test]
fn convergence_local_snap_admission_admits_ready_replay_records() {
    let set = convergence_local_snap_admission(input(
        vec![replay(
            "ready",
            ConvergenceRunnerReplayStatus::Replayed,
            true,
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
        ConvergenceLocalSnapAdmissionStatus::Admitted
    );
    assert!(set.local_snap_creation_admitted);
    assert!(set.records[0].local_snap_creation_admitted);
}

#[test]
fn convergence_local_snap_admission_blocks_missing_authority() {
    let set = convergence_local_snap_admission(input(
        vec![replay(
            "authority",
            ConvergenceRunnerReplayStatus::Replayed,
            true,
        )],
        Vec::new(),
        false,
        false,
        false,
        false,
        false,
    ));
    let record = &set.records[0];

    assert_eq!(record.status, ConvergenceLocalSnapAdmissionStatus::Blocked);
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapAdmissionBlocker::MissingSourceAuthority));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapAdmissionBlocker::MissingExecutionAuthority));
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapAdmissionBlocker::WorkspaceNotReady));
}

#[test]
fn convergence_local_snap_admission_records_duplicates_and_unsupported_replay() {
    let first = convergence_local_snap_admission(input(
        vec![replay(
            "duplicate",
            ConvergenceRunnerReplayStatus::Replayed,
            true,
        )],
        Vec::new(),
        true,
        true,
        true,
        false,
        false,
    ));
    let duplicate = convergence_local_snap_admission(input(
        vec![
            replay("duplicate", ConvergenceRunnerReplayStatus::Replayed, true),
            replay(
                "unsupported",
                ConvergenceRunnerReplayStatus::Unsupported,
                true,
            ),
        ],
        vec![first.records[0].admission_id.clone()],
        true,
        true,
        true,
        false,
        false,
    ));

    assert_eq!(duplicate.duplicate_admission_ids.len(), 1);
    assert_eq!(duplicate.unsupported_admission_ids.len(), 1);
    assert!(duplicate
        .records
        .iter()
        .any(|record| { record.status == ConvergenceLocalSnapAdmissionStatus::DuplicateNoop }));
    assert!(duplicate
        .records
        .iter()
        .any(|record| { record.status == ConvergenceLocalSnapAdmissionStatus::Unsupported }));
}

#[test]
fn convergence_local_snap_admission_keeps_remote_effects_false() {
    let set = convergence_local_snap_admission(input(
        vec![replay(
            "effects",
            ConvergenceRunnerReplayStatus::Replayed,
            true,
        )],
        Vec::new(),
        true,
        true,
        true,
        true,
        true,
    ));
    let record = &set.records[0];

    assert_eq!(record.status, ConvergenceLocalSnapAdmissionStatus::Blocked);
    assert!(record
        .blockers
        .contains(&ConvergenceLocalSnapAdmissionBlocker::BackendEffectRequested));
    assert!(!set.local_snap_creation_executed);
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
    assert!(!record.local_snap_creation_executed);
    assert!(!record.provider_write_permitted);
    assert!(!record.task_mutation_permitted);
}

fn input(
    records: Vec<ConvergenceRunnerReplayRecord>,
    existing_admission_ids: Vec<String>,
    source_authority_ready: bool,
    execution_authority_ready: bool,
    workspace_ready: bool,
    backend_effect_requested: bool,
    raw_material_present: bool,
) -> ConvergenceLocalSnapAdmissionInput {
    ConvergenceLocalSnapAdmissionInput {
        replay: ConvergenceRunnerReplayRecordSet {
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
        },
        existing_admission_ids,
        source_authority_ready,
        execution_authority_ready,
        workspace_ready,
        backend_effect_requested,
        raw_material_present,
    }
}

fn replay(
    suffix: &str,
    status: ConvergenceRunnerReplayStatus,
    includes_local_snap_family: bool,
) -> ConvergenceRunnerReplayRecord {
    let effect_families = if includes_local_snap_family {
        vec![ConvergenceRunnerReplayEffectFamily::LocalSnapCreation]
    } else {
        vec![ConvergenceRunnerReplayEffectFamily::PublicationCreation]
    };

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
        effect_families,
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
        blockers: Vec::new(),
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
