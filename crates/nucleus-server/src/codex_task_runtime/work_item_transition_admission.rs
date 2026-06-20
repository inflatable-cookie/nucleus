//! Work-item runtime transition admission from live observation candidates.
//!
//! This module gates advisory candidates before they can become runtime
//! transition evidence. It does not complete tasks, accept review, mutate SCM,
//! or write task state.

use nucleus_engine::EngineTaskAgentWorkUnitRuntimeStatus;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use super::{
    CodexLiveObservationWorkItemCandidate, CodexLiveObservationWorkItemCandidateState,
    CodexLiveObservationWorkItemCandidateStatus,
};

/// Input for admitting one live-observation work-item runtime transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexWorkItemRuntimeTransitionAdmissionInput {
    pub candidate: CodexLiveObservationWorkItemCandidate,
    pub expected_current_runtime: EngineTaskAgentWorkUnitRuntimeStatus,
    pub expected_revision_ref: Option<String>,
    pub task_completion_requested: bool,
    pub review_acceptance_requested: bool,
    pub scm_mutation_requested: bool,
}

/// Admitted or blocked runtime transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexWorkItemRuntimeTransitionAdmissionRecord {
    pub admission_id: String,
    pub candidate_id: String,
    pub task_id: TaskId,
    pub project_id: ProjectId,
    pub work_item_id: String,
    pub previous_runtime: EngineTaskAgentWorkUnitRuntimeStatus,
    pub next_runtime: EngineTaskAgentWorkUnitRuntimeStatus,
    pub expected_revision_ref: Option<String>,
    pub status: CodexWorkItemRuntimeTransitionAdmissionStatus,
    pub blockers: Vec<CodexWorkItemRuntimeTransitionAdmissionBlocker>,
    pub evidence_refs: Vec<String>,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub task_state_mutation_permitted: bool,
}

/// Runtime transition admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexWorkItemRuntimeTransitionAdmissionStatus {
    Admitted,
    Blocked,
}

/// Why a runtime transition is not admitted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexWorkItemRuntimeTransitionAdmissionBlocker {
    CandidateBlocked,
    InvalidRuntimeTransition,
    MissingExpectedRevision,
    TaskCompletionRequested,
    ReviewAcceptanceRequested,
    ScmMutationRequested,
}

/// Admit a runtime-only work-item transition candidate.
pub fn admit_codex_work_item_runtime_transition(
    input: CodexWorkItemRuntimeTransitionAdmissionInput,
) -> CodexWorkItemRuntimeTransitionAdmissionRecord {
    let next_runtime = runtime_from_candidate(&input.candidate.candidate_state);
    let blockers = admission_blockers(&input, &next_runtime);
    let status = if blockers.is_empty() {
        CodexWorkItemRuntimeTransitionAdmissionStatus::Admitted
    } else {
        CodexWorkItemRuntimeTransitionAdmissionStatus::Blocked
    };

    CodexWorkItemRuntimeTransitionAdmissionRecord {
        admission_id: format!(
            "codex-work-item-runtime-transition-admission:{}",
            input.candidate.candidate_id
        ),
        candidate_id: input.candidate.candidate_id,
        task_id: input.candidate.task_id,
        project_id: input.candidate.project_id,
        work_item_id: input.candidate.work_item_id.0,
        previous_runtime: input.expected_current_runtime,
        next_runtime,
        expected_revision_ref: input.expected_revision_ref,
        status,
        blockers,
        evidence_refs: input.candidate.evidence_refs,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        scm_mutation_permitted: false,
        task_state_mutation_permitted: false,
    }
}

fn admission_blockers(
    input: &CodexWorkItemRuntimeTransitionAdmissionInput,
    next_runtime: &EngineTaskAgentWorkUnitRuntimeStatus,
) -> Vec<CodexWorkItemRuntimeTransitionAdmissionBlocker> {
    let mut blockers = Vec::new();
    if input.candidate.status != CodexLiveObservationWorkItemCandidateStatus::Candidate {
        blockers.push(CodexWorkItemRuntimeTransitionAdmissionBlocker::CandidateBlocked);
    }
    if input.expected_revision_ref.is_none() {
        blockers.push(CodexWorkItemRuntimeTransitionAdmissionBlocker::MissingExpectedRevision);
    }
    if !runtime_transition_allowed(&input.expected_current_runtime, next_runtime) {
        blockers.push(CodexWorkItemRuntimeTransitionAdmissionBlocker::InvalidRuntimeTransition);
    }
    if input.task_completion_requested {
        blockers.push(CodexWorkItemRuntimeTransitionAdmissionBlocker::TaskCompletionRequested);
    }
    if input.review_acceptance_requested {
        blockers.push(CodexWorkItemRuntimeTransitionAdmissionBlocker::ReviewAcceptanceRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(CodexWorkItemRuntimeTransitionAdmissionBlocker::ScmMutationRequested);
    }
    blockers
}

fn runtime_from_candidate(
    state: &CodexLiveObservationWorkItemCandidateState,
) -> EngineTaskAgentWorkUnitRuntimeStatus {
    match state {
        CodexLiveObservationWorkItemCandidateState::Running => {
            EngineTaskAgentWorkUnitRuntimeStatus::Running
        }
        CodexLiveObservationWorkItemCandidateState::Waiting => {
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval
        }
        CodexLiveObservationWorkItemCandidateState::Completed => {
            EngineTaskAgentWorkUnitRuntimeStatus::Completed
        }
        CodexLiveObservationWorkItemCandidateState::Failed => {
            EngineTaskAgentWorkUnitRuntimeStatus::Failed("provider observation failed".to_owned())
        }
        CodexLiveObservationWorkItemCandidateState::Cancelled => {
            EngineTaskAgentWorkUnitRuntimeStatus::Cancelled
        }
        CodexLiveObservationWorkItemCandidateState::RecoveryRequired => {
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(
                "provider observation requires recovery".to_owned(),
            )
        }
    }
}

fn runtime_transition_allowed(
    previous: &EngineTaskAgentWorkUnitRuntimeStatus,
    next: &EngineTaskAgentWorkUnitRuntimeStatus,
) -> bool {
    if previous == next {
        return true;
    }
    matches!(
        (previous, next),
        (
            EngineTaskAgentWorkUnitRuntimeStatus::Scheduled,
            EngineTaskAgentWorkUnitRuntimeStatus::Running
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Running,
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Running,
            EngineTaskAgentWorkUnitRuntimeStatus::Completed
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Running,
            EngineTaskAgentWorkUnitRuntimeStatus::Failed(_)
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Running,
            EngineTaskAgentWorkUnitRuntimeStatus::Cancelled
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval,
            EngineTaskAgentWorkUnitRuntimeStatus::Running
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval,
            EngineTaskAgentWorkUnitRuntimeStatus::Cancelled
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval,
            EngineTaskAgentWorkUnitRuntimeStatus::Failed(_)
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Failed(_),
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_)
        ) | (
            EngineTaskAgentWorkUnitRuntimeStatus::Cancelled,
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(_)
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_task_runtime::{
        CodexLiveObservationWorkItemCandidateBlocker, CodexLiveObservationWorkItemCandidateStatus,
    };
    use nucleus_engine::EngineTaskWorkItemId;
    use nucleus_projects::ProjectId;
    use nucleus_tasks::TaskId;

    #[test]
    fn work_item_runtime_transition_admission_admits_valid_runtime_transition() {
        let admission = admit_codex_work_item_runtime_transition(input(
            candidate(CodexLiveObservationWorkItemCandidateState::Completed),
            EngineTaskAgentWorkUnitRuntimeStatus::Running,
        ));

        assert_eq!(
            admission.status,
            CodexWorkItemRuntimeTransitionAdmissionStatus::Admitted
        );
        assert_eq!(
            admission.next_runtime,
            EngineTaskAgentWorkUnitRuntimeStatus::Completed
        );
        assert!(!admission.task_completion_permitted);
        assert!(!admission.review_acceptance_permitted);
        assert!(!admission.scm_mutation_permitted);
    }

    #[test]
    fn work_item_runtime_transition_admission_blocks_invalid_transition() {
        let admission = admit_codex_work_item_runtime_transition(input(
            candidate(CodexLiveObservationWorkItemCandidateState::Completed),
            EngineTaskAgentWorkUnitRuntimeStatus::Scheduled,
        ));

        assert_eq!(
            admission.status,
            CodexWorkItemRuntimeTransitionAdmissionStatus::Blocked
        );
        assert!(admission
            .blockers
            .contains(&CodexWorkItemRuntimeTransitionAdmissionBlocker::InvalidRuntimeTransition));
    }

    #[test]
    fn work_item_runtime_transition_admission_blocks_task_review_and_scm_authority() {
        let mut input = input(
            candidate(CodexLiveObservationWorkItemCandidateState::Completed),
            EngineTaskAgentWorkUnitRuntimeStatus::Running,
        );
        input.task_completion_requested = true;
        input.review_acceptance_requested = true;
        input.scm_mutation_requested = true;

        let admission = admit_codex_work_item_runtime_transition(input);

        assert_eq!(
            admission.status,
            CodexWorkItemRuntimeTransitionAdmissionStatus::Blocked
        );
        assert!(admission
            .blockers
            .contains(&CodexWorkItemRuntimeTransitionAdmissionBlocker::TaskCompletionRequested));
        assert!(admission
            .blockers
            .contains(&CodexWorkItemRuntimeTransitionAdmissionBlocker::ReviewAcceptanceRequested));
        assert!(admission
            .blockers
            .contains(&CodexWorkItemRuntimeTransitionAdmissionBlocker::ScmMutationRequested));
        assert!(!admission.task_state_mutation_permitted);
    }

    #[test]
    fn work_item_runtime_transition_admission_blocks_candidate_blockers() {
        let mut candidate = candidate(CodexLiveObservationWorkItemCandidateState::Running);
        candidate.status = CodexLiveObservationWorkItemCandidateStatus::Blocked;
        candidate
            .blockers
            .push(CodexLiveObservationWorkItemCandidateBlocker::MissingWorkItemIdentity);

        let admission = admit_codex_work_item_runtime_transition(input(
            candidate,
            EngineTaskAgentWorkUnitRuntimeStatus::Scheduled,
        ));

        assert_eq!(
            admission.status,
            CodexWorkItemRuntimeTransitionAdmissionStatus::Blocked
        );
        assert!(admission
            .blockers
            .contains(&CodexWorkItemRuntimeTransitionAdmissionBlocker::CandidateBlocked));
    }

    fn input(
        candidate: CodexLiveObservationWorkItemCandidate,
        expected: EngineTaskAgentWorkUnitRuntimeStatus,
    ) -> CodexWorkItemRuntimeTransitionAdmissionInput {
        CodexWorkItemRuntimeTransitionAdmissionInput {
            candidate,
            expected_current_runtime: expected,
            expected_revision_ref: Some("rev:work-item:1".to_owned()),
            task_completion_requested: false,
            review_acceptance_requested: false,
            scm_mutation_requested: false,
        }
    }

    fn candidate(
        state: CodexLiveObservationWorkItemCandidateState,
    ) -> CodexLiveObservationWorkItemCandidate {
        CodexLiveObservationWorkItemCandidate {
            candidate_id: "candidate:1".to_owned(),
            task_id: TaskId("task:1".to_owned()),
            project_id: ProjectId("project:1".to_owned()),
            work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
            provider_instance_id: "codex:local-default".to_owned(),
            runtime_session_ref: "runtime-session:codex:1".to_owned(),
            event_id: Some("event:1".to_owned()),
            receipt_ref: Some("receipt:1".to_owned()),
            frame_source_id: "frame:1".to_owned(),
            decode_outcome_id: "decode:1".to_owned(),
            candidate_state: state,
            status: CodexLiveObservationWorkItemCandidateStatus::Candidate,
            blockers: Vec::new(),
            evidence_refs: vec!["evidence:1".to_owned()],
            advisory_only: true,
            task_mutation_permitted: false,
            raw_provider_material_retained: false,
        }
    }
}
