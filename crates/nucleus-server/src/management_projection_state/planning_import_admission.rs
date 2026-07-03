use std::collections::BTreeSet;

use super::types::{
    PlanningProjectionImportAdmissionBlocker, PlanningProjectionImportAdmissionRecord,
    PlanningProjectionImportAdmissionRequest, PlanningProjectionImportAdmissionSet,
    PlanningProjectionImportAdmissionStatus, PlanningProjectionImportScanCandidate,
    PlanningProjectionImportScanCandidateStatus,
};

pub fn admit_planning_projection_import_candidates(
    request: PlanningProjectionImportAdmissionRequest,
) -> PlanningProjectionImportAdmissionSet {
    let reviewed = request
        .reviewed_candidate_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let conflicting = request
        .conflicting_candidate_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut seen_file_refs = BTreeSet::new();
    let mut candidates = request.candidates;
    candidates.sort_by(|left, right| {
        left.file_ref
            .0
            .cmp(&right.file_ref.0)
            .then_with(|| left.candidate_id.cmp(&right.candidate_id))
    });
    let records = candidates
        .into_iter()
        .map(|candidate| {
            let duplicate = !seen_file_refs.insert(candidate.file_ref.0.clone());
            admission_record(
                &request.admission_id,
                candidate,
                &reviewed,
                &conflicting,
                duplicate,
                &request.review_evidence_refs,
            )
        })
        .collect();

    PlanningProjectionImportAdmissionSet {
        admission_id: request.admission_id,
        records,
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

fn admission_record(
    admission_id: &str,
    candidate: PlanningProjectionImportScanCandidate,
    reviewed: &BTreeSet<String>,
    conflicting: &BTreeSet<String>,
    duplicate: bool,
    review_evidence_refs: &[String],
) -> PlanningProjectionImportAdmissionRecord {
    let blockers = blockers_for(&candidate, reviewed, conflicting, duplicate);
    let status = if duplicate {
        PlanningProjectionImportAdmissionStatus::DuplicateNoop
    } else if blockers.is_empty() {
        PlanningProjectionImportAdmissionStatus::AdmittedStopped
    } else {
        PlanningProjectionImportAdmissionStatus::Blocked
    };
    let mut evidence_refs = candidate.evidence_refs.clone();
    evidence_refs.extend(review_evidence_refs.iter().cloned());
    evidence_refs.sort();
    evidence_refs.dedup();

    PlanningProjectionImportAdmissionRecord {
        admission_record_id: format!("{admission_id}:{}", candidate.candidate_id),
        candidate_id: candidate.candidate_id,
        file_ref: candidate.file_ref,
        record_id: candidate.record_id,
        record_kind: candidate.record_kind,
        status,
        blockers,
        evidence_refs,
        apply_permitted: false,
        task_promotion_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        ui_apply_permitted: false,
    }
}

fn blockers_for(
    candidate: &PlanningProjectionImportScanCandidate,
    reviewed: &BTreeSet<String>,
    conflicting: &BTreeSet<String>,
    duplicate: bool,
) -> Vec<PlanningProjectionImportAdmissionBlocker> {
    let mut blockers = Vec::new();
    if candidate.status != PlanningProjectionImportScanCandidateStatus::Ready {
        blockers.push(PlanningProjectionImportAdmissionBlocker::CandidateBlocked {
            summary: "candidate scan did not produce a ready planning projection import candidate"
                .to_owned(),
        });
    }
    if !reviewed.contains(&candidate.candidate_id) {
        blockers.push(
            PlanningProjectionImportAdmissionBlocker::UnreviewedCandidate {
                summary: "candidate must be reviewed before stopped import admission".to_owned(),
            },
        );
    }
    if conflicting.contains(&candidate.candidate_id) {
        blockers.push(PlanningProjectionImportAdmissionBlocker::ConflictStaged {
            summary: "candidate has a staged semantic conflict".to_owned(),
        });
    }
    if duplicate {
        blockers.push(
            PlanningProjectionImportAdmissionBlocker::DuplicateCandidate {
                summary: "candidate targets a file ref already represented in this admission set"
                    .to_owned(),
            },
        );
    }
    if candidate.record_id.is_none() {
        blockers.push(PlanningProjectionImportAdmissionBlocker::MissingRecordId {
            summary: "candidate must expose a record id before stopped import admission".to_owned(),
        });
    }
    blockers
}
