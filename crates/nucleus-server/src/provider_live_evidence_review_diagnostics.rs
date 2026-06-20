//! Read-only diagnostics for live evidence review decisions.

use serde::{Deserialize, Serialize};

use crate::{
    LiveEvidenceReviewAcceptanceAdmissionRecord, LiveEvidenceReviewAcceptanceAdmissionStatus,
    LiveEvidenceReviewDecision, LiveEvidenceReviewDecisionPersistenceStatus,
    LiveEvidenceReviewDecisionRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceReviewDiagnosticsInput {
    pub admissions: Vec<LiveEvidenceReviewAcceptanceAdmissionRecord>,
    pub decisions: Vec<LiveEvidenceReviewDecisionRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceReviewDiagnosticsRecord {
    pub diagnostics_id: String,
    pub admission_count: usize,
    pub admitted_count: usize,
    pub blocked_admission_count: usize,
    pub decision_count: usize,
    pub persisted_decision_count: usize,
    pub duplicate_decision_count: usize,
    pub accepted_count: usize,
    pub rejected_count: usize,
    pub needs_changes_count: usize,
    pub abandoned_count: usize,
    pub blocked_decision_count: usize,
    pub raw_provider_material_exposed: bool,
    pub client_mutation_authority: bool,
}

pub fn live_evidence_review_diagnostics(
    input: LiveEvidenceReviewDiagnosticsInput,
) -> LiveEvidenceReviewDiagnosticsRecord {
    LiveEvidenceReviewDiagnosticsRecord {
        diagnostics_id: "live-evidence-review-diagnostics".to_owned(),
        admission_count: input.admissions.len(),
        admitted_count: input
            .admissions
            .iter()
            .filter(|admission| {
                admission.status == LiveEvidenceReviewAcceptanceAdmissionStatus::Admitted
            })
            .count(),
        blocked_admission_count: input
            .admissions
            .iter()
            .filter(|admission| {
                admission.status == LiveEvidenceReviewAcceptanceAdmissionStatus::Blocked
            })
            .count(),
        decision_count: input.decisions.len(),
        persisted_decision_count: input
            .decisions
            .iter()
            .filter(|decision| {
                decision.status == LiveEvidenceReviewDecisionPersistenceStatus::Persisted
            })
            .count(),
        duplicate_decision_count: input
            .decisions
            .iter()
            .filter(|decision| {
                decision.status == LiveEvidenceReviewDecisionPersistenceStatus::DuplicateNoop
            })
            .count(),
        accepted_count: input
            .decisions
            .iter()
            .filter(|decision| decision.decision == LiveEvidenceReviewDecision::Accept)
            .count(),
        rejected_count: input
            .decisions
            .iter()
            .filter(|decision| matches!(decision.decision, LiveEvidenceReviewDecision::Reject(_)))
            .count(),
        needs_changes_count: input
            .decisions
            .iter()
            .filter(|decision| {
                matches!(
                    decision.decision,
                    LiveEvidenceReviewDecision::NeedsChanges(_)
                )
            })
            .count(),
        abandoned_count: input
            .decisions
            .iter()
            .filter(|decision| matches!(decision.decision, LiveEvidenceReviewDecision::Abandon(_)))
            .count(),
        blocked_decision_count: input
            .decisions
            .iter()
            .filter(|decision| {
                decision.status == LiveEvidenceReviewDecisionPersistenceStatus::Blocked
            })
            .count(),
        raw_provider_material_exposed: false,
        client_mutation_authority: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_evidence_review_diagnostics_summarize_decisions_without_authority() {
        let diagnostics = live_evidence_review_diagnostics(LiveEvidenceReviewDiagnosticsInput {
            admissions: vec![admission(
                LiveEvidenceReviewAcceptanceAdmissionStatus::Admitted,
            )],
            decisions: vec![decision(
                LiveEvidenceReviewDecisionPersistenceStatus::Persisted,
                LiveEvidenceReviewDecision::Accept,
            )],
        });

        assert_eq!(diagnostics.admitted_count, 1);
        assert_eq!(diagnostics.persisted_decision_count, 1);
        assert_eq!(diagnostics.accepted_count, 1);
        assert!(!diagnostics.raw_provider_material_exposed);
        assert!(!diagnostics.client_mutation_authority);
    }

    #[test]
    fn live_evidence_review_diagnostics_surface_blocked_duplicate_and_outcome_counts() {
        let diagnostics = live_evidence_review_diagnostics(LiveEvidenceReviewDiagnosticsInput {
            admissions: vec![admission(
                LiveEvidenceReviewAcceptanceAdmissionStatus::Blocked,
            )],
            decisions: vec![
                decision(
                    LiveEvidenceReviewDecisionPersistenceStatus::DuplicateNoop,
                    LiveEvidenceReviewDecision::Reject("wrong".to_owned()),
                ),
                decision(
                    LiveEvidenceReviewDecisionPersistenceStatus::Blocked,
                    LiveEvidenceReviewDecision::NeedsChanges("tests".to_owned()),
                ),
                decision(
                    LiveEvidenceReviewDecisionPersistenceStatus::Persisted,
                    LiveEvidenceReviewDecision::Abandon("superseded".to_owned()),
                ),
            ],
        });

        assert_eq!(diagnostics.blocked_admission_count, 1);
        assert_eq!(diagnostics.duplicate_decision_count, 1);
        assert_eq!(diagnostics.blocked_decision_count, 1);
        assert_eq!(diagnostics.rejected_count, 1);
        assert_eq!(diagnostics.needs_changes_count, 1);
        assert_eq!(diagnostics.abandoned_count, 1);
    }

    fn admission(
        status: LiveEvidenceReviewAcceptanceAdmissionStatus,
    ) -> LiveEvidenceReviewAcceptanceAdmissionRecord {
        LiveEvidenceReviewAcceptanceAdmissionRecord {
            admission_id: "admission:1".to_owned(),
            readiness_id: "readiness:1".to_owned(),
            observation_id: "observation:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            status,
            blockers: Vec::new(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:review".to_owned()],
            decision: LiveEvidenceReviewDecision::Accept,
            task_completion_permitted: false,
            provider_write_permitted: false,
            callback_response_permitted: false,
            cancellation_permitted: false,
            resume_permitted: false,
            scm_mutation_permitted: false,
        }
    }

    fn decision(
        status: LiveEvidenceReviewDecisionPersistenceStatus,
        review: LiveEvidenceReviewDecision,
    ) -> LiveEvidenceReviewDecisionRecord {
        LiveEvidenceReviewDecisionRecord {
            decision_id: "decision:1".to_owned(),
            admission_id: "admission:1".to_owned(),
            readiness_id: "readiness:1".to_owned(),
            observation_id: "observation:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            reviewer_ref: "operator:tom".to_owned(),
            decision: review,
            evidence_refs: vec!["evidence:review".to_owned()],
            status,
            blockers: Vec::new(),
            duplicate_decision_detected: false,
            task_completion_permitted: false,
            raw_provider_material_retained: false,
            raw_stream_retained: false,
        }
    }
}
