use std::collections::BTreeMap;

use super::types::{
    PlanningProjectionImportAdmissionRecord, PlanningProjectionImportConflictInput,
    PlanningProjectionImportConflictKind, PlanningProjectionImportConflictRecord,
    PlanningProjectionImportConflictSet, PlanningProjectionImportConflictStagingRequest,
    PlanningProjectionImportScanCandidate,
};

pub fn stage_planning_projection_import_conflicts(
    request: PlanningProjectionImportConflictStagingRequest,
) -> PlanningProjectionImportConflictSet {
    let candidates = request
        .candidates
        .into_iter()
        .map(|candidate| (candidate.candidate_id.clone(), candidate))
        .collect::<BTreeMap<_, _>>();
    let admissions = request
        .admissions
        .into_iter()
        .map(|admission| (admission.candidate_id.clone(), admission))
        .collect::<BTreeMap<_, _>>();
    let mut missing_candidate_ref_count = 0;
    let mut missing_admission_ref_count = 0;
    let mut inputs = request.conflict_inputs;
    inputs.sort_by(|left, right| {
        left.candidate_id
            .cmp(&right.candidate_id)
            .then_with(|| conflict_kind_label(&left.kind).cmp(conflict_kind_label(&right.kind)))
            .then_with(|| left.summary.cmp(&right.summary))
    });
    let conflicts = inputs
        .into_iter()
        .map(|input| {
            let candidate = candidates.get(&input.candidate_id);
            let admission = admissions.get(&input.candidate_id);
            if candidate.is_none() {
                missing_candidate_ref_count += 1;
            }
            if admission.is_none() {
                missing_admission_ref_count += 1;
            }
            conflict_record(&request.staging_id, input, candidate, admission)
        })
        .collect::<Vec<_>>();

    PlanningProjectionImportConflictSet {
        staging_id: request.staging_id,
        conflict_count: conflicts.len(),
        missing_candidate_ref_count,
        missing_admission_ref_count,
        apply_blocked: !conflicts.is_empty(),
        conflicts,
        conflict_resolution_performed: false,
        active_planning_mutation_performed: false,
        task_creation_performed: false,
        task_promotion_performed: false,
        agent_scheduling_performed: false,
        provider_execution_performed: false,
        scm_mutation_performed: false,
        forge_mutation_performed: false,
        raw_payload_retained: false,
        ui_apply_triggered: false,
    }
}

fn conflict_record(
    staging_id: &str,
    input: PlanningProjectionImportConflictInput,
    candidate: Option<&PlanningProjectionImportScanCandidate>,
    admission: Option<&PlanningProjectionImportAdmissionRecord>,
) -> PlanningProjectionImportConflictRecord {
    let mut evidence_refs = input.evidence_refs;
    if let Some(candidate) = candidate {
        evidence_refs.extend(candidate.evidence_refs.iter().cloned());
    }
    if let Some(admission) = admission {
        evidence_refs.extend(admission.evidence_refs.iter().cloned());
    }
    evidence_refs.sort();
    evidence_refs.dedup();
    let kind_label = conflict_kind_label(&input.kind);

    PlanningProjectionImportConflictRecord {
        conflict_id: format!("{staging_id}:{}:{kind_label}", input.candidate_id),
        admission_record_id: admission.map(|record| record.admission_record_id.clone()),
        file_ref: candidate
            .map(|candidate| candidate.file_ref.clone())
            .or_else(|| admission.map(|record| record.file_ref.clone())),
        record_id: candidate
            .and_then(|candidate| candidate.record_id.clone())
            .or_else(|| admission.and_then(|record| record.record_id.clone())),
        record_kind: candidate
            .and_then(|candidate| candidate.record_kind.clone())
            .or_else(|| admission.and_then(|record| record.record_kind.clone())),
        candidate_id: input.candidate_id,
        kind: input.kind,
        summary: input.summary,
        evidence_refs,
        apply_blocked: true,
        resolution_performed: false,
    }
}

fn conflict_kind_label(kind: &PlanningProjectionImportConflictKind) -> &str {
    match kind {
        PlanningProjectionImportConflictKind::ArtifactTitle => "artifact_title",
        PlanningProjectionImportConflictKind::ArtifactBody => "artifact_body",
        PlanningProjectionImportConflictKind::ReviewState => "review_state",
        PlanningProjectionImportConflictKind::Lineage => "lineage",
        PlanningProjectionImportConflictKind::DuplicateTaskSeedId => "duplicate_task_seed_id",
        PlanningProjectionImportConflictKind::TaskSeedPromotionState => "task_seed_promotion_state",
        PlanningProjectionImportConflictKind::MissingSourceRef => "missing_source_ref",
        PlanningProjectionImportConflictKind::Custom(value) => value.as_str(),
    }
}
