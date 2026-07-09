use serde::{Deserialize, Serialize};

use crate::{
    SelectedTaskActionFamily, SelectedTaskActionStatus, SelectedTaskCommandAdmissionStatus,
    SelectedTaskCompletionRouteApplyStatus, SelectedTaskProductAggregate,
    SelectedTaskProductBlocker, SelectedTaskProductCommandPreview,
    SelectedTaskProductCommandPreviews, SelectedTaskProductCompletion, SelectedTaskProductGap,
    SelectedTaskProductIdentity, SelectedTaskProductReadiness, SelectedTaskProductReview,
    SelectedTaskProductRework, SelectedTaskProductScmHandoff, SelectedTaskProductSource,
    SelectedTaskProductSourceHealth, SelectedTaskProductSourceState,
    SelectedTaskProductSourceStatus, SelectedTaskProductUnavailableAction,
    SelectedTaskProductWorkEvidence, SelectedTaskProductWorkflow, SelectedTaskReviewNextCategory,
    SelectedTaskReviewOutcomeRouteCandidate, SelectedTaskReviewOutcomeRouteStatus,
    SelectedTaskReviewState, SelectedTaskReworkPreparationStatus,
    SelectedTaskScmHandoffNextCategory, SelectedTaskScmHandoffState,
    SelectedTaskScmHandoffTargetShape,
};

use super::task_workflow_drilldown::ControlTaskWorkflowNoEffectsDto;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductAggregateDto {
    pub aggregate_id: String,
    pub project_id: String,
    pub task_id: String,
    pub identity: ControlSelectedTaskProductIdentityDto,
    pub workflow: ControlSelectedTaskProductWorkflowDto,
    pub readiness: ControlSelectedTaskProductReadinessDto,
    pub command_previews: ControlSelectedTaskProductCommandPreviewsDto,
    pub work_evidence: ControlSelectedTaskProductWorkEvidenceDto,
    pub review: ControlSelectedTaskProductReviewDto,
    pub rework: ControlSelectedTaskProductReworkDto,
    pub completion: ControlSelectedTaskProductCompletionDto,
    pub scm_handoff: ControlSelectedTaskProductScmHandoffDto,
    pub source_health: ControlSelectedTaskProductSourceHealthDto,
    pub gaps: Vec<ControlSelectedTaskProductGapDto>,
    pub no_effects: ControlTaskWorkflowNoEffectsDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductIdentityDto {
    pub title: Option<String>,
    pub activity: Option<String>,
    pub assignment: Option<String>,
    pub action_type: Option<String>,
    pub expected_revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductWorkflowDto {
    pub primary_next_action: String,
    pub reason: String,
    pub phase: String,
    pub next_ref: Option<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductReadinessDto {
    pub blockers: Vec<ControlSelectedTaskProductBlockerDto>,
    pub unavailable_actions: Vec<ControlSelectedTaskProductUnavailableActionDto>,
    pub allowed_action_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductBlockerDto {
    pub family: String,
    pub reason: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductUnavailableActionDto {
    pub family: String,
    pub status: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductCommandPreviewsDto {
    pub admitted_count: usize,
    pub refused_count: usize,
    pub previews: Vec<ControlSelectedTaskProductCommandPreviewDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductCommandPreviewDto {
    pub family: String,
    pub status: String,
    pub command_available: bool,
    pub refusal_reason: Option<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductWorkEvidenceDto {
    pub work_item_refs: Vec<String>,
    pub active_work_item_count: usize,
    pub completed_work_item_count: usize,
    pub evidence_refs: Vec<String>,
    pub timeline_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductReviewDto {
    pub state: Option<String>,
    pub next_category: Option<String>,
    pub route_status: Option<String>,
    pub primary_route: Option<String>,
    pub decision_ref: Option<String>,
    pub decision_available: bool,
    pub blocker_reasons: Vec<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductReworkDto {
    pub status: Option<String>,
    pub summary: Option<String>,
    pub refusal_reason: Option<String>,
    pub reviewed_work_item_refs: Vec<String>,
    pub reviewed_evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductCompletionDto {
    pub status: Option<String>,
    pub command_available: bool,
    pub refusal_reason: Option<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductScmHandoffDto {
    pub state: Option<String>,
    pub next_category: Option<String>,
    pub target_shape: Option<String>,
    pub blocker_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub gap_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductSourceHealthDto {
    pub sources: Vec<ControlSelectedTaskProductSourceStatusDto>,
    pub missing_count: usize,
    pub partial_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductSourceStatusDto {
    pub source: String,
    pub state: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlSelectedTaskProductGapDto {
    pub source: String,
    pub reason: String,
}

impl From<&SelectedTaskProductAggregate> for ControlSelectedTaskProductAggregateDto {
    fn from(aggregate: &SelectedTaskProductAggregate) -> Self {
        Self {
            aggregate_id: aggregate.aggregate_id.clone(),
            project_id: aggregate.project_id.0.clone(),
            task_id: aggregate.task_id.0.clone(),
            identity: ControlSelectedTaskProductIdentityDto::from(&aggregate.identity),
            workflow: ControlSelectedTaskProductWorkflowDto::from(&aggregate.workflow),
            readiness: ControlSelectedTaskProductReadinessDto::from(&aggregate.readiness),
            command_previews: ControlSelectedTaskProductCommandPreviewsDto::from(
                &aggregate.command_previews,
            ),
            work_evidence: ControlSelectedTaskProductWorkEvidenceDto::from(
                &aggregate.work_evidence,
            ),
            review: ControlSelectedTaskProductReviewDto::from(&aggregate.review),
            rework: ControlSelectedTaskProductReworkDto::from(&aggregate.rework),
            completion: ControlSelectedTaskProductCompletionDto::from(&aggregate.completion),
            scm_handoff: ControlSelectedTaskProductScmHandoffDto::from(&aggregate.scm_handoff),
            source_health: ControlSelectedTaskProductSourceHealthDto::from(
                &aggregate.source_health,
            ),
            gaps: aggregate
                .gaps
                .iter()
                .map(ControlSelectedTaskProductGapDto::from)
                .collect(),
            no_effects: ControlTaskWorkflowNoEffectsDto::from(&aggregate.no_effects),
        }
    }
}

impl From<&SelectedTaskProductIdentity> for ControlSelectedTaskProductIdentityDto {
    fn from(identity: &SelectedTaskProductIdentity) -> Self {
        Self {
            title: identity.title.clone(),
            activity: identity.activity.clone(),
            assignment: identity.assignment.clone(),
            action_type: identity.action_type.clone(),
            expected_revision: identity
                .expected_revision
                .as_ref()
                .map(|revision| revision.0.clone()),
        }
    }
}

impl From<&SelectedTaskProductWorkflow> for ControlSelectedTaskProductWorkflowDto {
    fn from(workflow: &SelectedTaskProductWorkflow) -> Self {
        Self {
            primary_next_action: workflow.primary_next_action.clone(),
            reason: workflow.reason.clone(),
            phase: workflow.phase.clone(),
            next_ref: workflow.next_ref.clone(),
            blocked_reason: workflow.blocked_reason.clone(),
        }
    }
}

impl From<&SelectedTaskProductReadiness> for ControlSelectedTaskProductReadinessDto {
    fn from(readiness: &SelectedTaskProductReadiness) -> Self {
        Self {
            blockers: readiness
                .blockers
                .iter()
                .map(ControlSelectedTaskProductBlockerDto::from)
                .collect(),
            unavailable_actions: readiness
                .unavailable_actions
                .iter()
                .map(ControlSelectedTaskProductUnavailableActionDto::from)
                .collect(),
            allowed_action_count: readiness.allowed_action_count,
        }
    }
}

impl From<&SelectedTaskProductBlocker> for ControlSelectedTaskProductBlockerDto {
    fn from(blocker: &SelectedTaskProductBlocker) -> Self {
        Self {
            family: action_family_label(blocker.family).to_owned(),
            reason: blocker.reason.clone(),
            evidence_refs: blocker.evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskProductUnavailableAction>
    for ControlSelectedTaskProductUnavailableActionDto
{
    fn from(action: &SelectedTaskProductUnavailableAction) -> Self {
        Self {
            family: action_family_label(action.family).to_owned(),
            status: action_status_label(action.status).to_owned(),
            reason: action.reason.clone(),
        }
    }
}

impl From<&SelectedTaskProductCommandPreviews> for ControlSelectedTaskProductCommandPreviewsDto {
    fn from(previews: &SelectedTaskProductCommandPreviews) -> Self {
        Self {
            admitted_count: previews.admitted_count,
            refused_count: previews.refused_count,
            previews: previews
                .previews
                .iter()
                .map(ControlSelectedTaskProductCommandPreviewDto::from)
                .collect(),
        }
    }
}

impl From<&SelectedTaskProductCommandPreview> for ControlSelectedTaskProductCommandPreviewDto {
    fn from(preview: &SelectedTaskProductCommandPreview) -> Self {
        Self {
            family: action_family_label(preview.family).to_owned(),
            status: command_admission_status_label(preview.status).to_owned(),
            command_available: preview.command_available,
            refusal_reason: preview.refusal_reason.clone(),
            evidence_refs: preview.evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskProductWorkEvidence> for ControlSelectedTaskProductWorkEvidenceDto {
    fn from(evidence: &SelectedTaskProductWorkEvidence) -> Self {
        Self {
            work_item_refs: evidence.work_item_refs.clone(),
            active_work_item_count: evidence.active_work_item_count,
            completed_work_item_count: evidence.completed_work_item_count,
            evidence_refs: evidence.evidence_refs.clone(),
            timeline_refs: evidence.timeline_refs.clone(),
        }
    }
}

impl From<&SelectedTaskProductReview> for ControlSelectedTaskProductReviewDto {
    fn from(review: &SelectedTaskProductReview) -> Self {
        Self {
            state: review.state.map(review_state_label).map(str::to_owned),
            next_category: review
                .next_category
                .map(review_next_category_label)
                .map(str::to_owned),
            route_status: review
                .route_status
                .map(route_status_label)
                .map(str::to_owned),
            primary_route: review
                .primary_route
                .map(route_candidate_label)
                .map(str::to_owned),
            decision_ref: review.decision_ref.clone(),
            decision_available: review.decision_available,
            blocker_reasons: review.blocker_reasons.clone(),
            evidence_refs: review.evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskProductRework> for ControlSelectedTaskProductReworkDto {
    fn from(rework: &SelectedTaskProductRework) -> Self {
        Self {
            status: rework.status.map(rework_status_label).map(str::to_owned),
            summary: rework.summary.clone(),
            refusal_reason: rework.refusal_reason.clone(),
            reviewed_work_item_refs: rework.reviewed_work_item_refs.clone(),
            reviewed_evidence_refs: rework.reviewed_evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskProductCompletion> for ControlSelectedTaskProductCompletionDto {
    fn from(completion: &SelectedTaskProductCompletion) -> Self {
        Self {
            status: completion
                .status
                .map(completion_status_label)
                .map(str::to_owned),
            command_available: completion.command_available,
            refusal_reason: completion.refusal_reason.clone(),
            evidence_refs: completion.evidence_refs.clone(),
        }
    }
}

impl From<&SelectedTaskProductScmHandoff> for ControlSelectedTaskProductScmHandoffDto {
    fn from(handoff: &SelectedTaskProductScmHandoff) -> Self {
        Self {
            state: handoff.state.map(scm_state_label).map(str::to_owned),
            next_category: handoff
                .next_category
                .map(scm_next_category_label)
                .map(str::to_owned),
            target_shape: handoff
                .target_shape
                .map(target_shape_label)
                .map(str::to_owned),
            blocker_refs: handoff.blocker_refs.clone(),
            evidence_refs: handoff.evidence_refs.clone(),
            gap_count: handoff.gap_count,
        }
    }
}

impl From<&SelectedTaskProductSourceHealth> for ControlSelectedTaskProductSourceHealthDto {
    fn from(health: &SelectedTaskProductSourceHealth) -> Self {
        Self {
            sources: health
                .sources
                .iter()
                .map(ControlSelectedTaskProductSourceStatusDto::from)
                .collect(),
            missing_count: health.missing_count,
            partial_count: health.partial_count,
        }
    }
}

impl From<&SelectedTaskProductSourceStatus> for ControlSelectedTaskProductSourceStatusDto {
    fn from(status: &SelectedTaskProductSourceStatus) -> Self {
        Self {
            source: source_label(status.source).to_owned(),
            state: source_state_label(status.state).to_owned(),
            reason: status.reason.clone(),
        }
    }
}

impl From<&SelectedTaskProductGap> for ControlSelectedTaskProductGapDto {
    fn from(gap: &SelectedTaskProductGap) -> Self {
        Self {
            source: source_label(gap.source).to_owned(),
            reason: gap.reason.clone(),
        }
    }
}

fn action_family_label(family: SelectedTaskActionFamily) -> &'static str {
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

fn action_status_label(status: SelectedTaskActionStatus) -> &'static str {
    match status {
        SelectedTaskActionStatus::Allowed => "allowed",
        SelectedTaskActionStatus::Blocked => "blocked",
        SelectedTaskActionStatus::NotApplicable => "not_applicable",
        SelectedTaskActionStatus::DifferentLane => "different_lane",
    }
}

fn command_admission_status_label(status: SelectedTaskCommandAdmissionStatus) -> &'static str {
    match status {
        SelectedTaskCommandAdmissionStatus::Admitted => "admitted",
        SelectedTaskCommandAdmissionStatus::Refused => "refused",
    }
}

fn review_state_label(state: SelectedTaskReviewState) -> &'static str {
    match state {
        SelectedTaskReviewState::NotReady => "not_ready",
        SelectedTaskReviewState::AwaitingReview => "awaiting_review",
        SelectedTaskReviewState::Accepted => "accepted",
        SelectedTaskReviewState::Rejected => "rejected",
        SelectedTaskReviewState::NeedsChanges => "needs_changes",
        SelectedTaskReviewState::Abandoned => "abandoned",
    }
}

fn review_next_category_label(category: SelectedTaskReviewNextCategory) -> &'static str {
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

fn route_status_label(status: SelectedTaskReviewOutcomeRouteStatus) -> &'static str {
    match status {
        SelectedTaskReviewOutcomeRouteStatus::Ready => "ready",
        SelectedTaskReviewOutcomeRouteStatus::Blocked => "blocked",
        SelectedTaskReviewOutcomeRouteStatus::Stale => "stale",
        SelectedTaskReviewOutcomeRouteStatus::Missing => "missing",
    }
}

fn route_candidate_label(candidate: SelectedTaskReviewOutcomeRouteCandidate) -> &'static str {
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

fn rework_status_label(status: SelectedTaskReworkPreparationStatus) -> &'static str {
    match status {
        SelectedTaskReworkPreparationStatus::Admitted => "admitted",
        SelectedTaskReworkPreparationStatus::Refused => "refused",
    }
}

fn completion_status_label(status: SelectedTaskCompletionRouteApplyStatus) -> &'static str {
    match status {
        SelectedTaskCompletionRouteApplyStatus::Admitted => "admitted",
        SelectedTaskCompletionRouteApplyStatus::Refused => "refused",
    }
}

fn scm_state_label(state: SelectedTaskScmHandoffState) -> &'static str {
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

fn scm_next_category_label(category: SelectedTaskScmHandoffNextCategory) -> &'static str {
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

fn target_shape_label(shape: SelectedTaskScmHandoffTargetShape) -> &'static str {
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

fn source_label(source: SelectedTaskProductSource) -> &'static str {
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

fn source_state_label(state: SelectedTaskProductSourceState) -> &'static str {
    match state {
        SelectedTaskProductSourceState::Present => "present",
        SelectedTaskProductSourceState::Missing => "missing",
        SelectedTaskProductSourceState::Partial => "partial",
    }
}
