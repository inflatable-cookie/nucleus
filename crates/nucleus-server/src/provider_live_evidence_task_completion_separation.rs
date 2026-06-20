//! Regression record proving live evidence review does not complete tasks.

use serde::{Deserialize, Serialize};

use crate::{
    DurableCodexLiveProviderWriteReplayRecord, LiveEvidenceReviewAcceptanceAdmissionRecord,
    LiveEvidenceReviewDecision, LiveEvidenceReviewDecisionRecord,
    LiveProviderEvidenceReviewReadinessRecord, LiveProviderEvidenceWorkCandidateRecord,
    LiveProviderEvidenceWorkObservationRecord,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvidenceTaskCompletionSeparationInput {
    pub replay: DurableCodexLiveProviderWriteReplayRecord,
    pub candidate: LiveProviderEvidenceWorkCandidateRecord,
    pub observation: LiveProviderEvidenceWorkObservationRecord,
    pub readiness: LiveProviderEvidenceReviewReadinessRecord,
    pub admission: LiveEvidenceReviewAcceptanceAdmissionRecord,
    pub decision: LiveEvidenceReviewDecisionRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiveEvidenceTaskCompletionSeparationRecord {
    pub separation_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub replay_id: String,
    pub candidate_id: String,
    pub observation_id: String,
    pub readiness_id: String,
    pub admission_id: String,
    pub decision_id: String,
    pub decision: LiveEvidenceReviewDecision,
    pub provider_completion_promoted_review: bool,
    pub provider_completion_completed_task: bool,
    pub review_acceptance_completed_task: bool,
    pub non_acceptance_completed_task: bool,
    pub explicit_task_completion_required: bool,
    pub future_task_completion_lane: String,
    pub blockers: Vec<LiveEvidenceTaskCompletionSeparationBlocker>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveEvidenceTaskCompletionSeparationBlocker {
    ReplayPromotedTaskCompletion,
    ReplayPromotedReviewAcceptance,
    CandidateInferredTaskCompletion,
    CandidateInferredReviewAcceptance,
    ObservationPermittedTaskCompletion,
    ObservationPermittedReviewAcceptance,
    ReadinessPermittedTaskCompletion,
    ReadinessPermittedReviewAcceptance,
    AdmissionPermittedTaskCompletion,
    DecisionPermittedTaskCompletion,
}

pub fn live_evidence_task_completion_separation(
    input: LiveEvidenceTaskCompletionSeparationInput,
) -> LiveEvidenceTaskCompletionSeparationRecord {
    let blockers = blockers(&input);
    let non_acceptance_completed_task =
        !matches!(input.decision.decision, LiveEvidenceReviewDecision::Accept)
            && input.decision.task_completion_permitted;

    LiveEvidenceTaskCompletionSeparationRecord {
        separation_id: format!(
            "live-evidence-task-completion-separation:{}:{}",
            input.decision.task_id, input.decision.work_item_id
        ),
        task_id: input.decision.task_id,
        work_item_id: input.decision.work_item_id,
        replay_id: input.replay.replay_id,
        candidate_id: input.candidate.candidate_id,
        observation_id: input.observation.observation_id,
        readiness_id: input.readiness.readiness_id,
        admission_id: input.admission.admission_id,
        decision_id: input.decision.decision_id,
        decision: input.decision.decision,
        provider_completion_promoted_review: input.replay.review_acceptance_promoted,
        provider_completion_completed_task: input.replay.task_completion_promoted,
        review_acceptance_completed_task: input.decision.task_completion_permitted,
        non_acceptance_completed_task,
        explicit_task_completion_required: blockers.is_empty(),
        future_task_completion_lane: "explicit-live-evidence-task-completion".to_owned(),
        blockers,
    }
}

fn blockers(
    input: &LiveEvidenceTaskCompletionSeparationInput,
) -> Vec<LiveEvidenceTaskCompletionSeparationBlocker> {
    let mut blockers = Vec::new();
    if input.replay.task_completion_promoted {
        blockers.push(LiveEvidenceTaskCompletionSeparationBlocker::ReplayPromotedTaskCompletion);
    }
    if input.replay.review_acceptance_promoted {
        blockers.push(LiveEvidenceTaskCompletionSeparationBlocker::ReplayPromotedReviewAcceptance);
    }
    if input.candidate.task_completion_inferred {
        blockers.push(LiveEvidenceTaskCompletionSeparationBlocker::CandidateInferredTaskCompletion);
    }
    if input.candidate.review_acceptance_inferred {
        blockers
            .push(LiveEvidenceTaskCompletionSeparationBlocker::CandidateInferredReviewAcceptance);
    }
    if input.observation.task_completion_permitted {
        blockers
            .push(LiveEvidenceTaskCompletionSeparationBlocker::ObservationPermittedTaskCompletion);
    }
    if input.observation.review_acceptance_permitted {
        blockers.push(
            LiveEvidenceTaskCompletionSeparationBlocker::ObservationPermittedReviewAcceptance,
        );
    }
    if input.readiness.task_completion_permitted {
        blockers
            .push(LiveEvidenceTaskCompletionSeparationBlocker::ReadinessPermittedTaskCompletion);
    }
    if input.readiness.review_acceptance_permitted {
        blockers
            .push(LiveEvidenceTaskCompletionSeparationBlocker::ReadinessPermittedReviewAcceptance);
    }
    if input.admission.task_completion_permitted {
        blockers
            .push(LiveEvidenceTaskCompletionSeparationBlocker::AdmissionPermittedTaskCompletion);
    }
    if input.decision.task_completion_permitted {
        blockers.push(LiveEvidenceTaskCompletionSeparationBlocker::DecisionPermittedTaskCompletion);
    }
    blockers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        DurableCodexLiveProviderWriteReplayGap, DurableCodexLiveProviderWriteReplayStatus,
        LiveEvidenceReviewAcceptanceAdmissionBlocker, LiveEvidenceReviewAcceptanceAdmissionStatus,
        LiveEvidenceReviewDecisionPersistenceBlocker, LiveEvidenceReviewDecisionPersistenceStatus,
        LiveProviderEvidenceReviewReadinessBlocker, LiveProviderEvidenceReviewReadinessStatus,
        LiveProviderEvidenceWorkCandidateGap, LiveProviderEvidenceWorkCandidateStatus,
        LiveProviderEvidenceWorkObservationBlocker, LiveProviderEvidenceWorkObservationStatus,
    };

    #[test]
    fn live_evidence_task_completion_separation_requires_explicit_task_completion_after_acceptance()
    {
        let record =
            live_evidence_task_completion_separation(input(LiveEvidenceReviewDecision::Accept));

        assert!(record.blockers.is_empty());
        assert!(!record.provider_completion_promoted_review);
        assert!(!record.provider_completion_completed_task);
        assert!(!record.review_acceptance_completed_task);
        assert!(!record.non_acceptance_completed_task);
        assert!(record.explicit_task_completion_required);
        assert_eq!(
            record.future_task_completion_lane,
            "explicit-live-evidence-task-completion"
        );
    }

    #[test]
    fn live_evidence_task_completion_separation_blocks_any_inferred_completion_authority() {
        let mut input = input(LiveEvidenceReviewDecision::Accept);
        input.replay.task_completion_promoted = true;
        input.replay.review_acceptance_promoted = true;
        input.candidate.task_completion_inferred = true;
        input.candidate.review_acceptance_inferred = true;
        input.observation.task_completion_permitted = true;
        input.observation.review_acceptance_permitted = true;
        input.readiness.task_completion_permitted = true;
        input.readiness.review_acceptance_permitted = true;
        input.admission.task_completion_permitted = true;
        input.decision.task_completion_permitted = true;

        let record = live_evidence_task_completion_separation(input);

        assert!(record
            .blockers
            .contains(&LiveEvidenceTaskCompletionSeparationBlocker::ReplayPromotedTaskCompletion));
        assert!(record.blockers.contains(
            &LiveEvidenceTaskCompletionSeparationBlocker::CandidateInferredReviewAcceptance
        ));
        assert!(record.blockers.contains(
            &LiveEvidenceTaskCompletionSeparationBlocker::DecisionPermittedTaskCompletion
        ));
        assert!(!record.explicit_task_completion_required);
    }

    #[test]
    fn live_evidence_task_completion_separation_never_completes_reject_needs_changes_or_abandon() {
        for decision in [
            LiveEvidenceReviewDecision::Reject("wrong".to_owned()),
            LiveEvidenceReviewDecision::NeedsChanges("tests".to_owned()),
            LiveEvidenceReviewDecision::Abandon("superseded".to_owned()),
        ] {
            let record = live_evidence_task_completion_separation(input(decision));

            assert!(!record.non_acceptance_completed_task);
            assert!(!record.review_acceptance_completed_task);
            assert!(record.explicit_task_completion_required);
        }
    }

    fn input(decision: LiveEvidenceReviewDecision) -> LiveEvidenceTaskCompletionSeparationInput {
        LiveEvidenceTaskCompletionSeparationInput {
            replay: replay(),
            candidate: candidate(),
            observation: observation(),
            readiness: readiness(),
            admission: admission(decision.clone()),
            decision: persisted_decision(decision),
        }
    }

    fn replay() -> DurableCodexLiveProviderWriteReplayRecord {
        DurableCodexLiveProviderWriteReplayRecord {
            replay_id: "replay:1".to_owned(),
            evidence_id: "evidence:1".to_owned(),
            write_attempt_id: "write-attempt:1".to_owned(),
            status: DurableCodexLiveProviderWriteReplayStatus::Reconciled,
            gaps: Vec::<DurableCodexLiveProviderWriteReplayGap>::new(),
            smoke_replay_status:
                crate::DurableCodexLiveSmokeReplayComparisonStatus::ReplayEquivalent,
            provider_write_executed: true,
            replay_reconciled: true,
            repair_required: false,
            task_completion_promoted: false,
            review_acceptance_promoted: false,
        }
    }

    fn candidate() -> LiveProviderEvidenceWorkCandidateRecord {
        LiveProviderEvidenceWorkCandidateRecord {
            candidate_id: "candidate:1".to_owned(),
            project_id: "project:nucleus".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            evidence_id: "evidence:1".to_owned(),
            replay_id: "replay:1".to_owned(),
            runtime_receipt_id: Some("receipt:1".to_owned()),
            live_executor_outcome_id: Some("outcome:1".to_owned()),
            thread_id: Some("thread:1".to_owned()),
            turn_id: Some("turn:1".to_owned()),
            provider_instance_id: "provider:codex".to_owned(),
            status: LiveProviderEvidenceWorkCandidateStatus::Ready,
            gaps: Vec::<LiveProviderEvidenceWorkCandidateGap>::new(),
            provider_write_executed: true,
            runtime_completed: true,
            review_ready_candidate: true,
            task_completion_inferred: false,
            review_acceptance_inferred: false,
        }
    }

    fn observation() -> LiveProviderEvidenceWorkObservationRecord {
        LiveProviderEvidenceWorkObservationRecord {
            observation_id: "observation:1".to_owned(),
            candidate_id: "candidate:1".to_owned(),
            project_id: "project:nucleus".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            evidence_id: "evidence:1".to_owned(),
            runtime_receipt_id: Some("receipt:1".to_owned()),
            live_executor_outcome_id: Some("outcome:1".to_owned()),
            thread_id: Some("thread:1".to_owned()),
            turn_id: Some("turn:1".to_owned()),
            status: LiveProviderEvidenceWorkObservationStatus::Persisted,
            blockers: Vec::<LiveProviderEvidenceWorkObservationBlocker>::new(),
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

    fn readiness() -> LiveProviderEvidenceReviewReadinessRecord {
        LiveProviderEvidenceReviewReadinessRecord {
            readiness_id: "readiness:1".to_owned(),
            observation_id: "observation:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            evidence_id: "evidence:1".to_owned(),
            status: LiveProviderEvidenceReviewReadinessStatus::AwaitingExplicitReview,
            blockers: Vec::<LiveProviderEvidenceReviewReadinessBlocker>::new(),
            runtime_completed: true,
            review_ready: true,
            task_completion_permitted: false,
            review_acceptance_permitted: false,
        }
    }

    fn admission(
        decision: LiveEvidenceReviewDecision,
    ) -> LiveEvidenceReviewAcceptanceAdmissionRecord {
        LiveEvidenceReviewAcceptanceAdmissionRecord {
            admission_id: "admission:1".to_owned(),
            readiness_id: "readiness:1".to_owned(),
            observation_id: "observation:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            status: LiveEvidenceReviewAcceptanceAdmissionStatus::Admitted,
            blockers: Vec::<LiveEvidenceReviewAcceptanceAdmissionBlocker>::new(),
            operator_ref: "operator:tom".to_owned(),
            evidence_refs: vec!["evidence:review".to_owned()],
            decision,
            task_completion_permitted: false,
            provider_write_permitted: false,
            callback_response_permitted: false,
            cancellation_permitted: false,
            resume_permitted: false,
            scm_mutation_permitted: false,
        }
    }

    fn persisted_decision(
        decision: LiveEvidenceReviewDecision,
    ) -> LiveEvidenceReviewDecisionRecord {
        LiveEvidenceReviewDecisionRecord {
            decision_id: "decision:1".to_owned(),
            admission_id: "admission:1".to_owned(),
            readiness_id: "readiness:1".to_owned(),
            observation_id: "observation:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: "work:1".to_owned(),
            reviewer_ref: "operator:tom".to_owned(),
            decision,
            evidence_refs: vec!["evidence:review".to_owned()],
            status: LiveEvidenceReviewDecisionPersistenceStatus::Persisted,
            blockers: Vec::<LiveEvidenceReviewDecisionPersistenceBlocker>::new(),
            duplicate_decision_detected: false,
            task_completion_permitted: false,
            raw_provider_material_retained: false,
            raw_stream_retained: false,
        }
    }
}
