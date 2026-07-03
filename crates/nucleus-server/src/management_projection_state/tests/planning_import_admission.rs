use std::path::PathBuf;

use super::*;
use nucleus_engine::ManagementProjectionRecordKind;

#[test]
fn planning_projection_import_admission_admits_reviewed_ready_candidates_as_stopped_records() {
    let candidate = ready_candidate(
        "candidate:artifact",
        "nucleus/planning/artifact:roadmap.toml",
    );

    let admission =
        admit_planning_projection_import_candidates(PlanningProjectionImportAdmissionRequest {
            admission_id: "planning-import-admission:test".to_owned(),
            reviewed_candidate_ids: vec![candidate.candidate_id.clone()],
            conflicting_candidate_ids: Vec::new(),
            review_evidence_refs: vec!["review:accepted".to_owned()],
            candidates: vec![candidate],
        });

    assert_eq!(admission.records.len(), 1);
    assert_eq!(
        admission.records[0].status,
        PlanningProjectionImportAdmissionStatus::AdmittedStopped
    );
    assert!(admission.records[0].blockers.is_empty());
    assert!(admission.records[0]
        .evidence_refs
        .contains(&"review:accepted".to_owned()));
    assert_no_admission_effects(&admission);
    assert_no_record_effects(&admission.records[0]);
}

#[test]
fn planning_projection_import_admission_blocks_unreviewed_blocked_conflicting_and_missing_id_candidates(
) {
    let unreviewed = ready_candidate(
        "candidate:unreviewed",
        "nucleus/planning/artifact:unreviewed.toml",
    );
    let blocked = blocked_candidate(
        "candidate:blocked",
        "nucleus/planning/artifact:blocked.toml",
    );
    let conflicting = ready_candidate(
        "candidate:conflict",
        "nucleus/planning/artifact:conflict.toml",
    );
    let mut missing_id = ready_candidate(
        "candidate:missing-id",
        "nucleus/planning/artifact:missing.toml",
    );
    missing_id.record_id = None;

    let admission =
        admit_planning_projection_import_candidates(PlanningProjectionImportAdmissionRequest {
            admission_id: "planning-import-admission:blocked".to_owned(),
            reviewed_candidate_ids: vec![
                blocked.candidate_id.clone(),
                conflicting.candidate_id.clone(),
                missing_id.candidate_id.clone(),
            ],
            conflicting_candidate_ids: vec![conflicting.candidate_id.clone()],
            review_evidence_refs: vec!["review:accepted".to_owned()],
            candidates: vec![unreviewed, blocked, conflicting, missing_id],
        });

    assert_eq!(admission.records.len(), 4);
    assert!(admission.records.iter().all(|record| {
        record.status == PlanningProjectionImportAdmissionStatus::Blocked
            && !record.blockers.is_empty()
    }));
    assert!(admission.records.iter().any(|record| {
        record.blockers.iter().any(|blocker| {
            matches!(
                blocker,
                PlanningProjectionImportAdmissionBlocker::UnreviewedCandidate { .. }
            )
        })
    }));
    assert!(admission.records.iter().any(|record| {
        record.blockers.iter().any(|blocker| {
            matches!(
                blocker,
                PlanningProjectionImportAdmissionBlocker::CandidateBlocked { .. }
            )
        })
    }));
    assert!(admission.records.iter().any(|record| {
        record.blockers.iter().any(|blocker| {
            matches!(
                blocker,
                PlanningProjectionImportAdmissionBlocker::ConflictStaged { .. }
            )
        })
    }));
    assert!(admission.records.iter().any(|record| {
        record.blockers.iter().any(|blocker| {
            matches!(
                blocker,
                PlanningProjectionImportAdmissionBlocker::MissingRecordId { .. }
            )
        })
    }));
    assert_no_admission_effects(&admission);
}

#[test]
fn planning_projection_import_admission_is_duplicate_safe_by_file_ref() {
    let first = ready_candidate("candidate:first", "nucleus/planning/artifact:same.toml");
    let second = ready_candidate("candidate:second", "nucleus/planning/artifact:same.toml");

    let admission =
        admit_planning_projection_import_candidates(PlanningProjectionImportAdmissionRequest {
            admission_id: "planning-import-admission:duplicates".to_owned(),
            reviewed_candidate_ids: vec![first.candidate_id.clone(), second.candidate_id.clone()],
            conflicting_candidate_ids: Vec::new(),
            review_evidence_refs: Vec::new(),
            candidates: vec![second, first],
        });

    assert_eq!(admission.records.len(), 2);
    assert_eq!(
        admission.records[0].status,
        PlanningProjectionImportAdmissionStatus::AdmittedStopped
    );
    assert_eq!(
        admission.records[1].status,
        PlanningProjectionImportAdmissionStatus::DuplicateNoop
    );
    assert!(admission.records[1].blockers.iter().any(|blocker| {
        matches!(
            blocker,
            PlanningProjectionImportAdmissionBlocker::DuplicateCandidate { .. }
        )
    }));
    assert_no_admission_effects(&admission);
}

fn ready_candidate(candidate_id: &str, file_ref: &str) -> PlanningProjectionImportScanCandidate {
    PlanningProjectionImportScanCandidate {
        candidate_id: candidate_id.to_owned(),
        file_ref: ManagementProjectionFileRef(file_ref.to_owned()),
        path: PathBuf::from(file_ref),
        record_id: Some(ManagementProjectionRecordId(
            candidate_id.replace("candidate", "record"),
        )),
        record_kind: Some(ManagementProjectionRecordKind::PlanningArtifact),
        status: PlanningProjectionImportScanCandidateStatus::Ready,
        blockers: Vec::new(),
        evidence_refs: vec![format!("management-file-ref:{file_ref}")],
    }
}

fn blocked_candidate(candidate_id: &str, file_ref: &str) -> PlanningProjectionImportScanCandidate {
    let mut candidate = ready_candidate(candidate_id, file_ref);
    candidate.status = PlanningProjectionImportScanCandidateStatus::Blocked;
    candidate
        .blockers
        .push(PlanningProjectionImportScanBlocker::ParseFailed {
            summary: "decode failed".to_owned(),
        });
    candidate
}

fn assert_no_admission_effects(admission: &PlanningProjectionImportAdmissionSet) {
    assert!(!admission.active_planning_mutation_performed);
    assert!(!admission.task_creation_performed);
    assert!(!admission.task_promotion_performed);
    assert!(!admission.agent_scheduling_performed);
    assert!(!admission.provider_execution_performed);
    assert!(!admission.scm_mutation_performed);
    assert!(!admission.forge_mutation_performed);
    assert!(!admission.raw_payload_retained);
    assert!(!admission.ui_apply_triggered);
}

fn assert_no_record_effects(record: &PlanningProjectionImportAdmissionRecord) {
    assert!(!record.apply_permitted);
    assert!(!record.task_promotion_permitted);
    assert!(!record.provider_execution_permitted);
    assert!(!record.scm_mutation_permitted);
    assert!(!record.forge_mutation_permitted);
    assert!(!record.ui_apply_permitted);
}
