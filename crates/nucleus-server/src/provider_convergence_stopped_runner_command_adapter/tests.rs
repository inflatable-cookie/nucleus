use super::*;
use crate::provider_no_effects::ConvergenceRunnerNoAuthority;

#[test]
fn convergence_stopped_runner_command_adapter_records_reviewable_evidence() {
    let set = convergence_stopped_runner_command_adapter(input(vec![record(
        "one",
        ConvergencePublicationRunnerEvidencePersistenceStatus::Persisted,
        ConvergencePublicationRunnerEvidenceStatus::Reviewable,
        1,
        1,
        1,
    )]));

    assert_eq!(set.records.len(), 1);
    assert_eq!(
        set.records[0].status,
        ConvergenceStoppedRunnerCommandAdapterStatus::Runnable
    );
    assert_eq!(
        set.records[0].adapter_kind,
        ConvergenceStoppedRunnerCommandAdapterKind::StoppedProof
    );
    assert_eq!(
        set.records[0].command_shape,
        ConvergenceStoppedRunnerCommandShape::SnapshotPublishReview
    );
    assert!(set.skipped_persisted_evidence_ids.is_empty());
}

#[test]
fn convergence_stopped_runner_command_adapter_skips_blocked_and_duplicate_evidence() {
    let set = convergence_stopped_runner_command_adapter(input(vec![
        record(
            "blocked",
            ConvergencePublicationRunnerEvidencePersistenceStatus::Blocked,
            ConvergencePublicationRunnerEvidenceStatus::Blocked,
            1,
            1,
            1,
        ),
        record(
            "duplicate",
            ConvergencePublicationRunnerEvidencePersistenceStatus::DuplicateNoop,
            ConvergencePublicationRunnerEvidenceStatus::Reviewable,
            1,
            1,
            1,
        ),
    ]));

    assert_eq!(set.records.len(), 2);
    assert_eq!(set.skipped_persisted_evidence_ids.len(), 2);
    assert!(set.records.iter().any(|record| {
        record.status == ConvergenceStoppedRunnerCommandAdapterStatus::Blocked
            && record.blockers.contains(
                &ConvergenceStoppedRunnerCommandAdapterBlocker::EvidencePersistenceNotReady,
            )
    }));
    assert!(set.records.iter().any(|record| {
        record.status == ConvergenceStoppedRunnerCommandAdapterStatus::DuplicateNoop
            && record
                .blockers
                .contains(&ConvergenceStoppedRunnerCommandAdapterBlocker::DuplicateEvidence)
    }));
}

#[test]
fn convergence_stopped_runner_command_adapter_preserves_refs() {
    let set = convergence_stopped_runner_command_adapter(input(vec![record(
        "refs",
        ConvergencePublicationRunnerEvidencePersistenceStatus::Persisted,
        ConvergencePublicationRunnerEvidenceStatus::Reviewable,
        2,
        3,
        4,
    )]));
    let record = &set.records[0];

    assert_eq!(record.idempotency_key, "idempotency:refs");
    assert_eq!(record.evidence_id, "evidence:refs");
    assert_eq!(record.proof_id, "proof:refs");
    assert_eq!(record.persisted_request_id, "request:persisted:refs");
    assert_eq!(record.request_id, "request:refs");
    assert_eq!(record.task_ids, vec!["task:refs"]);
    assert_eq!(record.repo_ids, vec!["repo:refs"]);
    assert_eq!(record.snapshot_stage_count, 2);
    assert_eq!(record.publish_stage_count, 3);
    assert_eq!(record.publication_review_stage_count, 4);
}

#[test]
fn convergence_stopped_runner_command_adapter_blocks_missing_stages_without_effects() {
    let set = convergence_stopped_runner_command_adapter(input(vec![record(
        "missing",
        ConvergencePublicationRunnerEvidencePersistenceStatus::Persisted,
        ConvergencePublicationRunnerEvidenceStatus::Reviewable,
        0,
        0,
        0,
    )]));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ConvergenceStoppedRunnerCommandAdapterStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ConvergenceStoppedRunnerCommandAdapterBlocker::MissingSnapshotStage));
    assert!(!set.no_effects.runner_invocation_permitted);
    assert!(!set.no_effects.provider_handoff_permitted);
    assert!(!set.no_effects.snapshot_creation_permitted);
    assert!(!set.no_effects.publish_permitted);
    assert!(!set.no_effects.publication_review_permitted);
    assert!(!set.no_effects.provider_write_permitted);
    assert!(!set.no_effects.task_mutation_permitted);
    assert!(!set.no_effects.raw_material_retained);
    assert!(!record.no_effects.runner_invocation_permitted);
    assert!(!record.no_effects.provider_handoff_permitted);
    assert!(!record.no_effects.snapshot_creation_permitted);
    assert!(!record.no_effects.publish_permitted);
    assert!(!record.no_effects.publication_review_permitted);
    assert!(!record.no_effects.provider_write_permitted);
    assert!(!record.no_effects.task_mutation_permitted);
    assert!(!record.no_effects.raw_material_retained);
}

fn input(
    records: Vec<ConvergencePublicationRunnerEvidencePersistenceRecord>,
) -> ConvergenceStoppedRunnerCommandAdapterInput {
    ConvergenceStoppedRunnerCommandAdapterInput {
        persistence: ConvergencePublicationRunnerEvidencePersistenceSet {
            persistence_set_id: "persistence".to_owned(),
            records,
            duplicate_evidence_ids: Vec::new(),
            blocked_evidence_ids: Vec::new(),
            no_effects: ConvergenceRunnerNoAuthority::none(),
        },
    }
}

fn record(
    suffix: &str,
    status: ConvergencePublicationRunnerEvidencePersistenceStatus,
    evidence_status: ConvergencePublicationRunnerEvidenceStatus,
    snapshot_stage_count: usize,
    publish_stage_count: usize,
    publication_review_stage_count: usize,
) -> ConvergencePublicationRunnerEvidencePersistenceRecord {
    ConvergencePublicationRunnerEvidencePersistenceRecord {
        persisted_evidence_id: format!("evidence:persisted:{suffix}"),
        evidence_id: format!("evidence:{suffix}"),
        proof_id: format!("proof:{suffix}"),
        persisted_request_id: format!("request:persisted:{suffix}"),
        request_id: format!("request:{suffix}"),
        idempotency_key: format!("idempotency:{suffix}"),
        task_ids: vec![format!("task:{suffix}")],
        repo_ids: vec![format!("repo:{suffix}")],
        snapshot_stage_count,
        publish_stage_count,
        publication_review_stage_count,
        inspected_stage_count: snapshot_stage_count
            + publish_stage_count
            + publication_review_stage_count,
        evidence_status,
        status,
        blockers: Vec::new(),
        duplicate_evidence_detected: false,
        no_effects: ConvergenceRunnerNoAuthority::none(),
    }
}
