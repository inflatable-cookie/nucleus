//! Read-only diagnostics for explicit live evidence task completion.

use serde::{Deserialize, Serialize};

use crate::{
    LiveEvidenceTaskCompletionAdmissionRecord, LiveEvidenceTaskCompletionAdmissionStatus,
    LiveEvidenceTaskCompletionPersistenceStatus, LiveEvidenceTaskCompletionRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceTaskCompletionDiagnosticsInput {
    pub admissions: Vec<LiveEvidenceTaskCompletionAdmissionRecord>,
    pub completions: Vec<LiveEvidenceTaskCompletionRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceTaskCompletionDiagnosticsRecord {
    pub diagnostics_id: String,
    pub admission_count: usize,
    pub admitted_count: usize,
    pub blocked_admission_count: usize,
    pub completion_count: usize,
    pub persisted_completion_count: usize,
    pub duplicate_completion_count: usize,
    pub blocked_completion_count: usize,
    pub completed_task_count: usize,
    pub provider_authority_granted: bool,
    pub scm_authority_granted: bool,
    pub raw_provider_material_exposed: bool,
    pub client_mutation_authority: bool,
}

pub fn live_evidence_task_completion_diagnostics(
    input: LiveEvidenceTaskCompletionDiagnosticsInput,
) -> LiveEvidenceTaskCompletionDiagnosticsRecord {
    LiveEvidenceTaskCompletionDiagnosticsRecord {
        diagnostics_id: "live-evidence-task-completion-diagnostics".to_owned(),
        admission_count: input.admissions.len(),
        admitted_count: input
            .admissions
            .iter()
            .filter(|admission| {
                admission.status == LiveEvidenceTaskCompletionAdmissionStatus::Admitted
            })
            .count(),
        blocked_admission_count: input
            .admissions
            .iter()
            .filter(|admission| {
                admission.status == LiveEvidenceTaskCompletionAdmissionStatus::Blocked
            })
            .count(),
        completion_count: input.completions.len(),
        persisted_completion_count: input
            .completions
            .iter()
            .filter(|completion| {
                completion.status == LiveEvidenceTaskCompletionPersistenceStatus::Persisted
            })
            .count(),
        duplicate_completion_count: input
            .completions
            .iter()
            .filter(|completion| {
                completion.status == LiveEvidenceTaskCompletionPersistenceStatus::DuplicateNoop
            })
            .count(),
        blocked_completion_count: input
            .completions
            .iter()
            .filter(|completion| {
                completion.status == LiveEvidenceTaskCompletionPersistenceStatus::Blocked
            })
            .count(),
        completed_task_count: input
            .completions
            .iter()
            .filter(|completion| completion.task_completed)
            .count(),
        provider_authority_granted: false,
        scm_authority_granted: false,
        raw_provider_material_exposed: false,
        client_mutation_authority: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        LiveEvidenceTaskCompletionAdmissionBlocker, LiveEvidenceTaskCompletionPersistenceBlocker,
    };

    #[test]
    fn live_evidence_task_completion_diagnostics_summarize_completion_without_authority() {
        let diagnostics =
            live_evidence_task_completion_diagnostics(LiveEvidenceTaskCompletionDiagnosticsInput {
                admissions: vec![admission(
                    LiveEvidenceTaskCompletionAdmissionStatus::Admitted,
                )],
                completions: vec![completion(
                    LiveEvidenceTaskCompletionPersistenceStatus::Persisted,
                    true,
                )],
            });

        assert_eq!(diagnostics.admitted_count, 1);
        assert_eq!(diagnostics.persisted_completion_count, 1);
        assert_eq!(diagnostics.completed_task_count, 1);
        assert!(!diagnostics.provider_authority_granted);
        assert!(!diagnostics.scm_authority_granted);
        assert!(!diagnostics.raw_provider_material_exposed);
    }

    #[test]
    fn live_evidence_task_completion_diagnostics_surface_blocked_and_duplicate_states() {
        let diagnostics =
            live_evidence_task_completion_diagnostics(LiveEvidenceTaskCompletionDiagnosticsInput {
                admissions: vec![admission(
                    LiveEvidenceTaskCompletionAdmissionStatus::Blocked,
                )],
                completions: vec![
                    completion(
                        LiveEvidenceTaskCompletionPersistenceStatus::DuplicateNoop,
                        false,
                    ),
                    completion(LiveEvidenceTaskCompletionPersistenceStatus::Blocked, false),
                ],
            });

        assert_eq!(diagnostics.blocked_admission_count, 1);
        assert_eq!(diagnostics.duplicate_completion_count, 1);
        assert_eq!(diagnostics.blocked_completion_count, 1);
        assert_eq!(diagnostics.completed_task_count, 0);
    }

    fn admission(
        status: LiveEvidenceTaskCompletionAdmissionStatus,
    ) -> LiveEvidenceTaskCompletionAdmissionRecord {
        let task_completion_admitted =
            status == LiveEvidenceTaskCompletionAdmissionStatus::Admitted;
        LiveEvidenceTaskCompletionAdmissionRecord {
            admission_id: "completion-admission:1".to_owned(),
            review_decision_id: "review-decision:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:completion".to_owned()],
            status,
            blockers: Vec::<LiveEvidenceTaskCompletionAdmissionBlocker>::new(),
            task_completion_admitted,
            provider_write_permitted: false,
            callback_response_permitted: false,
            cancellation_permitted: false,
            resume_permitted: false,
            scm_mutation_permitted: false,
            raw_provider_material_retained: false,
            raw_stream_retained: false,
        }
    }

    fn completion(
        status: LiveEvidenceTaskCompletionPersistenceStatus,
        task_completed: bool,
    ) -> LiveEvidenceTaskCompletionRecord {
        LiveEvidenceTaskCompletionRecord {
            completion_id: "completion:1".to_owned(),
            admission_id: "completion-admission:1".to_owned(),
            review_decision_id: "review-decision:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:completion".to_owned()],
            status,
            blockers: Vec::<LiveEvidenceTaskCompletionPersistenceBlocker>::new(),
            duplicate_completion_detected: false,
            task_completed,
            provider_write_permitted: false,
            callback_response_permitted: false,
            cancellation_permitted: false,
            resume_permitted: false,
            scm_mutation_permitted: false,
            raw_provider_material_retained: false,
            raw_stream_retained: false,
        }
    }
}
