//! Explicit review-decision admission for live provider evidence readiness.

use serde::{Deserialize, Serialize};

use crate::{LiveProviderEvidenceReviewReadinessRecord, LiveProviderEvidenceReviewReadinessStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceReviewAcceptanceAdmissionInput {
    pub readiness: LiveProviderEvidenceReviewReadinessRecord,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub decision: LiveEvidenceReviewDecision,
    pub task_completion_requested: bool,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub cancellation_requested: bool,
    pub resume_requested: bool,
    pub scm_mutation_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceReviewAcceptanceAdmissionRecord {
    pub admission_id: String,
    pub readiness_id: String,
    pub observation_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub status: LiveEvidenceReviewAcceptanceAdmissionStatus,
    pub blockers: Vec<LiveEvidenceReviewAcceptanceAdmissionBlocker>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub decision: LiveEvidenceReviewDecision,
    pub task_completion_permitted: bool,
    pub provider_write_permitted: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub resume_permitted: bool,
    pub scm_mutation_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceReviewDecision {
    Accept,
    Reject(String),
    NeedsChanges(String),
    Abandon(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceReviewAcceptanceAdmissionStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceReviewAcceptanceAdmissionBlocker {
    ReadinessNotAwaitingExplicitReview,
    OperatorRefMissing,
    EvidenceRefsMissing,
    EmptyEvidenceRef,
    DecisionReasonMissing,
    TaskCompletionRequested,
    ProviderWriteRequested,
    CallbackResponseRequested,
    CancellationRequested,
    ResumeRequested,
    ScmMutationRequested,
}

pub fn live_evidence_review_acceptance_admission(
    input: LiveEvidenceReviewAcceptanceAdmissionInput,
) -> LiveEvidenceReviewAcceptanceAdmissionRecord {
    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        LiveEvidenceReviewAcceptanceAdmissionStatus::Admitted
    } else {
        LiveEvidenceReviewAcceptanceAdmissionStatus::Blocked
    };

    LiveEvidenceReviewAcceptanceAdmissionRecord {
        admission_id: format!(
            "live-evidence-review-admission:{}",
            input.readiness.readiness_id
        ),
        readiness_id: input.readiness.readiness_id,
        observation_id: input.readiness.observation_id,
        task_id: input.readiness.task_id,
        work_item_id: input.readiness.work_item_id,
        status,
        blockers,
        operator_ref: input.operator_ref,
        evidence_refs: unique_sorted(input.evidence_refs),
        decision: input.decision,
        task_completion_permitted: false,
        provider_write_permitted: false,
        callback_response_permitted: false,
        cancellation_permitted: false,
        resume_permitted: false,
        scm_mutation_permitted: false,
    }
}

fn blockers(
    input: &LiveEvidenceReviewAcceptanceAdmissionInput,
) -> Vec<LiveEvidenceReviewAcceptanceAdmissionBlocker> {
    let mut blockers = Vec::new();
    if input.readiness.status != LiveProviderEvidenceReviewReadinessStatus::AwaitingExplicitReview {
        blockers
            .push(LiveEvidenceReviewAcceptanceAdmissionBlocker::ReadinessNotAwaitingExplicitReview);
    }
    if input.operator_ref.trim().is_empty() {
        blockers.push(LiveEvidenceReviewAcceptanceAdmissionBlocker::OperatorRefMissing);
    }
    if input.evidence_refs.is_empty() {
        blockers.push(LiveEvidenceReviewAcceptanceAdmissionBlocker::EvidenceRefsMissing);
    }
    if input
        .evidence_refs
        .iter()
        .any(|evidence_ref| evidence_ref.trim().is_empty())
    {
        blockers.push(LiveEvidenceReviewAcceptanceAdmissionBlocker::EmptyEvidenceRef);
    }
    if decision_reason_missing(&input.decision) {
        blockers.push(LiveEvidenceReviewAcceptanceAdmissionBlocker::DecisionReasonMissing);
    }
    if input.task_completion_requested {
        blockers.push(LiveEvidenceReviewAcceptanceAdmissionBlocker::TaskCompletionRequested);
    }
    if input.provider_write_requested {
        blockers.push(LiveEvidenceReviewAcceptanceAdmissionBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(LiveEvidenceReviewAcceptanceAdmissionBlocker::CallbackResponseRequested);
    }
    if input.cancellation_requested {
        blockers.push(LiveEvidenceReviewAcceptanceAdmissionBlocker::CancellationRequested);
    }
    if input.resume_requested {
        blockers.push(LiveEvidenceReviewAcceptanceAdmissionBlocker::ResumeRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(LiveEvidenceReviewAcceptanceAdmissionBlocker::ScmMutationRequested);
    }
    blockers
}

fn decision_reason_missing(decision: &LiveEvidenceReviewDecision) -> bool {
    match decision {
        LiveEvidenceReviewDecision::Accept => false,
        LiveEvidenceReviewDecision::Reject(reason)
        | LiveEvidenceReviewDecision::NeedsChanges(reason)
        | LiveEvidenceReviewDecision::Abandon(reason) => reason.trim().is_empty(),
    }
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
    fn live_evidence_review_acceptance_admission_accepts_ready_review_with_operator_evidence() {
        let record = live_evidence_review_acceptance_admission(input(readiness()));

        assert_eq!(
            record.status,
            LiveEvidenceReviewAcceptanceAdmissionStatus::Admitted
        );
        assert!(record.blockers.is_empty());
        assert_eq!(record.decision, LiveEvidenceReviewDecision::Accept);
        assert!(!record.task_completion_permitted);
        assert!(!record.provider_write_permitted);
    }

    #[test]
    fn live_evidence_review_acceptance_admission_blocks_not_ready_or_missing_evidence() {
        let mut input = input(not_ready());
        input.operator_ref.clear();
        input.evidence_refs.clear();

        let record = live_evidence_review_acceptance_admission(input);

        assert_eq!(
            record.status,
            LiveEvidenceReviewAcceptanceAdmissionStatus::Blocked
        );
        assert!(record.blockers.contains(
            &LiveEvidenceReviewAcceptanceAdmissionBlocker::ReadinessNotAwaitingExplicitReview
        ));
        assert!(record
            .blockers
            .contains(&LiveEvidenceReviewAcceptanceAdmissionBlocker::OperatorRefMissing));
        assert!(record
            .blockers
            .contains(&LiveEvidenceReviewAcceptanceAdmissionBlocker::EvidenceRefsMissing));
    }

    #[test]
    fn live_evidence_review_acceptance_admission_blocks_widened_authority() {
        let mut input = input(readiness());
        input.task_completion_requested = true;
        input.provider_write_requested = true;
        input.callback_response_requested = true;
        input.cancellation_requested = true;
        input.resume_requested = true;
        input.scm_mutation_requested = true;

        let record = live_evidence_review_acceptance_admission(input);

        assert!(record
            .blockers
            .contains(&LiveEvidenceReviewAcceptanceAdmissionBlocker::TaskCompletionRequested));
        assert!(record
            .blockers
            .contains(&LiveEvidenceReviewAcceptanceAdmissionBlocker::ScmMutationRequested));
        assert!(!record.task_completion_permitted);
        assert!(!record.scm_mutation_permitted);
    }

    #[test]
    fn live_evidence_review_acceptance_admission_requires_decision_reason_when_needed() {
        for decision in [
            LiveEvidenceReviewDecision::Reject(String::new()),
            LiveEvidenceReviewDecision::NeedsChanges(String::new()),
            LiveEvidenceReviewDecision::Abandon(String::new()),
        ] {
            let mut input = input(readiness());
            input.decision = decision;

            let record = live_evidence_review_acceptance_admission(input);

            assert!(record
                .blockers
                .contains(&LiveEvidenceReviewAcceptanceAdmissionBlocker::DecisionReasonMissing));
        }
    }

    fn input(
        readiness: LiveProviderEvidenceReviewReadinessRecord,
    ) -> LiveEvidenceReviewAcceptanceAdmissionInput {
        LiveEvidenceReviewAcceptanceAdmissionInput {
            readiness,
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:review".to_owned()],
            decision: LiveEvidenceReviewDecision::Accept,
            task_completion_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            cancellation_requested: false,
            resume_requested: false,
            scm_mutation_requested: false,
        }
    }

    fn readiness() -> LiveProviderEvidenceReviewReadinessRecord {
        LiveProviderEvidenceReviewReadinessRecord {
            readiness_id: "readiness:1".to_owned(),
            observation_id: "observation:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            evidence_id: "evidence:1".to_owned(),
            status: LiveProviderEvidenceReviewReadinessStatus::AwaitingExplicitReview,
            blockers: Vec::new(),
            runtime_completed: true,
            review_ready: true,
            task_completion_permitted: false,
            review_acceptance_permitted: false,
        }
    }

    fn not_ready() -> LiveProviderEvidenceReviewReadinessRecord {
        LiveProviderEvidenceReviewReadinessRecord {
            status: LiveProviderEvidenceReviewReadinessStatus::NotReady,
            review_ready: false,
            ..readiness()
        }
    }
}
