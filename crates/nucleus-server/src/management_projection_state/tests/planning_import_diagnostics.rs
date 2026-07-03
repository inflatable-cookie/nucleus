use std::path::PathBuf;

use super::*;
use nucleus_engine::ManagementProjectionRecordKind;

#[test]
fn planning_projection_import_diagnostics_reports_empty_set_without_effects() {
    let diagnostics =
        planning_projection_import_diagnostics(PlanningProjectionImportDiagnosticsInput {
            candidates: Vec::new(),
            admissions: Vec::new(),
            conflicts: Vec::new(),
        });

    assert_eq!(diagnostics.candidate_count, 0);
    assert_eq!(diagnostics.admission_count, 0);
    assert_eq!(diagnostics.conflict_count, 0);
    assert!(!diagnostics.apply_blocked);
    assert_no_diagnostic_effects(&diagnostics);
}

#[test]
fn planning_projection_import_diagnostics_reports_ready_stopped_import() {
    let candidate = ready_candidate("candidate:ready", "nucleus/planning/artifact:ready.toml");
    let admission = admitted_record(&candidate);

    let diagnostics =
        planning_projection_import_diagnostics(PlanningProjectionImportDiagnosticsInput {
            candidates: vec![candidate],
            admissions: vec![admission],
            conflicts: Vec::new(),
        });

    assert_eq!(diagnostics.candidate_count, 1);
    assert_eq!(diagnostics.ready_candidate_count, 1);
    assert_eq!(diagnostics.blocked_candidate_count, 0);
    assert_eq!(diagnostics.admitted_stopped_count, 1);
    assert_eq!(diagnostics.blocker_count, 0);
    assert_eq!(diagnostics.conflict_count, 0);
    assert_eq!(diagnostics.evidence_ref_count, 2);
    assert!(!diagnostics.apply_blocked);
    assert_bucket(&diagnostics.candidate_status_buckets, "ready", 1);
    assert_bucket(&diagnostics.admission_status_buckets, "admitted_stopped", 1);
    assert_no_diagnostic_effects(&diagnostics);
}

#[test]
fn planning_projection_import_diagnostics_reports_blocked_and_duplicate_sets() {
    let blocked_candidate = blocked_candidate(
        "candidate:blocked",
        "nucleus/planning/artifact:blocked.toml",
    );
    let blocked_admission = PlanningProjectionImportAdmissionRecord {
        admission_record_id: "admission:candidate:blocked".to_owned(),
        candidate_id: blocked_candidate.candidate_id.clone(),
        file_ref: blocked_candidate.file_ref.clone(),
        record_id: blocked_candidate.record_id.clone(),
        record_kind: blocked_candidate.record_kind.clone(),
        status: PlanningProjectionImportAdmissionStatus::Blocked,
        blockers: vec![PlanningProjectionImportAdmissionBlocker::CandidateBlocked {
            summary: "candidate blocked".to_owned(),
        }],
        evidence_refs: vec!["review:blocked".to_owned()],
        apply_permitted: false,
        task_promotion_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        ui_apply_permitted: false,
    };
    let duplicate = PlanningProjectionImportAdmissionRecord {
        admission_record_id: "admission:candidate:duplicate".to_owned(),
        candidate_id: "candidate:duplicate".to_owned(),
        file_ref: ManagementProjectionFileRef("nucleus/planning/artifact:blocked.toml".to_owned()),
        record_id: Some(ManagementProjectionRecordId("artifact:blocked".to_owned())),
        record_kind: Some(ManagementProjectionRecordKind::PlanningArtifact),
        status: PlanningProjectionImportAdmissionStatus::DuplicateNoop,
        blockers: vec![
            PlanningProjectionImportAdmissionBlocker::DuplicateCandidate {
                summary: "duplicate".to_owned(),
            },
        ],
        evidence_refs: vec!["review:duplicate".to_owned()],
        apply_permitted: false,
        task_promotion_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        ui_apply_permitted: false,
    };

    let diagnostics =
        planning_projection_import_diagnostics(PlanningProjectionImportDiagnosticsInput {
            candidates: vec![blocked_candidate],
            admissions: vec![blocked_admission, duplicate],
            conflicts: Vec::new(),
        });

    assert_eq!(diagnostics.blocked_candidate_count, 1);
    assert_eq!(diagnostics.blocked_admission_count, 1);
    assert_eq!(diagnostics.duplicate_noop_count, 1);
    assert_eq!(diagnostics.blocker_count, 3);
    assert!(diagnostics.apply_blocked);
    assert_bucket(&diagnostics.candidate_status_buckets, "blocked", 1);
    assert_bucket(&diagnostics.admission_status_buckets, "blocked", 1);
    assert_bucket(&diagnostics.admission_status_buckets, "duplicate_noop", 1);
    assert_no_diagnostic_effects(&diagnostics);
}

#[test]
fn planning_projection_import_diagnostics_reports_conflict_buckets_without_payloads() {
    let conflict = PlanningProjectionImportConflictRecord {
        conflict_id: "conflict:artifact:title".to_owned(),
        candidate_id: "candidate:artifact".to_owned(),
        admission_record_id: Some("admission:candidate:artifact".to_owned()),
        file_ref: Some(ManagementProjectionFileRef(
            "nucleus/planning/artifact:title.toml".to_owned(),
        )),
        record_id: Some(ManagementProjectionRecordId("artifact:title".to_owned())),
        record_kind: Some(ManagementProjectionRecordKind::PlanningArtifact),
        kind: PlanningProjectionImportConflictKind::ArtifactTitle,
        summary: "incoming title differs".to_owned(),
        evidence_refs: vec!["conflict:evidence".to_owned()],
        apply_blocked: true,
        resolution_performed: false,
    };

    let diagnostics =
        planning_projection_import_diagnostics(PlanningProjectionImportDiagnosticsInput {
            candidates: Vec::new(),
            admissions: Vec::new(),
            conflicts: vec![conflict],
        });
    let rendered = format!("{diagnostics:?}");

    assert_eq!(diagnostics.conflict_count, 1);
    assert_eq!(diagnostics.blocker_count, 1);
    assert!(diagnostics.apply_blocked);
    assert_bucket(&diagnostics.conflict_kind_buckets, "artifact_title", 1);
    assert!(!diagnostics.raw_payload_retained);
    assert!(!rendered.contains("credential"));
    assert_no_diagnostic_effects(&diagnostics);
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

fn assert_bucket(buckets: &[PlanningProjectionImportDiagnosticBucket], label: &str, count: usize) {
    assert!(buckets
        .iter()
        .any(|bucket| bucket.label == label && bucket.count == count));
}

fn assert_no_diagnostic_effects(diagnostics: &PlanningProjectionImportDiagnostics) {
    assert!(!diagnostics.apply_permitted);
    assert!(!diagnostics.task_promotion_permitted);
    assert!(!diagnostics.provider_execution_permitted);
    assert!(!diagnostics.scm_mutation_permitted);
    assert!(!diagnostics.forge_mutation_permitted);
    assert!(!diagnostics.raw_payload_retained);
    assert!(!diagnostics.ui_apply_permitted);
}
