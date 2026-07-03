use std::path::PathBuf;

use super::*;
use nucleus_engine::ManagementProjectionRecordKind;

#[test]
fn planning_projection_import_conflicts_stage_artifact_conflicts_without_resolution() {
    let candidate = ready_candidate(
        "candidate:artifact",
        "nucleus/planning/artifact:roadmap.toml",
        ManagementProjectionRecordKind::PlanningArtifact,
    );
    let admission = admitted_record(&candidate);

    let conflicts = stage_planning_projection_import_conflicts(
        PlanningProjectionImportConflictStagingRequest {
            staging_id: "planning-import-conflicts:artifact".to_owned(),
            candidates: vec![candidate],
            admissions: vec![admission],
            conflict_inputs: vec![
                PlanningProjectionImportConflictInput {
                    candidate_id: "candidate:artifact".to_owned(),
                    kind: PlanningProjectionImportConflictKind::ArtifactTitle,
                    summary: "incoming artifact title differs from local planning state".to_owned(),
                    evidence_refs: vec!["conflict-evidence:title".to_owned()],
                },
                PlanningProjectionImportConflictInput {
                    candidate_id: "candidate:artifact".to_owned(),
                    kind: PlanningProjectionImportConflictKind::ArtifactBody,
                    summary: "incoming artifact body differs from local planning state".to_owned(),
                    evidence_refs: vec!["conflict-evidence:body".to_owned()],
                },
            ],
        },
    );

    assert_eq!(conflicts.conflict_count, 2);
    assert!(conflicts.apply_blocked);
    assert!(conflicts.conflicts.iter().all(|conflict| {
        conflict.admission_record_id.is_some()
            && conflict.file_ref.is_some()
            && conflict.record_kind == Some(ManagementProjectionRecordKind::PlanningArtifact)
            && conflict.apply_blocked
            && !conflict.resolution_performed
    }));
    assert_no_conflict_effects(&conflicts);
}

#[test]
fn planning_projection_import_conflicts_stage_task_seed_conflicts() {
    let candidate = ready_candidate(
        "candidate:seed",
        "nucleus/planning/task-seeds/seed:projection.toml",
        ManagementProjectionRecordKind::PlanningTaskSeed,
    );
    let admission = admitted_record(&candidate);

    let conflicts = stage_planning_projection_import_conflicts(
        PlanningProjectionImportConflictStagingRequest {
            staging_id: "planning-import-conflicts:seed".to_owned(),
            candidates: vec![candidate],
            admissions: vec![admission],
            conflict_inputs: vec![
                PlanningProjectionImportConflictInput {
                    candidate_id: "candidate:seed".to_owned(),
                    kind: PlanningProjectionImportConflictKind::DuplicateTaskSeedId,
                    summary: "incoming seed id already exists with different content".to_owned(),
                    evidence_refs: vec!["conflict-evidence:duplicate-seed".to_owned()],
                },
                PlanningProjectionImportConflictInput {
                    candidate_id: "candidate:seed".to_owned(),
                    kind: PlanningProjectionImportConflictKind::TaskSeedPromotionState,
                    summary: "incoming seed promotion state differs from local server state"
                        .to_owned(),
                    evidence_refs: vec!["conflict-evidence:promotion".to_owned()],
                },
            ],
        },
    );

    assert_eq!(conflicts.conflict_count, 2);
    assert!(conflicts.apply_blocked);
    assert!(conflicts.conflicts.iter().any(|conflict| {
        conflict.kind == PlanningProjectionImportConflictKind::DuplicateTaskSeedId
    }));
    assert!(conflicts.conflicts.iter().any(|conflict| {
        conflict.kind == PlanningProjectionImportConflictKind::TaskSeedPromotionState
    }));
    assert!(conflicts.conflicts.iter().all(|conflict| {
        conflict.record_kind == Some(ManagementProjectionRecordKind::PlanningTaskSeed)
            && conflict
                .evidence_refs
                .iter()
                .any(|evidence| evidence.starts_with("management-file-ref:"))
    }));
    assert_no_conflict_effects(&conflicts);
}

#[test]
fn planning_projection_import_conflicts_stage_missing_source_refs_and_missing_links() {
    let conflicts = stage_planning_projection_import_conflicts(
        PlanningProjectionImportConflictStagingRequest {
            staging_id: "planning-import-conflicts:missing-ref".to_owned(),
            candidates: Vec::new(),
            admissions: Vec::new(),
            conflict_inputs: vec![PlanningProjectionImportConflictInput {
                candidate_id: "candidate:missing-source".to_owned(),
                kind: PlanningProjectionImportConflictKind::MissingSourceRef,
                summary: "incoming task seed source artifact ref is missing".to_owned(),
                evidence_refs: vec!["conflict-evidence:missing-source".to_owned()],
            }],
        },
    );

    assert_eq!(conflicts.conflict_count, 1);
    assert_eq!(conflicts.missing_candidate_ref_count, 1);
    assert_eq!(conflicts.missing_admission_ref_count, 1);
    assert!(conflicts.apply_blocked);
    assert_eq!(
        conflicts.conflicts[0].kind,
        PlanningProjectionImportConflictKind::MissingSourceRef
    );
    assert!(conflicts.conflicts[0].file_ref.is_none());
    assert!(conflicts.conflicts[0].admission_record_id.is_none());
    assert_no_conflict_effects(&conflicts);
}

fn ready_candidate(
    candidate_id: &str,
    file_ref: &str,
    record_kind: ManagementProjectionRecordKind,
) -> PlanningProjectionImportScanCandidate {
    PlanningProjectionImportScanCandidate {
        candidate_id: candidate_id.to_owned(),
        file_ref: ManagementProjectionFileRef(file_ref.to_owned()),
        path: PathBuf::from(file_ref),
        record_id: Some(ManagementProjectionRecordId(
            candidate_id.replace("candidate", "record"),
        )),
        record_kind: Some(record_kind),
        status: PlanningProjectionImportScanCandidateStatus::Ready,
        blockers: Vec::new(),
        evidence_refs: vec![format!("management-file-ref:{file_ref}")],
    }
}

fn admitted_record(
    candidate: &PlanningProjectionImportScanCandidate,
) -> PlanningProjectionImportAdmissionRecord {
    PlanningProjectionImportAdmissionRecord {
        admission_record_id: format!("admission:{}", candidate.candidate_id),
        candidate_id: candidate.candidate_id.clone(),
        file_ref: candidate.file_ref.clone(),
        record_id: candidate.record_id.clone(),
        record_kind: candidate.record_kind.clone(),
        status: PlanningProjectionImportAdmissionStatus::AdmittedStopped,
        blockers: Vec::new(),
        evidence_refs: vec!["review:accepted".to_owned()],
        apply_permitted: false,
        task_promotion_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        ui_apply_permitted: false,
    }
}

fn assert_no_conflict_effects(conflicts: &PlanningProjectionImportConflictSet) {
    assert!(!conflicts.conflict_resolution_performed);
    assert!(!conflicts.active_planning_mutation_performed);
    assert!(!conflicts.task_creation_performed);
    assert!(!conflicts.task_promotion_performed);
    assert!(!conflicts.agent_scheduling_performed);
    assert!(!conflicts.provider_execution_performed);
    assert!(!conflicts.scm_mutation_performed);
    assert!(!conflicts.forge_mutation_performed);
    assert!(!conflicts.raw_payload_retained);
    assert!(!conflicts.ui_apply_triggered);
}
