//! Preparation candidates from persisted completion SCM capture admissions.

use serde::{Deserialize, Serialize};

use crate::{
    CompletionScmCaptureAdmissionPersistenceRecord, CompletionScmCaptureAdmissionPersistenceStatus,
    CompletionScmCaptureAdmissionStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionScmCapturePreparationCandidatesInput {
    pub admissions: Vec<CompletionScmCaptureAdmissionPersistenceRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmCapturePreparationCandidatesRecord {
    pub projection_id: String,
    pub candidates: Vec<CompletionScmCapturePreparationCandidate>,
    pub skipped_admission_ids: Vec<String>,
    pub scm_capture_authority_granted: bool,
    pub scm_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_material_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CompletionScmCapturePreparationCandidate {
    pub preparation_candidate_id: String,
    pub persisted_admission_id: String,
    pub admission_id: String,
    pub readiness_id: String,
    pub candidate_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
}

pub fn completion_scm_capture_preparation_candidates(
    input: CompletionScmCapturePreparationCandidatesInput,
) -> CompletionScmCapturePreparationCandidatesRecord {
    let mut candidates = Vec::new();
    let mut skipped_admission_ids = Vec::new();

    for admission in input.admissions {
        if eligible(&admission) {
            candidates.push(CompletionScmCapturePreparationCandidate {
                preparation_candidate_id: format!(
                    "completion-scm-capture-preparation:{}",
                    admission.admission_id
                ),
                persisted_admission_id: admission.persisted_admission_id,
                admission_id: admission.admission_id,
                readiness_id: admission.readiness_id,
                candidate_id: admission.candidate_id,
                task_id: admission.task_id,
                work_item_id: admission.work_item_id,
                completion_id: admission.completion_id,
                operator_ref: admission.operator_ref,
                evidence_refs: unique_sorted(admission.evidence_refs),
            });
        } else {
            skipped_admission_ids.push(admission.admission_id);
        }
    }

    candidates.sort_by(|left, right| {
        left.preparation_candidate_id
            .cmp(&right.preparation_candidate_id)
    });
    skipped_admission_ids.sort();
    skipped_admission_ids.dedup();

    CompletionScmCapturePreparationCandidatesRecord {
        projection_id: "completion-scm-capture-preparation-candidates".to_owned(),
        candidates,
        skipped_admission_ids,
        scm_capture_authority_granted: false,
        scm_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_material_exposed: false,
    }
}

fn eligible(admission: &CompletionScmCaptureAdmissionPersistenceRecord) -> bool {
    admission.status == CompletionScmCaptureAdmissionPersistenceStatus::Persisted
        && admission.admission_status == CompletionScmCaptureAdmissionStatus::Admitted
        && admission.blockers.is_empty()
        && admission.admission_blockers.is_empty()
        && !admission.scm_capture_permitted
        && !admission.scm_publish_permitted
        && !admission.forge_change_request_permitted
        && !admission.forge_merge_permitted
        && !admission.provider_write_permitted
        && !admission.raw_material_retained
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_scm_capture_preparation_candidates_project_accepted_admissions() {
        let record = completion_scm_capture_preparation_candidates(input(vec![admission(
            "accepted",
            CompletionScmCaptureAdmissionPersistenceStatus::Persisted,
            CompletionScmCaptureAdmissionStatus::Admitted,
        )]));

        assert_eq!(record.candidates.len(), 1);
        assert_eq!(record.candidates[0].task_id, "task:1");
        assert_eq!(
            record.candidates[0].evidence_refs,
            vec!["evidence:a".to_owned(), "evidence:b".to_owned()]
        );
        assert!(!record.scm_capture_authority_granted);
        assert!(!record.forge_authority_granted);
    }

    #[test]
    fn completion_scm_capture_preparation_candidates_skip_blocked_admissions() {
        let record = completion_scm_capture_preparation_candidates(input(vec![
            admission(
                "blocked",
                CompletionScmCaptureAdmissionPersistenceStatus::Persisted,
                CompletionScmCaptureAdmissionStatus::Blocked,
            ),
            admission(
                "persistence-blocked",
                CompletionScmCaptureAdmissionPersistenceStatus::Blocked,
                CompletionScmCaptureAdmissionStatus::Admitted,
            ),
        ]));

        assert!(record.candidates.is_empty());
        assert_eq!(
            record.skipped_admission_ids,
            vec![
                "admission:blocked".to_owned(),
                "admission:persistence-blocked".to_owned()
            ]
        );
    }

    fn input(
        admissions: Vec<CompletionScmCaptureAdmissionPersistenceRecord>,
    ) -> CompletionScmCapturePreparationCandidatesInput {
        CompletionScmCapturePreparationCandidatesInput { admissions }
    }

    fn admission(
        id: &str,
        status: CompletionScmCaptureAdmissionPersistenceStatus,
        admission_status: CompletionScmCaptureAdmissionStatus,
    ) -> CompletionScmCaptureAdmissionPersistenceRecord {
        CompletionScmCaptureAdmissionPersistenceRecord {
            persisted_admission_id: format!("persisted:{id}"),
            admission_id: format!("admission:{id}"),
            request_id: format!("request:{id}"),
            readiness_id: format!("readiness:{id}"),
            candidate_id: format!("candidate:{id}"),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec![
                "evidence:b".to_owned(),
                "evidence:a".to_owned(),
                "evidence:a".to_owned(),
            ],
            admission_status,
            status,
            blockers: Vec::new(),
            admission_blockers: Vec::new(),
            duplicate_admission_detected: false,
            scm_capture_permitted: false,
            scm_publish_permitted: false,
            forge_change_request_permitted: false,
            forge_merge_permitted: false,
            provider_write_permitted: false,
            callback_response_permitted: false,
            interruption_permitted: false,
            recovery_permitted: false,
            raw_material_retained: false,
        }
    }
}
