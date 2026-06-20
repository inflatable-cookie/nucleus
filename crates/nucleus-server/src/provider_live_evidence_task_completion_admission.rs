//! Explicit task-completion admission from accepted live evidence review decisions.

use serde::{Deserialize, Serialize};

use crate::{
    LiveEvidenceReviewDecision, LiveEvidenceReviewDecisionPersistenceStatus,
    LiveEvidenceReviewDecisionRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceTaskCompletionAdmissionInput {
    pub review_decision: LiveEvidenceReviewDecisionRecord,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub provider_write_requested: bool,
    pub callback_response_requested: bool,
    pub cancellation_requested: bool,
    pub resume_requested: bool,
    pub scm_mutation_requested: bool,
    pub raw_provider_material_requested: bool,
    pub raw_stream_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceTaskCompletionAdmissionRecord {
    pub admission_id: String,
    pub review_decision_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub status: LiveEvidenceTaskCompletionAdmissionStatus,
    pub blockers: Vec<LiveEvidenceTaskCompletionAdmissionBlocker>,
    pub task_completion_admitted: bool,
    pub provider_write_permitted: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub resume_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub raw_provider_material_retained: bool,
    pub raw_stream_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceTaskCompletionAdmissionStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceTaskCompletionAdmissionBlocker {
    ReviewDecisionNotPersisted,
    ReviewDecisionNotAccepted,
    OperatorRefMissing,
    EvidenceRefsMissing,
    EmptyEvidenceRef,
    ProviderWriteRequested,
    CallbackResponseRequested,
    CancellationRequested,
    ResumeRequested,
    ScmMutationRequested,
    RawProviderMaterialRequested,
    RawStreamRequested,
}

pub fn live_evidence_task_completion_admission(
    input: LiveEvidenceTaskCompletionAdmissionInput,
) -> LiveEvidenceTaskCompletionAdmissionRecord {
    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        LiveEvidenceTaskCompletionAdmissionStatus::Admitted
    } else {
        LiveEvidenceTaskCompletionAdmissionStatus::Blocked
    };
    let task_completion_admitted = status == LiveEvidenceTaskCompletionAdmissionStatus::Admitted;

    LiveEvidenceTaskCompletionAdmissionRecord {
        admission_id: format!(
            "live-evidence-task-completion-admission:{}",
            input.review_decision.decision_id
        ),
        review_decision_id: input.review_decision.decision_id,
        task_id: input.review_decision.task_id,
        work_item_id: input.review_decision.work_item_id,
        operator_ref: input.operator_ref,
        evidence_refs: unique_sorted(input.evidence_refs),
        status,
        blockers,
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

fn blockers(
    input: &LiveEvidenceTaskCompletionAdmissionInput,
) -> Vec<LiveEvidenceTaskCompletionAdmissionBlocker> {
    let mut blockers = Vec::new();
    if input.review_decision.status != LiveEvidenceReviewDecisionPersistenceStatus::Persisted {
        blockers.push(LiveEvidenceTaskCompletionAdmissionBlocker::ReviewDecisionNotPersisted);
    }
    if input.review_decision.decision != LiveEvidenceReviewDecision::Accept {
        blockers.push(LiveEvidenceTaskCompletionAdmissionBlocker::ReviewDecisionNotAccepted);
    }
    if input.operator_ref.trim().is_empty() {
        blockers.push(LiveEvidenceTaskCompletionAdmissionBlocker::OperatorRefMissing);
    }
    if input.evidence_refs.is_empty() {
        blockers.push(LiveEvidenceTaskCompletionAdmissionBlocker::EvidenceRefsMissing);
    }
    if input
        .evidence_refs
        .iter()
        .any(|evidence_ref| evidence_ref.trim().is_empty())
    {
        blockers.push(LiveEvidenceTaskCompletionAdmissionBlocker::EmptyEvidenceRef);
    }
    if input.provider_write_requested {
        blockers.push(LiveEvidenceTaskCompletionAdmissionBlocker::ProviderWriteRequested);
    }
    if input.callback_response_requested {
        blockers.push(LiveEvidenceTaskCompletionAdmissionBlocker::CallbackResponseRequested);
    }
    if input.cancellation_requested {
        blockers.push(LiveEvidenceTaskCompletionAdmissionBlocker::CancellationRequested);
    }
    if input.resume_requested {
        blockers.push(LiveEvidenceTaskCompletionAdmissionBlocker::ResumeRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(LiveEvidenceTaskCompletionAdmissionBlocker::ScmMutationRequested);
    }
    if input.raw_provider_material_requested {
        blockers.push(LiveEvidenceTaskCompletionAdmissionBlocker::RawProviderMaterialRequested);
    }
    if input.raw_stream_requested {
        blockers.push(LiveEvidenceTaskCompletionAdmissionBlocker::RawStreamRequested);
    }
    blockers
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LiveEvidenceReviewDecisionPersistenceBlocker;

    #[test]
    fn live_evidence_task_completion_admission_accepts_persisted_accepted_review() {
        let record = live_evidence_task_completion_admission(input(review_decision(
            LiveEvidenceReviewDecisionPersistenceStatus::Persisted,
            LiveEvidenceReviewDecision::Accept,
        )));

        assert_eq!(
            record.status,
            LiveEvidenceTaskCompletionAdmissionStatus::Admitted
        );
        assert!(record.task_completion_admitted);
        assert!(!record.provider_write_permitted);
        assert!(!record.scm_mutation_permitted);
    }

    #[test]
    fn live_evidence_task_completion_admission_blocks_non_accepted_or_unpersisted_reviews() {
        for decision in [
            LiveEvidenceReviewDecision::Reject("wrong".to_owned()),
            LiveEvidenceReviewDecision::NeedsChanges("tests".to_owned()),
            LiveEvidenceReviewDecision::Abandon("superseded".to_owned()),
        ] {
            let record = live_evidence_task_completion_admission(input(review_decision(
                LiveEvidenceReviewDecisionPersistenceStatus::Persisted,
                decision,
            )));

            assert_eq!(
                record.status,
                LiveEvidenceTaskCompletionAdmissionStatus::Blocked
            );
            assert!(record
                .blockers
                .contains(&LiveEvidenceTaskCompletionAdmissionBlocker::ReviewDecisionNotAccepted));
            assert!(!record.task_completion_admitted);
        }

        let record = live_evidence_task_completion_admission(input(review_decision(
            LiveEvidenceReviewDecisionPersistenceStatus::DuplicateNoop,
            LiveEvidenceReviewDecision::Accept,
        )));

        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskCompletionAdmissionBlocker::ReviewDecisionNotPersisted));
    }

    #[test]
    fn live_evidence_task_completion_admission_blocks_missing_operator_or_evidence() {
        let mut input = input(review_decision(
            LiveEvidenceReviewDecisionPersistenceStatus::Persisted,
            LiveEvidenceReviewDecision::Accept,
        ));
        input.operator_ref.clear();
        input.evidence_refs.clear();

        let record = live_evidence_task_completion_admission(input);

        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskCompletionAdmissionBlocker::OperatorRefMissing));
        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskCompletionAdmissionBlocker::EvidenceRefsMissing));
    }

    #[test]
    fn live_evidence_task_completion_authority_blocks_provider_and_raw_widening() {
        let mut input = input(review_decision(
            LiveEvidenceReviewDecisionPersistenceStatus::Persisted,
            LiveEvidenceReviewDecision::Accept,
        ));
        input.provider_write_requested = true;
        input.callback_response_requested = true;
        input.cancellation_requested = true;
        input.resume_requested = true;
        input.scm_mutation_requested = true;
        input.raw_provider_material_requested = true;
        input.raw_stream_requested = true;

        let record = live_evidence_task_completion_admission(input);

        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskCompletionAdmissionBlocker::ProviderWriteRequested));
        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskCompletionAdmissionBlocker::ScmMutationRequested));
        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskCompletionAdmissionBlocker::RawProviderMaterialRequested));
        assert!(!record.task_completion_admitted);
        assert!(!record.provider_write_permitted);
        assert!(!record.raw_provider_material_retained);
    }

    fn input(
        review_decision: LiveEvidenceReviewDecisionRecord,
    ) -> LiveEvidenceTaskCompletionAdmissionInput {
        LiveEvidenceTaskCompletionAdmissionInput {
            review_decision,
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:completion".to_owned()],
            provider_write_requested: false,
            callback_response_requested: false,
            cancellation_requested: false,
            resume_requested: false,
            scm_mutation_requested: false,
            raw_provider_material_requested: false,
            raw_stream_requested: false,
        }
    }

    fn review_decision(
        status: LiveEvidenceReviewDecisionPersistenceStatus,
        decision: LiveEvidenceReviewDecision,
    ) -> LiveEvidenceReviewDecisionRecord {
        LiveEvidenceReviewDecisionRecord {
            decision_id: "decision:1".to_owned(),
            admission_id: "review-admission:1".to_owned(),
            readiness_id: "readiness:1".to_owned(),
            observation_id: "observation:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            reviewer_ref: "operator:tom".to_owned(),
            decision,
            evidence_refs: vec!["evidence:review".to_owned()],
            status,
            blockers: Vec::<LiveEvidenceReviewDecisionPersistenceBlocker>::new(),
            duplicate_decision_detected: false,
            task_completion_permitted: false,
            raw_provider_material_retained: false,
            raw_stream_retained: false,
        }
    }
}
