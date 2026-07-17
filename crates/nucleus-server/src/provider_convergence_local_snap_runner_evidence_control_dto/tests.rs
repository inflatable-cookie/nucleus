use crate::provider_no_effects::{ConvergenceSnapNoAuthority};
use super::*;

use crate::{
    ConvergenceLocalSnapRunnerEvidencePersistenceBlocker,
    ConvergenceLocalSnapRunnerEvidencePersistenceRecord,
};

#[test]
fn convergence_local_snap_runner_evidence_control_dto_reports_counts() {
    let dto = convergence_local_snap_runner_evidence_control_dto(input(vec![
        record(
            "persisted",
            ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Persisted,
            ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable,
            false,
            Vec::new(),
        ),
        record(
            "duplicate",
            ConvergenceLocalSnapRunnerEvidencePersistenceStatus::DuplicateNoop,
            ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable,
            true,
            Vec::new(),
        ),
        record(
            "blocked",
            ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Blocked,
            ConvergenceLocalSnapRunnerEvidenceStatus::Blocked,
            false,
            vec![ConvergenceLocalSnapRunnerEvidencePersistenceBlocker::EvidenceNotReviewable],
        ),
    ]));

    assert_eq!(dto.persisted_count, 1);
    assert_eq!(dto.duplicate_count, 1);
    assert_eq!(dto.blocked_count, 1);
    assert_eq!(dto.reviewable_evidence_count, 2);
    assert_eq!(dto.blocker_count, 1);
}

#[test]
fn convergence_local_snap_runner_evidence_control_dto_carries_no_authority() {
    let dto = convergence_local_snap_runner_evidence_control_dto(input(vec![record(
        "persisted",
        ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Persisted,
        ConvergenceLocalSnapRunnerEvidenceStatus::Reviewable,
        false,
        Vec::new(),
    )]));

    assert!(!dto.no_effects.command_spawn_permitted);
    assert!(!dto.no_effects.local_snap_creation_permitted);
    assert!(!dto.no_effects.object_upload_permitted);
    assert!(!dto.no_effects.publication_permitted);
    assert!(!dto.no_effects.lane_sync_permitted);
    assert!(!dto.no_effects.provider_write_permitted);
    assert!(!dto.no_effects.task_mutation_permitted);
    assert!(!dto.no_effects.raw_material_retained);
}

fn input(
    records: Vec<ConvergenceLocalSnapRunnerEvidencePersistenceRecord>,
) -> ConvergenceLocalSnapRunnerEvidencePersistenceSet {
    ConvergenceLocalSnapRunnerEvidencePersistenceSet {
        persistence_set_id: "persistence".to_owned(),
        duplicate_evidence_ids: records
            .iter()
            .filter(|record| record.duplicate_evidence_detected)
            .map(|record| record.evidence_id.clone())
            .collect(),
        blocked_evidence_ids: records
            .iter()
            .filter(|record| {
                record.status == ConvergenceLocalSnapRunnerEvidencePersistenceStatus::Blocked
            })
            .map(|record| record.evidence_id.clone())
            .collect(),
        records,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}

fn record(
    suffix: &str,
    status: ConvergenceLocalSnapRunnerEvidencePersistenceStatus,
    evidence_status: ConvergenceLocalSnapRunnerEvidenceStatus,
    duplicate_evidence_detected: bool,
    blockers: Vec<ConvergenceLocalSnapRunnerEvidencePersistenceBlocker>,
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
        local_snap_descriptor_present: true,
        evidence_status,
        status,
        blockers,
        duplicate_evidence_detected,
        no_effects: ConvergenceSnapNoAuthority::none(),
    }
}
