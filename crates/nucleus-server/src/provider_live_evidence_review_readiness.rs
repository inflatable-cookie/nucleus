//! Review-readiness records from live provider evidence observations.

use serde::{Deserialize, Serialize};

use crate::{LiveProviderEvidenceWorkObservationRecord, LiveProviderEvidenceWorkObservationStatus};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveProviderEvidenceReviewReadinessInput {
    pub observation: LiveProviderEvidenceWorkObservationRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveProviderEvidenceReviewReadinessRecord {
    pub readiness_id: String,
    pub observation_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub evidence_id: String,
    pub status: LiveProviderEvidenceReviewReadinessStatus,
    pub blockers: Vec<LiveProviderEvidenceReviewReadinessBlocker>,
    pub runtime_completed: bool,
    pub review_ready: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveProviderEvidenceReviewReadinessStatus {
    AwaitingExplicitReview,
    NotReady,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveProviderEvidenceReviewReadinessBlocker {
    ObservationNotPersisted,
    RuntimeNotCompleted,
    ReviewCandidateMissing,
    ProviderWriteMissing,
}

pub fn live_provider_evidence_review_readiness(
    input: LiveProviderEvidenceReviewReadinessInput,
) -> LiveProviderEvidenceReviewReadinessRecord {
    let blockers = blockers(&input.observation);
    let review_ready = blockers.is_empty();
    let status = if review_ready {
        LiveProviderEvidenceReviewReadinessStatus::AwaitingExplicitReview
    } else {
        LiveProviderEvidenceReviewReadinessStatus::NotReady
    };

    LiveProviderEvidenceReviewReadinessRecord {
        readiness_id: format!(
            "live-provider-evidence-review-readiness:{}",
            input.observation.observation_id
        ),
        observation_id: input.observation.observation_id,
        task_id: input.observation.task_id,
        work_item_id: input.observation.work_item_id,
        evidence_id: input.observation.evidence_id,
        status,
        blockers,
        runtime_completed: input.observation.runtime_completed,
        review_ready,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
    }
}

fn blockers(
    observation: &LiveProviderEvidenceWorkObservationRecord,
) -> Vec<LiveProviderEvidenceReviewReadinessBlocker> {
    let mut blockers = Vec::new();
    if observation.status != LiveProviderEvidenceWorkObservationStatus::Persisted {
        blockers.push(LiveProviderEvidenceReviewReadinessBlocker::ObservationNotPersisted);
    }
    if !observation.runtime_completed {
        blockers.push(LiveProviderEvidenceReviewReadinessBlocker::RuntimeNotCompleted);
    }
    if !observation.review_ready_candidate {
        blockers.push(LiveProviderEvidenceReviewReadinessBlocker::ReviewCandidateMissing);
    }
    if !observation.provider_write_executed {
        blockers.push(LiveProviderEvidenceReviewReadinessBlocker::ProviderWriteMissing);
    }
    blockers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_provider_evidence_review_readiness_accepts_completed_observation() {
        let record =
            live_provider_evidence_review_readiness(LiveProviderEvidenceReviewReadinessInput {
                observation: observation(),
            });

        assert_eq!(
            record.status,
            LiveProviderEvidenceReviewReadinessStatus::AwaitingExplicitReview
        );
        assert!(record.review_ready);
        assert!(record.runtime_completed);
        assert!(!record.task_completion_permitted);
        assert!(!record.review_acceptance_permitted);
    }

    #[test]
    fn live_provider_evidence_review_readiness_blocks_failed_or_unpersisted_observation() {
        let mut observation = observation();
        observation.status = LiveProviderEvidenceWorkObservationStatus::Blocked;
        observation.runtime_completed = false;
        observation.review_ready_candidate = false;
        observation.provider_write_executed = false;

        let record =
            live_provider_evidence_review_readiness(LiveProviderEvidenceReviewReadinessInput {
                observation,
            });

        assert_eq!(
            record.status,
            LiveProviderEvidenceReviewReadinessStatus::NotReady
        );
        assert!(record
            .blockers
            .contains(&LiveProviderEvidenceReviewReadinessBlocker::ObservationNotPersisted));
        assert!(record
            .blockers
            .contains(&LiveProviderEvidenceReviewReadinessBlocker::RuntimeNotCompleted));
        assert!(!record.review_ready);
        assert!(!record.task_completion_permitted);
    }

    fn observation() -> LiveProviderEvidenceWorkObservationRecord {
        LiveProviderEvidenceWorkObservationRecord {
            observation_id: "observation:1".to_owned(),
            candidate_id: "candidate:1".to_owned(),
            project_id: "project:nucleus".to_owned(),
            task_id: "task:live-provider".to_owned(),
            work_item_id: "work:live-provider".to_owned(),
            evidence_id: "evidence:live-provider".to_owned(),
            runtime_receipt_id: Some("receipt:live-provider".to_owned()),
            live_executor_outcome_id: Some("outcome:live-provider".to_owned()),
            thread_id: Some("thread:live-provider".to_owned()),
            turn_id: Some("turn:live-provider".to_owned()),
            status: LiveProviderEvidenceWorkObservationStatus::Persisted,
            blockers: Vec::new(),
            duplicate_observation_detected: false,
            provider_write_executed: true,
            runtime_completed: true,
            review_ready_candidate: true,
            task_completion_permitted: false,
            review_acceptance_permitted: false,
            raw_provider_material_retained: false,
            raw_stream_retained: false,
        }
    }
}
