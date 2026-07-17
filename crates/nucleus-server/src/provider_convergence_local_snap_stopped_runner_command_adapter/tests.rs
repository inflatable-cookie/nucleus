use crate::provider_no_effects::{ConvergenceSnapNoAuthority};
use super::*;

#[test]
fn convergence_local_snap_stopped_runner_command_adapter_records_reviewable_evidence() {
    let set = convergence_local_snap_stopped_runner_command_adapter(input(vec![record(
        "one",
        ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Persisted,
        ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable,
        true,
    )]));

    assert_eq!(set.records.len(), 1);
    assert_eq!(
        set.records[0].status,
        ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Runnable
    );
    assert_eq!(
        set.records[0].adapter_kind,
        ConvergenceLocalSnapStoppedRunnerCommandAdapterKind::StoppedProof
    );
    assert_eq!(
        set.records[0].command_shape,
        ConvergenceLocalSnapStoppedRunnerCommandShape::ConvergeSnap
    );
    assert!(set.skipped_persisted_evidence_ids.is_empty());
}

#[test]
fn convergence_local_snap_stopped_runner_command_adapter_skips_blocked_and_duplicate_evidence() {
    let set = convergence_local_snap_stopped_runner_command_adapter(input(vec![
        record(
            "blocked",
            ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Blocked,
            ConvergenceLocalSnapRunnerEvidenceStatus::Blocked,
            true,
        ),
        record(
            "duplicate",
            ConvergenceLocalSnapRunnerEvidencePersistenceStatus::DuplicateNoop,
            ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable,
            true,
        ),
    ]));

    assert_eq!(set.records.len(), 2);
    assert_eq!(set.skipped_persisted_evidence_ids.len(), 2);
    assert!(set.records.iter().any(|record| {
        record.status == ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Blocked
            && record.blockers.contains(
                &ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker::EvidencePersistenceNotReady,
            )
    }));
    assert!(set.records.iter().any(|record| {
        record.status == ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::DuplicateNoop
            && record.blockers.contains(
                &ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker::DuplicateEvidence,
            )
    }));
}

#[test]
fn convergence_local_snap_stopped_runner_command_adapter_preserves_refs() {
    let set = convergence_local_snap_stopped_runner_command_adapter(input(vec![record(
        "refs",
        ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Persisted,
        ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable,
        true,
    )]));
    let record = &set.records[0];

    assert_eq!(record.idempotency_key, "idempotency:refs");
    assert_eq!(record.evidence_id, "evidence:refs");
    assert_eq!(record.proof_id, "proof:refs");
    assert_eq!(record.persisted_request_id, "persisted:refs");
    assert_eq!(record.stopped_request_id, "stopped:refs");
    assert_eq!(record.descriptor_id, "descriptor:refs");
    assert_eq!(record.admission_id, "admission:refs");
    assert_eq!(record.replay_record_id, "replay:refs");
    assert_eq!(record.task_ids, vec!["task:refs"]);
    assert_eq!(record.repo_ids, vec!["repo:refs"]);
    assert_eq!(record.source_authority_ref, "source-authority:refs");
    assert_eq!(record.execution_authority_ref, "execution-authority:refs");
    assert_eq!(record.inspected_ref_count, 1);
}

#[test]
fn convergence_local_snap_stopped_runner_command_adapter_blocks_missing_descriptor_without_effects()
{
    let set = convergence_local_snap_stopped_runner_command_adapter(input(vec![record(
        "missing",
        ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Persisted,
        ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable,
        false,
    )]));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceLocalSnapStoppedRunnerCommandAdapterStatus::Blocked
    );
    assert!(record.blockers.contains(
        &ConvergenceLocalSnapStoppedRunnerCommandAdapterBlocker::MissingLocalSnapDescriptor
    ));
    assert!(!set.no_effects.command_spawn_permitted);
    assert!(!set.no_effects.local_snap_creation_permitted);
    assert!(!set.no_effects.object_upload_permitted);
    assert!(!set.no_effects.publication_permitted);
    assert!(!set.no_effects.lane_sync_permitted);
    assert!(!set.no_effects.provider_write_permitted);
    assert!(!set.no_effects.task_mutation_permitted);
    assert!(!set.no_effects.raw_material_retained);
    assert!(!record.no_effects.command_spawn_permitted);
    assert!(!record.no_effects.local_snap_creation_permitted);
    assert!(!record.no_effects.object_upload_permitted);
    assert!(!record.no_effects.publication_permitted);
    assert!(!record.no_effects.lane_sync_permitted);
    assert!(!record.no_effects.provider_write_permitted);
    assert!(!record.no_effects.task_mutation_permitted);
    assert!(!record.no_effects.raw_material_retained);
}

fn input(
    records: Vec<ConvergenceLocalSnapRunnerEvidencePersistenceRecord>,
) -> ConvergenceLocalSnapStoppedRunnerCommandAdapterInput {
    ConvergenceLocalSnapStoppedRunnerCommandAdapterInput {
        persistence: ConvergenceLocalSnapRunnerEvidencePersistenceSet {
            persistence_set_id: "persistence".to_owned(),
            records,
            duplicate_evidence_ids: Vec::new(),
            blocked_evidence_ids: Vec::new(),
        no_effects: ConvergenceSnapNoAuthority::none(),
        },
    }
}

fn record(
    suffix: &str,
    status: ConvergenceLocalSnapRunnerEvidencePersistenceStatus,
    evidence_status: ConvergenceLocalSnapRunnerEvidenceStatus,
    local_snap_descriptor_present: bool,
) -> ConvergenceLocalSnapRunnerEvidencePersistenceRecord {
    ConvergenceLocalSnapRunnerEvidencePersistenceRecord {
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
        local_snap_descriptor_present,
        evidence_status,
        status,
        blockers: Vec::new(),
        duplicate_evidence_detected: false,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}
