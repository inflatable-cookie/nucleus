use std::collections::{BTreeMap, BTreeSet};

use super::types::{
    PlanningProjectionImportAdmissionRecord, PlanningProjectionImportAdmissionStatus,
    PlanningProjectionImportConflictKind, PlanningProjectionImportConflictRecord,
    PlanningProjectionImportDiagnosticBucket, PlanningProjectionImportDiagnostics,
    PlanningProjectionImportDiagnosticsInput, PlanningProjectionImportScanCandidate,
    PlanningProjectionImportScanCandidateStatus,
};

pub fn planning_projection_import_diagnostics(
    input: PlanningProjectionImportDiagnosticsInput,
) -> PlanningProjectionImportDiagnostics {
    let candidate_status_buckets =
        candidate_status_buckets(input.candidates.iter().collect::<Vec<_>>());
    let admission_status_buckets =
        admission_status_buckets(input.admissions.iter().collect::<Vec<_>>());
    let conflict_kind_buckets = conflict_kind_buckets(input.conflicts.iter().collect::<Vec<_>>());
    let blocker_count = candidate_blocker_count(&input.candidates)
        + admission_blocker_count(&input.admissions)
        + input.conflicts.len();
    let evidence_ref_count = evidence_ref_count(&input);
    let apply_blocked =
        input.admissions.iter().any(|record| {
            record.status != PlanningProjectionImportAdmissionStatus::AdmittedStopped
        }) || input
            .conflicts
            .iter()
            .any(|conflict| conflict.apply_blocked);

    PlanningProjectionImportDiagnostics {
        diagnostics_id: "planning-projection-import-diagnostics".to_owned(),
        candidate_count: input.candidates.len(),
        ready_candidate_count: input
            .candidates
            .iter()
            .filter(|candidate| {
                candidate.status == PlanningProjectionImportScanCandidateStatus::Ready
            })
            .count(),
        blocked_candidate_count: input
            .candidates
            .iter()
            .filter(|candidate| {
                candidate.status == PlanningProjectionImportScanCandidateStatus::Blocked
            })
            .count(),
        admission_count: input.admissions.len(),
        admitted_stopped_count: input
            .admissions
            .iter()
            .filter(|record| {
                record.status == PlanningProjectionImportAdmissionStatus::AdmittedStopped
            })
            .count(),
        duplicate_noop_count: input
            .admissions
            .iter()
            .filter(|record| {
                record.status == PlanningProjectionImportAdmissionStatus::DuplicateNoop
            })
            .count(),
        blocked_admission_count: input
            .admissions
            .iter()
            .filter(|record| record.status == PlanningProjectionImportAdmissionStatus::Blocked)
            .count(),
        conflict_count: input.conflicts.len(),
        blocker_count,
        evidence_ref_count,
        candidate_status_buckets,
        admission_status_buckets,
        conflict_kind_buckets,
        apply_blocked,
        apply_permitted: false,
        task_promotion_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        raw_payload_retained: false,
        ui_apply_permitted: false,
    }
}

fn candidate_status_buckets(
    candidates: Vec<&PlanningProjectionImportScanCandidate>,
) -> Vec<PlanningProjectionImportDiagnosticBucket> {
    let mut counts = BTreeMap::new();
    for candidate in candidates {
        *counts
            .entry(candidate_status_label(&candidate.status))
            .or_insert(0) += 1;
    }
    buckets(counts)
}

fn admission_status_buckets(
    admissions: Vec<&PlanningProjectionImportAdmissionRecord>,
) -> Vec<PlanningProjectionImportDiagnosticBucket> {
    let mut counts = BTreeMap::new();
    for admission in admissions {
        *counts
            .entry(admission_status_label(&admission.status))
            .or_insert(0) += 1;
    }
    buckets(counts)
}

fn conflict_kind_buckets(
    conflicts: Vec<&PlanningProjectionImportConflictRecord>,
) -> Vec<PlanningProjectionImportDiagnosticBucket> {
    let mut counts = BTreeMap::new();
    for conflict in conflicts {
        *counts
            .entry(conflict_kind_label(&conflict.kind).to_owned())
            .or_insert(0) += 1;
    }
    buckets(counts)
}

fn buckets(counts: BTreeMap<String, usize>) -> Vec<PlanningProjectionImportDiagnosticBucket> {
    counts
        .into_iter()
        .map(|(label, count)| PlanningProjectionImportDiagnosticBucket { label, count })
        .collect()
}

fn candidate_blocker_count(candidates: &[PlanningProjectionImportScanCandidate]) -> usize {
    candidates
        .iter()
        .map(|candidate| candidate.blockers.len())
        .sum()
}

fn admission_blocker_count(admissions: &[PlanningProjectionImportAdmissionRecord]) -> usize {
    admissions
        .iter()
        .map(|admission| admission.blockers.len())
        .sum()
}

fn evidence_ref_count(input: &PlanningProjectionImportDiagnosticsInput) -> usize {
    let mut refs = BTreeSet::new();
    for candidate in &input.candidates {
        refs.extend(candidate.evidence_refs.iter().cloned());
    }
    for admission in &input.admissions {
        refs.extend(admission.evidence_refs.iter().cloned());
    }
    for conflict in &input.conflicts {
        refs.extend(conflict.evidence_refs.iter().cloned());
    }
    refs.len()
}

fn candidate_status_label(status: &PlanningProjectionImportScanCandidateStatus) -> String {
    match status {
        PlanningProjectionImportScanCandidateStatus::Ready => "ready".to_owned(),
        PlanningProjectionImportScanCandidateStatus::Blocked => "blocked".to_owned(),
    }
}

fn admission_status_label(status: &PlanningProjectionImportAdmissionStatus) -> String {
    match status {
        PlanningProjectionImportAdmissionStatus::AdmittedStopped => "admitted_stopped".to_owned(),
        PlanningProjectionImportAdmissionStatus::DuplicateNoop => "duplicate_noop".to_owned(),
        PlanningProjectionImportAdmissionStatus::Blocked => "blocked".to_owned(),
    }
}

fn conflict_kind_label(kind: &PlanningProjectionImportConflictKind) -> String {
    match kind {
        PlanningProjectionImportConflictKind::ArtifactTitle => "artifact_title".to_owned(),
        PlanningProjectionImportConflictKind::ArtifactBody => "artifact_body".to_owned(),
        PlanningProjectionImportConflictKind::ReviewState => "review_state".to_owned(),
        PlanningProjectionImportConflictKind::Lineage => "lineage".to_owned(),
        PlanningProjectionImportConflictKind::DuplicateTaskSeedId => {
            "duplicate_task_seed_id".to_owned()
        }
        PlanningProjectionImportConflictKind::TaskSeedPromotionState => {
            "task_seed_promotion_state".to_owned()
        }
        PlanningProjectionImportConflictKind::MissingSourceRef => "missing_source_ref".to_owned(),
        PlanningProjectionImportConflictKind::Custom(value) => format!("custom:{value}"),
    }
}
