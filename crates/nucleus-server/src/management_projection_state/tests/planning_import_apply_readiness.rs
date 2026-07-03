use super::*;
use nucleus_engine::ManagementProjectionRecordKind;

#[test]
fn planning_import_apply_readiness_marks_clean_admissions_ready_without_effects() {
    let admission = admitted_record(
        "candidate:artifact",
        "nucleus/planning/artifact:roadmap.toml",
    );

    let readiness = assess_planning_projection_import_apply_readiness(
        PlanningProjectionImportApplyReadinessInput {
            readiness_id: "planning-import-readiness:clean".to_owned(),
            admissions: vec![admission],
            conflicts: Vec::new(),
            target_revisions: Vec::new(),
        },
    );

    assert_eq!(readiness.ready_count, 1);
    assert_eq!(readiness.entries.len(), 1);
    assert_eq!(
        readiness.entries[0].status,
        PlanningProjectionImportApplyReadinessStatus::Ready
    );
    assert!(readiness.entries[0].blockers.is_empty());
    assert!(readiness.entries[0]
        .evidence_refs
        .contains(&"review:accepted".to_owned()));
    assert_eq!(readiness.entries[0].expected_current_revision, None);
    assert_no_readiness_effects(&readiness);
    assert_no_entry_effects(&readiness.entries[0]);
}

#[test]
fn planning_import_apply_readiness_blocks_staged_conflicts() {
    let admission = admitted_record(
        "candidate:artifact",
        "nucleus/planning/artifact:roadmap.toml",
    );
    let conflict = conflict_record(&admission);

    let readiness = assess_planning_projection_import_apply_readiness(
        PlanningProjectionImportApplyReadinessInput {
            readiness_id: "planning-import-readiness:conflict".to_owned(),
            admissions: vec![admission],
            conflicts: vec![conflict],
            target_revisions: Vec::new(),
        },
    );

    assert_eq!(readiness.conflict_count, 1);
    assert_eq!(
        readiness.entries[0].status,
        PlanningProjectionImportApplyReadinessStatus::Conflict
    );
    assert_eq!(
        readiness.entries[0].conflict_ids,
        vec!["conflict:candidate:artifact".to_owned()]
    );
    assert!(readiness.entries[0].blockers.iter().any(|blocker| {
        matches!(
            blocker,
            PlanningProjectionImportApplyReadinessBlocker::ConflictStaged { .. }
        )
    }));
    assert_no_readiness_effects(&readiness);
}

#[test]
fn planning_import_apply_readiness_preserves_duplicate_noops_as_no_effect_entries() {
    let mut admission =
        admitted_record("candidate:duplicate", "nucleus/planning/artifact:same.toml");
    admission.status = PlanningProjectionImportAdmissionStatus::DuplicateNoop;

    let readiness = assess_planning_projection_import_apply_readiness(
        PlanningProjectionImportApplyReadinessInput {
            readiness_id: "planning-import-readiness:duplicate".to_owned(),
            admissions: vec![admission],
            conflicts: Vec::new(),
            target_revisions: Vec::new(),
        },
    );

    assert_eq!(readiness.duplicate_noop_count, 1);
    assert_eq!(
        readiness.entries[0].status,
        PlanningProjectionImportApplyReadinessStatus::DuplicateNoop
    );
    assert!(readiness.entries[0].blockers.iter().any(|blocker| {
        matches!(
            blocker,
            PlanningProjectionImportApplyReadinessBlocker::DuplicateNoop { .. }
        )
    }));
    assert_no_readiness_effects(&readiness);
}

#[test]
fn planning_import_apply_readiness_detects_stale_and_repair_required_targets() {
    let stale = admitted_record("candidate:stale", "nucleus/planning/artifact:stale.toml");
    let repair = admitted_record("candidate:repair", "nucleus/planning/artifact:repair.toml");

    let readiness = assess_planning_projection_import_apply_readiness(
        PlanningProjectionImportApplyReadinessInput {
            readiness_id: "planning-import-readiness:targets".to_owned(),
            admissions: vec![repair.clone(), stale.clone()],
            conflicts: Vec::new(),
            target_revisions: vec![
                PlanningProjectionImportApplyTargetRevision {
                    record_id: stale.record_id.clone().expect("record id"),
                    expected_current_revision: Some(RevisionId("revision:old".to_owned())),
                    observed_current_revision: Some(RevisionId("revision:new".to_owned())),
                    target_exists: true,
                    repair_required: false,
                },
                PlanningProjectionImportApplyTargetRevision {
                    record_id: repair.record_id.clone().expect("record id"),
                    expected_current_revision: Some(RevisionId("revision:current".to_owned())),
                    observed_current_revision: Some(RevisionId("revision:current".to_owned())),
                    target_exists: false,
                    repair_required: true,
                },
            ],
        },
    );

    assert_eq!(readiness.stale_count, 1);
    assert_eq!(readiness.repair_required_count, 1);
    assert!(readiness.entries.iter().any(|entry| {
        entry.status == PlanningProjectionImportApplyReadinessStatus::Stale
            && entry.expected_current_revision == Some("revision:old".to_owned())
            && entry.observed_current_revision == Some("revision:new".to_owned())
            && entry.blockers.iter().any(|blocker| {
                matches!(
                    blocker,
                    PlanningProjectionImportApplyReadinessBlocker::StaleTargetRevision { .. }
                )
            })
    }));
    assert!(readiness.entries.iter().any(|entry| {
        entry.status == PlanningProjectionImportApplyReadinessStatus::RepairRequired
            && entry.blockers.iter().any(|blocker| {
                matches!(
                    blocker,
                    PlanningProjectionImportApplyReadinessBlocker::RepairRequired { .. }
                        | PlanningProjectionImportApplyReadinessBlocker::MissingTarget { .. }
                )
            })
    }));
    assert_no_readiness_effects(&readiness);
}

fn admitted_record(candidate_id: &str, file_ref: &str) -> PlanningProjectionImportAdmissionRecord {
    PlanningProjectionImportAdmissionRecord {
        admission_record_id: format!("admission:{candidate_id}"),
        candidate_id: candidate_id.to_owned(),
        file_ref: ManagementProjectionFileRef(file_ref.to_owned()),
        record_id: Some(ManagementProjectionRecordId(
            candidate_id.replace("candidate", "record"),
        )),
        record_kind: Some(ManagementProjectionRecordKind::PlanningArtifact),
        status: PlanningProjectionImportAdmissionStatus::AdmittedStopped,
        blockers: Vec::new(),
        evidence_refs: vec![
            "review:accepted".to_owned(),
            format!("management-file-ref:{file_ref}"),
        ],
        apply_permitted: false,
        task_promotion_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        ui_apply_permitted: false,
    }
}

fn conflict_record(
    admission: &PlanningProjectionImportAdmissionRecord,
) -> PlanningProjectionImportConflictRecord {
    PlanningProjectionImportConflictRecord {
        conflict_id: format!("conflict:{}", admission.candidate_id),
        candidate_id: admission.candidate_id.clone(),
        admission_record_id: Some(admission.admission_record_id.clone()),
        file_ref: Some(admission.file_ref.clone()),
        record_id: admission.record_id.clone(),
        record_kind: admission.record_kind.clone(),
        kind: PlanningProjectionImportConflictKind::ArtifactBody,
        summary: "incoming artifact body differs from local planning state".to_owned(),
        evidence_refs: vec!["conflict-evidence:body".to_owned()],
        apply_blocked: true,
        resolution_performed: false,
    }
}

fn assert_no_readiness_effects(readiness: &PlanningProjectionImportApplyReadinessSet) {
    assert!(!readiness.active_planning_mutation_performed);
    assert!(!readiness.task_creation_performed);
    assert!(!readiness.task_promotion_performed);
    assert!(!readiness.agent_scheduling_performed);
    assert!(!readiness.provider_execution_performed);
    assert!(!readiness.scm_mutation_performed);
    assert!(!readiness.forge_mutation_performed);
    assert!(!readiness.semantic_merge_performed);
    assert!(!readiness.raw_payload_retained);
    assert!(!readiness.ui_apply_triggered);
}

fn assert_no_entry_effects(entry: &PlanningProjectionImportApplyReadinessEntry) {
    assert!(!entry.apply_permitted);
    assert!(!entry.task_promotion_permitted);
    assert!(!entry.provider_execution_permitted);
    assert!(!entry.scm_mutation_permitted);
    assert!(!entry.forge_mutation_permitted);
    assert!(!entry.ui_apply_permitted);
}
