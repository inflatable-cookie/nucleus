//! Review readiness derived from live-observation runtime completion.
//!
//! This module can mark a work item as ready for operator review evidence. It
//! does not accept review, complete the parent task, or mutate task state.

use nucleus_engine::EngineTaskAgentWorkUnitRuntimeStatus;
use nucleus_tasks::TaskId;

use super::{
    CodexWorkItemRuntimeTransitionAdmissionRecord, CodexWorkItemRuntimeTransitionAdmissionStatus,
};

/// Input for deriving review readiness from live observation admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexReviewReadinessFromLiveObservationInput {
    pub admission: CodexWorkItemRuntimeTransitionAdmissionRecord,
    pub validation_refs: Vec<String>,
    pub checkpoint_refs: Vec<String>,
    pub diff_summary_refs: Vec<String>,
    pub receipt_refs: Vec<String>,
    pub no_change_evidence_ref: Option<String>,
    pub review_acceptance_requested: bool,
    pub task_completion_requested: bool,
}

/// Review readiness record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexReviewReadinessFromLiveObservationRecord {
    pub readiness_id: String,
    pub task_id: TaskId,
    pub work_item_id: String,
    pub admission_id: String,
    pub status: CodexReviewReadinessFromLiveObservationStatus,
    pub blockers: Vec<CodexReviewReadinessFromLiveObservationBlocker>,
    pub evidence_refs: Vec<String>,
    pub awaiting_review_ready: bool,
    pub review_acceptance_permitted: bool,
    pub task_completion_permitted: bool,
}

/// Review readiness status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexReviewReadinessFromLiveObservationStatus {
    ReadyForOperatorReview,
    Blocked,
}

/// Why review readiness cannot be derived.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexReviewReadinessFromLiveObservationBlocker {
    RuntimeTransitionNotAdmitted,
    RuntimeNotCompleted,
    MissingReviewEvidence,
    ReviewAcceptanceRequested,
    TaskCompletionRequested,
}

/// Derive review readiness without accepting review.
pub fn codex_review_readiness_from_live_observation(
    input: CodexReviewReadinessFromLiveObservationInput,
) -> CodexReviewReadinessFromLiveObservationRecord {
    let evidence_refs = review_evidence_refs(&input);
    let blockers = readiness_blockers(&input, &evidence_refs);
    let awaiting_review_ready = blockers.is_empty();
    let status = if awaiting_review_ready {
        CodexReviewReadinessFromLiveObservationStatus::ReadyForOperatorReview
    } else {
        CodexReviewReadinessFromLiveObservationStatus::Blocked
    };

    CodexReviewReadinessFromLiveObservationRecord {
        readiness_id: format!("codex-review-readiness:{}", input.admission.admission_id),
        task_id: input.admission.task_id,
        work_item_id: input.admission.work_item_id,
        admission_id: input.admission.admission_id,
        status,
        blockers,
        evidence_refs,
        awaiting_review_ready,
        review_acceptance_permitted: false,
        task_completion_permitted: false,
    }
}

fn readiness_blockers(
    input: &CodexReviewReadinessFromLiveObservationInput,
    evidence_refs: &[String],
) -> Vec<CodexReviewReadinessFromLiveObservationBlocker> {
    let mut blockers = Vec::new();
    if input.admission.status != CodexWorkItemRuntimeTransitionAdmissionStatus::Admitted {
        blockers.push(CodexReviewReadinessFromLiveObservationBlocker::RuntimeTransitionNotAdmitted);
    }
    if !matches!(
        input.admission.next_runtime,
        EngineTaskAgentWorkUnitRuntimeStatus::Completed
    ) {
        blockers.push(CodexReviewReadinessFromLiveObservationBlocker::RuntimeNotCompleted);
    }
    if evidence_refs.is_empty() {
        blockers.push(CodexReviewReadinessFromLiveObservationBlocker::MissingReviewEvidence);
    }
    if input.review_acceptance_requested {
        blockers.push(CodexReviewReadinessFromLiveObservationBlocker::ReviewAcceptanceRequested);
    }
    if input.task_completion_requested {
        blockers.push(CodexReviewReadinessFromLiveObservationBlocker::TaskCompletionRequested);
    }
    blockers
}

fn review_evidence_refs(input: &CodexReviewReadinessFromLiveObservationInput) -> Vec<String> {
    let mut refs = Vec::new();
    refs.extend(input.validation_refs.clone());
    refs.extend(input.checkpoint_refs.clone());
    refs.extend(input.diff_summary_refs.clone());
    refs.extend(input.receipt_refs.clone());
    if let Some(no_change) = &input.no_change_evidence_ref {
        refs.push(no_change.clone());
    }
    refs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_task_runtime::{
        CodexWorkItemRuntimeTransitionAdmissionBlocker,
        CodexWorkItemRuntimeTransitionAdmissionStatus,
    };
    use nucleus_projects::ProjectId;

    #[test]
    fn review_readiness_from_live_observations_allows_completed_runtime_with_evidence() {
        let readiness = codex_review_readiness_from_live_observation(input(
            admission(EngineTaskAgentWorkUnitRuntimeStatus::Completed),
            vec!["receipt:1".to_owned()],
        ));

        assert_eq!(
            readiness.status,
            CodexReviewReadinessFromLiveObservationStatus::ReadyForOperatorReview
        );
        assert!(readiness.awaiting_review_ready);
        assert_eq!(readiness.evidence_refs, vec!["receipt:1"]);
        assert!(!readiness.review_acceptance_permitted);
        assert!(!readiness.task_completion_permitted);
    }

    #[test]
    fn review_readiness_from_live_observations_blocks_missing_evidence() {
        let readiness = codex_review_readiness_from_live_observation(input(
            admission(EngineTaskAgentWorkUnitRuntimeStatus::Completed),
            Vec::new(),
        ));

        assert_eq!(
            readiness.status,
            CodexReviewReadinessFromLiveObservationStatus::Blocked
        );
        assert!(readiness
            .blockers
            .contains(&CodexReviewReadinessFromLiveObservationBlocker::MissingReviewEvidence));
    }

    #[test]
    fn review_readiness_from_live_observations_blocks_review_acceptance_and_task_completion() {
        let mut input = input(
            admission(EngineTaskAgentWorkUnitRuntimeStatus::Completed),
            vec!["receipt:1".to_owned()],
        );
        input.review_acceptance_requested = true;
        input.task_completion_requested = true;

        let readiness = codex_review_readiness_from_live_observation(input);

        assert_eq!(
            readiness.status,
            CodexReviewReadinessFromLiveObservationStatus::Blocked
        );
        assert!(readiness
            .blockers
            .contains(&CodexReviewReadinessFromLiveObservationBlocker::ReviewAcceptanceRequested));
        assert!(readiness
            .blockers
            .contains(&CodexReviewReadinessFromLiveObservationBlocker::TaskCompletionRequested));
        assert!(!readiness.review_acceptance_permitted);
        assert!(!readiness.task_completion_permitted);
    }

    #[test]
    fn review_readiness_from_live_observations_requires_completed_runtime() {
        let readiness = codex_review_readiness_from_live_observation(input(
            admission(EngineTaskAgentWorkUnitRuntimeStatus::Running),
            vec!["receipt:1".to_owned()],
        ));

        assert!(readiness
            .blockers
            .contains(&CodexReviewReadinessFromLiveObservationBlocker::RuntimeNotCompleted));
    }

    fn input(
        admission: CodexWorkItemRuntimeTransitionAdmissionRecord,
        receipt_refs: Vec<String>,
    ) -> CodexReviewReadinessFromLiveObservationInput {
        CodexReviewReadinessFromLiveObservationInput {
            admission,
            validation_refs: Vec::new(),
            checkpoint_refs: Vec::new(),
            diff_summary_refs: Vec::new(),
            receipt_refs,
            no_change_evidence_ref: None,
            review_acceptance_requested: false,
            task_completion_requested: false,
        }
    }

    fn admission(
        next_runtime: EngineTaskAgentWorkUnitRuntimeStatus,
    ) -> CodexWorkItemRuntimeTransitionAdmissionRecord {
        CodexWorkItemRuntimeTransitionAdmissionRecord {
            admission_id: "admission:1".to_owned(),
            candidate_id: "candidate:1".to_owned(),
            task_id: TaskId("task:1".to_owned()),
            project_id: ProjectId("project:1".to_owned()),
            work_item_id: "work:1".to_owned(),
            previous_runtime: EngineTaskAgentWorkUnitRuntimeStatus::Running,
            next_runtime,
            expected_revision_ref: Some("rev:1".to_owned()),
            status: CodexWorkItemRuntimeTransitionAdmissionStatus::Admitted,
            blockers: Vec::<CodexWorkItemRuntimeTransitionAdmissionBlocker>::new(),
            evidence_refs: vec!["evidence:admission".to_owned()],
            task_completion_permitted: false,
            review_acceptance_permitted: false,
            scm_mutation_permitted: false,
            task_state_mutation_permitted: false,
        }
    }
}
