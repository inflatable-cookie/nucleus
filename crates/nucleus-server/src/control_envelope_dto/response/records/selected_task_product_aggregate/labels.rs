//! Selected-task product label mappings: domain enums to wire strings.
//!
//! Split from the selected_task_product_aggregate god file; behavior
//! unchanged.

use crate::{
    SelectedTaskActionFamily, SelectedTaskActionStatus, SelectedTaskCommandAdmissionStatus,
    SelectedTaskCompletionRouteApplyStatus, SelectedTaskProductSource, SelectedTaskProductSourceState,
    SelectedTaskReviewNextCategory, SelectedTaskReviewOutcomeRouteCandidate,
    SelectedTaskReviewOutcomeRouteStatus, SelectedTaskReviewState,
    SelectedTaskReworkPreparationStatus, SelectedTaskScmHandoffNextCategory,
    SelectedTaskScmHandoffState, SelectedTaskScmHandoffTargetShape,
};

pub(super) fn action_family_label(family: SelectedTaskActionFamily) -> &'static str {
    match family {
        SelectedTaskActionFamily::PlanSelectedTask => "plan_selected_task",
        SelectedTaskActionFamily::StartSelectedTask => "start_selected_task",
        SelectedTaskActionFamily::BlockSelectedTask => "block_selected_task",
        SelectedTaskActionFamily::CompleteSelectedTask => "complete_selected_task",
        SelectedTaskActionFamily::ArchiveSelectedTask => "archive_selected_task",
        SelectedTaskActionFamily::PrepareDelegation => "prepare_delegation",
        SelectedTaskActionFamily::InspectRuntimeEvidence => "inspect_runtime_evidence",
        SelectedTaskActionFamily::ReviewWorkEvidence => "review_work_evidence",
        SelectedTaskActionFamily::PrepareScmHandoff => "prepare_scm_handoff",
    }
}

pub(super) fn action_status_label(status: SelectedTaskActionStatus) -> &'static str {
    match status {
        SelectedTaskActionStatus::Allowed => "allowed",
        SelectedTaskActionStatus::Blocked => "blocked",
        SelectedTaskActionStatus::NotApplicable => "not_applicable",
        SelectedTaskActionStatus::DifferentLane => "different_lane",
    }
}

pub(super) fn command_admission_status_label(
    status: SelectedTaskCommandAdmissionStatus,
) -> &'static str {
    match status {
        SelectedTaskCommandAdmissionStatus::Admitted => "admitted",
        SelectedTaskCommandAdmissionStatus::Refused => "refused",
    }
}

pub(super) fn review_state_label(state: SelectedTaskReviewState) -> &'static str {
    match state {
        SelectedTaskReviewState::NotReady => "not_ready",
        SelectedTaskReviewState::AwaitingReview => "awaiting_review",
        SelectedTaskReviewState::Accepted => "accepted",
        SelectedTaskReviewState::Rejected => "rejected",
        SelectedTaskReviewState::NeedsChanges => "needs_changes",
        SelectedTaskReviewState::Abandoned => "abandoned",
    }
}

pub(super) fn review_next_category_label(category: SelectedTaskReviewNextCategory) -> &'static str {
    match category {
        SelectedTaskReviewNextCategory::ReviewEvidence => "review_evidence",
        SelectedTaskReviewNextCategory::Rework => "rework",
        SelectedTaskReviewNextCategory::TaskCommand => "task_command",
        SelectedTaskReviewNextCategory::ScmHandoff => "scm_handoff",
        SelectedTaskReviewNextCategory::InspectRuntime => "inspect_runtime",
        SelectedTaskReviewNextCategory::PlanningAmbiguity => "planning_ambiguity",
        SelectedTaskReviewNextCategory::Wait => "wait",
    }
}

pub(super) fn route_status_label(status: SelectedTaskReviewOutcomeRouteStatus) -> &'static str {
    match status {
        SelectedTaskReviewOutcomeRouteStatus::Ready => "ready",
        SelectedTaskReviewOutcomeRouteStatus::Blocked => "blocked",
        SelectedTaskReviewOutcomeRouteStatus::Stale => "stale",
        SelectedTaskReviewOutcomeRouteStatus::Missing => "missing",
    }
}

pub(super) fn route_candidate_label(
    candidate: SelectedTaskReviewOutcomeRouteCandidate,
) -> &'static str {
    match candidate {
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForCompletionAdmission => {
            "ready_for_completion_admission"
        }
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForReworkAdmission => {
            "ready_for_rework_admission"
        }
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForDelegationAdmission => {
            "ready_for_delegation_admission"
        }
        SelectedTaskReviewOutcomeRouteCandidate::ReadyForScmHandoffReview => {
            "ready_for_scm_handoff_review"
        }
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnOperatorChoice => {
            "blocked_on_operator_choice"
        }
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnMissingEvidence => {
            "blocked_on_missing_evidence"
        }
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnStaleTaskState => {
            "blocked_on_stale_task_state"
        }
        SelectedTaskReviewOutcomeRouteCandidate::BlockedOnPlanningAmbiguity => {
            "blocked_on_planning_ambiguity"
        }
        SelectedTaskReviewOutcomeRouteCandidate::NoReviewDecision => "no_review_decision",
    }
}

pub(super) fn rework_status_label(status: SelectedTaskReworkPreparationStatus) -> &'static str {
    match status {
        SelectedTaskReworkPreparationStatus::Admitted => "admitted",
        SelectedTaskReworkPreparationStatus::Refused => "refused",
    }
}

pub(super) fn completion_status_label(
    status: SelectedTaskCompletionRouteApplyStatus,
) -> &'static str {
    match status {
        SelectedTaskCompletionRouteApplyStatus::Admitted => "admitted",
        SelectedTaskCompletionRouteApplyStatus::Refused => "refused",
    }
}

pub(super) fn scm_state_label(state: SelectedTaskScmHandoffState) -> &'static str {
    match state {
        SelectedTaskScmHandoffState::Missing => "missing",
        SelectedTaskScmHandoffState::Blocked => "blocked",
        SelectedTaskScmHandoffState::EvidenceReady => "evidence_ready",
        SelectedTaskScmHandoffState::PrepReady => "prep_ready",
        SelectedTaskScmHandoffState::PublicationPending => "publication_pending",
        SelectedTaskScmHandoffState::Represented => "represented",
        SelectedTaskScmHandoffState::RepairRequired => "repair_required",
    }
}

pub(super) fn scm_next_category_label(category: SelectedTaskScmHandoffNextCategory) -> &'static str {
    match category {
        SelectedTaskScmHandoffNextCategory::InspectEvidence => "inspect_evidence",
        SelectedTaskScmHandoffNextCategory::PrepareChangeRequest => "prepare_change_request",
        SelectedTaskScmHandoffNextCategory::ReviewPreparation => "review_preparation",
        SelectedTaskScmHandoffNextCategory::PublishHandoff => "publish_handoff",
        SelectedTaskScmHandoffNextCategory::Repair => "repair",
        SelectedTaskScmHandoffNextCategory::Wait => "wait",
        SelectedTaskScmHandoffNextCategory::PlanningAmbiguity => "planning_ambiguity",
    }
}

pub(super) fn target_shape_label(shape: SelectedTaskScmHandoffTargetShape) -> &'static str {
    match shape {
        SelectedTaskScmHandoffTargetShape::ForgeReview => "forge_review",
        SelectedTaskScmHandoffTargetShape::ProviderPublication => "provider_publication",
        SelectedTaskScmHandoffTargetShape::ProviderGate => "provider_gate",
        SelectedTaskScmHandoffTargetShape::DirectAuthorityUpdate => "direct_authority_update",
        SelectedTaskScmHandoffTargetShape::ManualHandoff => "manual_handoff",
        SelectedTaskScmHandoffTargetShape::CustomProviderValue => "custom_provider_value",
        SelectedTaskScmHandoffTargetShape::Unknown => "unknown",
    }
}

pub(super) fn source_label(source: SelectedTaskProductSource) -> &'static str {
    match source {
        SelectedTaskProductSource::Drilldown => "drilldown",
        SelectedTaskProductSource::ActionReadiness => "action_readiness",
        SelectedTaskProductSource::OperatorGate => "operator_gate",
        SelectedTaskProductSource::CommandAdmissions => "command_admissions",
        SelectedTaskProductSource::ReviewNext => "review_next",
        SelectedTaskProductSource::ReviewOutcomeRoute => "review_outcome_route",
        SelectedTaskProductSource::RouteAdmission => "route_admission",
        SelectedTaskProductSource::CompletionApply => "completion_apply",
        SelectedTaskProductSource::ReworkPreparation => "rework_preparation",
        SelectedTaskProductSource::ScmHandoff => "scm_handoff",
    }
}

pub(super) fn source_state_label(state: SelectedTaskProductSourceState) -> &'static str {
    match state {
        SelectedTaskProductSourceState::Present => "present",
        SelectedTaskProductSourceState::Missing => "missing",
        SelectedTaskProductSourceState::Partial => "partial",
    }
}
